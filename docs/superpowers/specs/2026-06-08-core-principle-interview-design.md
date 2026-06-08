# 核心原则访谈合成 + 无原则降级模式 — 设计

> Feature #4(2026-06-08 批次最后一项)。新用户向导 / 更换模板里增加「我还没有核心原则,帮我聊出来」选项;选中后来财通过**引导式访谈**了解用户的选股/操作方法,据此**从零合成一整套核心原则(规则版本)**。同时让无核心原则的用户也能用系统(降级模式)。

日期:2026-06-08。仓库:`github.com/zmfy/stock-agent`。

## 背景与现状

- 现有 `propose-service.proposeChange` = 对**已有** active rulebook 打**增量补丁**(delta),无 rulebook 时抛 `NO_RULEBOOK`。
- 现有入口:`OnboardingView` Step1 强制选一个模板(`rulebookApi.init`);`HomeView` 模板区多选 + 「提议修改」按钮。
- 现有无-rulebook 行为是**硬失败**:`screen/service.runScreen` 抛 `NO_RULEBOOK`;`analysis/orchestrator.runAnalysis` 抛 `NO_RULEBOOK`;`meetings` 的 prompt 硬写「A/B 系统开闸/对照硬门槛」。
- `HomeView` 顶部有一条小黄条 `.initbar`(13px 小字)「还没设定核心原则?去完成初始化设定 →」——不够醒目。

## 核心新增能力

一条「从零访谈 → 合成整套核心原则」的流水线,与现有「补丁式修改」并存:

- **新增** `synthesizeRulebook` = 从**访谈对话**从零生成**整套** rulebook(人设 + 硬门槛 + 软规则 + 仓位),无需已有版本。
- **两种 `core_principle` 聊天模式**,由「当前有没有 rulebook」决定:
  - 无 rulebook → 引导式访谈 + 「生成核心原则」按钮(完整预览 → 存为首版)。
  - 有 rulebook → 现有自由讨论 + 「提议修改」按钮(增量补丁)。

可用数据字段(合成与门槛只能用这些,源自 `StockSnapshot`/模板):
`roe_ttm, pe, pb, ps, net_profit, turnover_rate, ma5, ma10, ma20, ma60, close, year_high, limit_up_count, limit_down_count, sse_ma20_slope`。
可用算子:`>=, >, <=, <, between, gt_field`。系统:`A=个股基本面/趋势`、`B=大盘情绪`。

---

## 1. 入口与流程

### 1.1 新用户向导(`frontend/src/views/OnboardingView.vue`,Step 1)
- 模板列表顶部新增一张卡片:**「🗣 我还没有核心原则,帮我聊出来」**,sentinel key `__interview__`。
- 选中它后 `doTemplate()` **不调用** `rulebookApi.init`(不实例化任何模板),直接 `step.value = 2`。
- 向导照常走完(Step2 配 AI + 主人设、Step3 生成子 agent)。
- `finish()`:当选择的是 `__interview__` 时,跳转 `router.push('/?interview=1')`;否则维持 `router.push('/')`。

### 1.2 落地后自动开启访谈(`frontend/src/views/HomeView.vue`)
- `onMounted` 读取路由 query `interview=1` 且当前无 rulebook(`needsInit`)→ 自动 `openCorePrinciple()`,进入访谈模式。
- 访谈模式开场白由后端给出(见 §2.1),不是现在的「请去系统设置导入模板」。

### 1.3 更换模板区入口(`HomeView.vue` 模板多选格子下方)
- 在格子下方加入口链接:**「或:我还没想好,帮我从聊天聊出一套 →」**。
- 点击 = `openCorePrinciple()` 进入访谈模式;若该 `core_principle` 会话已有历史,先 `clearMessages`(已有 `chatApi`/`POST /chat/sessions/:id/clear` 等价能力,见实现计划)再播种访谈开场。对**已有 rulebook** 的用户同样可用——聊出的新原则采纳后作为新版本替换 active。

