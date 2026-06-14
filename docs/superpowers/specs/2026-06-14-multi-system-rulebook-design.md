# 规则引擎支持多系统（A/B/C…）Design

> 当前规则引擎按「两系统 A/B」设计：保存校验 `z.enum(['A','B'])` 会把第三系统 C 拒绝（`received 'C'`），synthesize 把 C 悄悄并进 A（语义错——C 是零仓位复盘）。本次让引擎支持任意多系统，并区分「真实交易系统」与「零仓位/复盘系统」。

最后更新：2026-06-14。仓库：`github.com/zmfy/stock-agent`。

## 背景（现状）

- **引擎已是多系统**：`analysis/rule-engine.ts` 已用 `[...new Set(gateResults.map(r=>r.system))]` 对**每个不同系统**算 veto 结论；`SeedGate.system` 类型是 `string`（非枚举）。
- **前端展示已动态**：`RulebookView`、`ReportModal`、`AnalysisView` 都用 `systemsOf = [...new Set(gates.map(system))]` 按系统渲染门槛（已能显示 C）。
- **2 系统硬假设集中在**：
  - `routes/rulebook.ts`：`gateSchema`/`softRuleSchema` 的 `system: z.enum(['A','B'])`（保存/apply 校验）→ C 被拒。
  - `rulebook/synthesize-service.ts` `validateSynth`：`a.system === 'B' ? 'B' : 'A'` 把 C 折叠成 A（gates 与 softRules 都折叠）。
  - `rulebook/propose-service.ts`：系统字母透传（`a.system || 'A'`），不折叠 → 到保存被 enum 挡下。
  - `screen/service.ts`：`aPass`/`bPass` 写死只看 A、B；`selected = aPass || bPass`；`ScreenResult` 带 `aPass/bPass`。
  - `analysis/orchestrator.ts`：报告散文结论两槽 `a_conclusion`/`b_conclusion`（门槛级已按系统动态，散文只两槽）。
  - 前端 `api/rulebook.ts` `system: 'A' | 'B'`；`api/screen.ts` `aPass/bPass`；`HomeView` 选股展示用 `aPass/bPass`。
- `positionRules.single_trade_risk_pct` 现为 `{ A: 1.0, B: 0.5 }`（dict）；apply 里 `positionRules: z.record(z.unknown())`（不限 key）。

## 核心判定：交易系统 vs 零仓位系统

**不新增字段**：以 `positionRules.single_trade_risk_pct[sys] > 0` 判定。
- 有仓位风险配置（>0）→ **真实交易系统**（A/B）：进选股、计入敞口、报告主结论。
- 无仓位配置 → **零仓位/复盘系统**（C）：照常评估并展示门槛，但**不进选股、不占敞口**。

新增纯函数 `tradeableSystems(positionRules): string[]` —— 取 `single_trade_risk_pct` 中数值 > 0 的系统键（排序）。放在 `analysis/rule-engine.ts` 或 `rulebook/service.ts`（实现时择一，导出供 screen 用）。

## 后端改动

### A. 校验放宽（`routes/rulebook.ts`）
- `gateSchema.system` 与 `softRuleSchema.system`：`z.enum(['A','B'])` → `z.string().regex(/^[A-Z]$/, '系统须为单个大写字母')`。
- `applySchema` 内若复用同名 schema 则一并生效；若是独立内联定义，同样放宽。
- 影响：apply / 创建版本接受 C（及 D… 任意单字母系统）。

### B. `synthesize-service.ts`
- `validateSynth`：`system` 不再折叠——`const sys = /^[A-Z]$/.test(String(a.system)) ? String(a.system) : 'A'`（gates 与 softRules 同此处理）。
- `buildSynthesizePrompt`：在「系统」说明里改为：系统可为 A/B/C… 任意标签；**给出仓位风险配置的系统=真实交易系统；零仓位/纯复盘系统（如只做认知训练、不下单）不要在 `single_trade_risk_pct` 里配置**。示例 positionRules 仍只给交易系统的风险/上限。

### C. `propose-service.ts`
- 系统字母透传不变（schema 放宽后即可保存 C）。`buildProposePrompt` 同步说明系统可含 C（零仓位则不配仓位风险）。

### D. `screen/service.ts` 泛化
- 取 `tradeable = tradeableSystems(rb.positionRules)`。
- 对每个 `sys ∈ tradeable` 算：该系统的 veto 门槛存在且全部 `pass` → 该系统通过。
- `passedSystems = tradeable.filter(sys 通过)`；`selected = passedSystems.length > 0`。
- 零仓位系统（不在 tradeable）**不参与**选股判定。
- `ScreenResult` 字段：**移除 `aPass`/`bPass`，改为 `passedSystems: string[]`**；`reason` 在入选时标注通过的系统（如「入选（A 系统）」/「入选（A、B）」）。
- `discussScreen` 候选清单文案：`r.passedSystems.length ? r.passedSystems.join('/')+' 通过' : '未过'`。

### E. 报告（`analysis/orchestrator.ts`）— 本次不改结构
- 门槛级已按系统动态展示（含 C）。`a_conclusion`/`b_conclusion` 两槽保留，覆盖主交易系统；C 由门槛级体现。不为 C 增加散文结论槽（范围外）。

## 前端改动

- `api/rulebook.ts`：`system: 'A' | 'B'` → `system: string`（`Gate`、`SoftRule` 等处）。
- `api/screen.ts`：`ScreenResult` 的 `aPass/bPass` → `passedSystems: string[]`。
- `HomeView.vue` 选股展示：`screenPicks = results.filter(r => r.passedSystems.length)`；`<div class="srow">` 的徽章 `r.aPass ? 'A' : 'B'` → `r.passedSystems.join('/')`（badge 类名按是否多系统给中性样式）。历史选股 `sh-pick` 若用 aPass/bPass 同步改。
- `RulebookView`/`ReportModal`/`AnalysisView`：已按系统动态渲染，无需改（验收时确认 C 正常显示）。

## 数据流 / 边界

- 用户聊出/提议含 C 的策略 → 保存校验放宽后通过 → 版本含 A/B/C 门槛。
- 个股分析：`evaluateGates` 对全部门槛求值；报告按系统展示（含 C 的通过/未过）。
- 选股：只跑交易系统（A/B），C 不参与；`passedSystems` 标注。
- 仓位/敞口：现有逻辑按 `single_trade_risk_pct` 的系统计；C 无配置自然不占敞口（无新增敞口代码改动——现状即如此）。
- 兼容旧数据：旧策略只有 A/B，行为不变（tradeable=[A,B]，passedSystems 等价于原 aPass/bPass）。

## 范围 / 测试

- **后端 jest**：
  - apply 接受含 `system:'C'` 的门槛（不再 422）。
  - `validateSynth` 保留 C（不折叠成 A）。
  - `tradeableSystems({single_trade_risk_pct:{A:1,B:0.5,C:0}})` === `['A','B']`；C(0 或缺失)不算。
  - `screen`：构造 A 交易门槛 + C 门槛，passedSystems 只含交易系统；C 不使 selected 成立。
  - 放宽后回归（routes/rulebook、synthesize、propose、screen 测试全绿）。
- **前端**：`vue-tsc --noEmit` + 走查（保存 A/B/C 策略成功；当前策略/报告显示 C；选股只标 A/B、徽章用 passedSystems）。

## 不在本次范围

- 报告散文结论不扩成「每系统一条」（要改 reports 表结构+迁移）。
- 不引入显式的 system「类型」字段（用「是否有仓位配置」判定交易 vs 零仓位）。
- 不改仓位/敞口计算逻辑本身（C 因无配置自然不占敞口）。