### 1.4 居中醒目引导卡(替换 `.initbar`)
- **删除** `HomeView` 顶部 `.initbar` 小黄条(模板 line 54-56)。
- 当 `needsInit`(无 rulebook)且无打开会话(`!active`)时,在**居中的 `.empty` 欢迎区**内、欢迎语下、StockPicker 上方,放一张醒目引导卡:
  - 标题:`🎯 你还没有核心原则`
  - 说明:核心原则是来财帮你选股、判断买卖的依据;现在还不能「按原则选股」,早晚会也只看大盘。
  - **主按钮**(主色调、醒目):`🗣 和来财聊出我的核心原则` → `openCorePrinciple()` 进访谈。
  - **次链接**(小字):`📋 选个模板快速开始 →` → 跳 `/onboarding`。
- 有 rulebook 时该卡不显示,`.empty` 维持原欢迎 + StockPicker。
- 若用户尚未配 AI 模型,点主按钮后访谈首次 AI 调用返回 `NO_MODEL` → 前端捕获,提示「请先在『AI 模型』配置一个模型」并给跳转链接。

---

## 2. 访谈框架 + 合成后端

### 2.1 访谈模式的聊天框架(`backend/src/chat/service.ts`)
- `core_principle` 的 framing 按「有无 active rulebook」分叉:
  - **无 rulebook(访谈模式)** framing:
    > 用户还没有核心原则。你要用**引导式半结构化**提问,一次只问 1–2 个问题,循序渐进地了解:① 看基本面还是技术面(或都看);② 偏好什么股(蓝筹/成长/题材/低估…);③ 持股周期;④ 买入信号;⑤ 卖出/止损习惯;⑥ 单票仓位、能接受的回撤。聊到信息足够时,提示用户点下方「生成核心原则」按钮。不要替用户编造他没说过的偏好。
  - **有 rulebook**:维持现有「探讨核心原则的修改;给出建议但不替用户做决定。」
- `buildCpBriefing`(`HomeView`)/开场:无-rulebook 分支返回一句欢迎 + 第一个引导问题(例:「我们先聊聊你平时怎么选股——你主要看公司基本面(业绩/估值),还是看走势(均线/突破),还是两者都看?」),取代现「请到系统设置导入模板」。

### 2.2 合成服务(新增 `backend/src/rulebook/synthesize-service.ts`)
- 导出 `synthesizeRulebook(userId, sessionId, opts?: { aiCall?: (p:string)=>Promise<string> }): Promise<{ proposal: ProposalPayload, suggestedLabel: string }>`。
- 流程:读访谈对话(`getMessages`)→ `buildSynthesizePrompt(conversation)` → aiCall → `parseSynth(raw)` → 校验 → 返回。
- `buildSynthesizePrompt` 给 AI:
  - **字段白名单**(强约束:只能用这些 `field`):见上「可用数据字段」。
  - **算子白名单** + 系统含义(A/B)。
  - **输出结构**(与 `Baseline` 同构,只输出 JSON):
    ```json
    {
      "versionLabel": "我的原则 v1",
      "persona": "一句话人设",
      "gates": [{"system":"A","gate_key":"唯一key","label":"名称","field":"白名单字段","op":">=|>|<=|<|between|gt_field","threshold":数值或null,"threshold2":null,"ref_field":null,"unit":"","veto":1,"teach":"一句话"}],
      "softRules": [{"system":"A","text":"软判断","teach":"教学"}],
      "positionRules": {"single_trade_risk_pct":{"A":1.0},"single_stock_cap_pct":{"A":20},"exits":{"A":["..."]},"circuit_breaker":["..."]}
    }
    ```
  - 要求:据用户**真实表述**生成,没聊到的维度可留空或给保守默认,不要编造其偏好;只输出 JSON。
- `parseSynth`:截取首个 `{` 到末个 `}` 后 `JSON.parse`(参照 `propose-service.parsePatch`),失败返回 `null`。
- **校验**(参照 propose 的 `VALID_OPS` + 数值规整):
  - `gates`:逐条丢弃 `field` 不在白名单、`op` 非法、`gate_key`/`label` 缺失的项;`system` 仅允许 A/B(缺省 A);`threshold`/`threshold2` 用 `num()` 规整;`veto` 归一为 0/1。
  - 过滤后 `gates.length === 0` → 抛 `Error('SYNTH_EMPTY')`。
  - `softRules`:保留有 `text` 的项;`positionRules`:非对象则置 `{}`。
  - `versionLabel`:取 AI 给的(`String`,截断 ≤40);缺省/空 → `我的原则 v1`。
- 解析失败 → 抛 `Error('PARSE_FAILED')`;无模型 → `Error('NO_MODEL')`(由默认 aiCall 抛)。
- 默认 aiCall 复用 `propose-service.defaultAiCall` 同款(`getModelForRole(userId,'review') || 'core'`,`chat(...,4000)`)。

### 2.3 路由(`backend/src/routes/rulebook.ts`)
- `POST /api/rulebook/synthesize { sessionId }`:
  - 校验 `sessionId: z.string()`。
  - 调 `synthesizeRulebook` → 成功 `successResponse(res, { proposal, suggestedLabel, fromScratch: true })`。
  - 错误:`NO_MODEL`→400「请先在『AI 模型』配置并启用一个可用模型」;`SYNTH_EMPTY`→400「还没聊到足够信息,请再多说说你平时怎么选股、怎么买卖」;`PARSE_FAILED`→502「生成解析失败,请再试一次」;其他→502。
- **采纳复用现有 `POST /api/rulebook/apply`**:`proposal` 经现有 `applySchema` 校验;`applyProposal(parentVersionId 取 active?.version.id ?? null)` 在无 active 时正好创建并激活**首版**,无需新接口。

### 2.4 前端预览(`HomeView.vue` + `frontend/src/api/rulebook.ts`)
- `rulebookApi.synthesize(sessionId)` → `POST /rulebook/synthesize`,返回 `{ proposal, suggestedLabel, fromScratch }`。
- 访谈模式(无 rulebook,或经 §1.3 入口进入)下,右侧显示按钮 **「🛠 根据我们的聊天,帮我生成核心原则」** → 调 synthesize → 存入 `proposal`(带 `fromScratch=true`)。
- 预览区:`fromScratch` 为真时渲染**完整清单**(人设 / A·B 各系统硬门槛逐条 `label + 条件 + 否决标记` / 软规则 / 仓位止损),而非现有 delta 增减视图 → 按钮「采纳并保存为 {suggestedLabel}」→ 调 `rulebookApi.apply(suggestedLabel, proposal.proposal, sessionId)` → 刷新 `activeRulebook` + `needsInit` → 落一条本地消息「✅ 已生成核心原则 {label}」。
- 不满意可继续聊后再次点生成(覆盖 `proposal`)。

---

## 3. 无核心原则时的降级模式

### 3.1 核心原则选股(`screen`)— 禁用 + 友好提示
- 后端 `screen/service.runScreen` 维持抛 `NO_RULEBOOK`。
- 前端 `HomeView.runScreen()`:无 rulebook 时不发请求,直接提示「你还没有核心原则,无法按原则选股。先点『和来财聊出我的核心原则』定一套吧」并提供进入访谈的入口;「🔍 按核心原则选股」按钮可置灰 + `title` 说明。

### 3.2 个股分析(`backend/src/analysis/orchestrator.ts`)— 通用分析兜底
- `runAnalysis`:`getActive` 为空时**不再抛 `NO_RULEBOOK`**,改走 `runGeneralAnalysis(userId, code, opts)`:
  - 仍取 `getStockSnapshot` + `validateStock`(可信度校验不变,失败仍抛 `DATA_UNTRUSTED`)。
  - **不调用** `evaluateGates`。
  - 新 prompt `buildGeneralAnalysisPrompt(persona, snapshot, directives)`:基于基本面(PE/PB/ROE/净利)、当前走势(均线关系/价格相对年内高低)给**通用研判**——基本面好坏、当前趋势、可能走势(基于一般股市常识),并**明确声明「未设核心原则,以下只是通用分析,不构成买卖结论」**。
  - 落库 `saveReport`:`gateResults: []`、`aConclusion/bConclusion: '未设核心原则'`、`rulebookVersionId: null`、其余字段照常。
- `analyzeStockSession`(`chat/service.ts`)因此在无 rulebook 时也正常出通用分析,不再 `NO_RULEBOOK` 失败;`reportContext` 对空 `gate_results` 已优雅(`filter` 后为空,不输出门槛行)。

### 3.3 早会/晚会(`backend/src/meetings/service.ts`)— 只大盘+板块,不点个股
- 给受影响的 prompt builder(`buildMorningAnalysisPrompt`、`buildMorningSynthPrompt`、`buildEveningReviewPrompt`、`buildEveningSynthPrompt`)新增 `hasRulebook: boolean` 参数:
  - **有**:维持现状。
  - **无**:把 rulebook/门槛相关段落替换为指令——「用户尚未设定核心原则。本次**只研判大盘形势与热门/强势板块**,**不要**判断 A/B 系统开闸、**不要**推荐或点名任何个股」。早会仍输出「今日可能走强板块」(板块名,非个股);晚会复盘大盘与板块、不复盘个股操作。
- `runMorning`/`runEvening` 调用处:`const hasRb = !!getActive(userId)` 传入;`rulebookText` 在无 rulebook 时仍返回现「(用户尚未设定核心原则)」,但实际 framing 由 `hasRulebook` 开关主导。

### 3.4 数据兼容
- 确认 `backend/src/db.ts` 中 `reports.rulebook_version_id` 允许 `NULL`;若为 `NOT NULL` 则去掉该约束。无破坏性迁移,存量行不动。

---

## 4. 测试 & 部署

### 后端单测(Node test runner,当前 204 绿,新增不破旧)
- `synthesize-service`:
  - 注入假 aiCall 返回合法整套 JSON → 断言 `proposal` 字段正确、白名单过滤(非法 `field`/`op` 被丢)、`suggestedLabel` 缺省 `我的原则 v1`。
  - 字段全空 / 无合法门槛 → 抛 `SYNTH_EMPTY`;乱码 → `PARSE_FAILED`。
- `apply` 首版:无 active rulebook 时 `applyProposal`(`parentVersionId=null`)创建并激活首个版本。
- `runAnalysis` 降级:无 rulebook + 注入假 aiCall → 不抛 `NO_RULEBOOK`,产出 `gate_results=[]`、`rulebook_version_id=null` 的通用报告。
- 早/晚会 prompt builder `hasRulebook=false`:断言含「不要推荐个股/只研判大盘板块」、不含「A/B 系统开闸」;`hasRulebook=true` 维持原文。
- `runScreen` 无 rulebook 仍抛 `NO_RULEBOOK`(回归)。

### 前端类型检查
- `cd frontend && npx vue-tsc --noEmit` 通过。

### 部署
- `docker compose up -d --build` + 浏览器硬刷新。无新增 sidecar `.py`,不涉及 Dockerfile。

---

## 单元边界(便于实现与测试)
- `synthesize-service.ts`:纯逻辑(`buildSynthesizePrompt`/`parseSynth`/校验)与 `synthesizeRulebook`(编排)分离,纯逻辑可单测、不触网。
- `chat/service.ts`:`core_principle` framing 分叉是局部改动,不影响其他 kind。
- `analysis/orchestrator.ts`:`runGeneralAnalysis` 与 `runAnalysis` 共用 snapshot/validate 取数,仅在「有无门槛」处分叉。
- `meetings/service.ts`:`hasRulebook` 只切换 prompt 文案,不改流水线结构。
- 前端:引导卡 / 访谈按钮 / 完整预览都加在 `HomeView`,复用现有 `propose`/`apply` 通路与样式。
