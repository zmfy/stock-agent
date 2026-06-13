# 聊天泡泡显示重构 Design

> 问题：AI 发言泡泡常把铺垫显示在前、把结论藏进「详细」里，看着没意义。本次让泡泡显示**重点/结论**、全文进弹层；并把所有泡泡里的**个股**变成可点链接进入个股聊天室。

最后更新：2026-06-13。仓库：`github.com/zmfy/stock-agent`。

## 背景（现状）

- `ClampText.vue` 已存在：CSS 裁剪到 3 行，超出时旁边出「详细 ›」按钮，`@detail` → `MarkdownModal` 弹层显示全文。痛点是**裁剪取的是前 3 行（常为铺垫），结论被埋**。
- `daily`（操盘和复盘）策略内容是**单次 AI 调用**生成（无子 agent），分阶段（预判/盘中/复盘/休市）。
- `screen`（选股讨论）的 `discussion` 仍是多 agent 串：`【数据员】…【分析师】…———\n🧠 来财推荐：…`；入选清单 `screenPicks` 已可点 → `openStockCode`。
- `core_principle`（策略探讨）的 `buildCpBriefing(rb)` 已含版本号、人设、门槛块，以及引导语「你想优化哪一方面？…点下方『🛠 让 agent 提议修改规则』…」。
- `openStockCode(code)` 已存在：复用/新建该代码的个股会话并打开。当前仅接在显式清单行上，**未接到泡泡正文内的个股提及**。
- 个股库表 `stock_names(code PRIMARY KEY, name, py, industry, …)`，全量 A 股（约 5000+ 行）；已有 `GET /api/data/stocks/search?q=`、`svc.searchStocks`。

## 架构：两个共享前端单元 + 后端两点配合

### A. `splitConclusion(content)` 纯函数 — `frontend/src/utils/conclusion.ts`

返回 `{ summary: string; full: string; hasSummary: boolean }`，按标记切分：

1. 首个非空行匹配 `/^\s*结论[:：]/` → `summary` = 去掉「结论：」前缀后的该行内容；`full` = 原文；`hasSummary=true`。
2. 否则原文含 `🧠 来财推荐：` 或 `🧠 来财综合研判：` → `summary` = 该标记之后到结尾的整段（trim）；`full` = 原文；`hasSummary=true`。
3. 都不满足 → `hasSummary=false`，`summary=''`，`full=content`（调用方回退到 ClampText 的 3 行裁剪）。

纯函数，无副作用，便于核对。

### B. `<StockText>` 组件 — `frontend/src/components/StockText.vue`

替代「裸文本 + ClampText」的渲染点，统一负责**个股 chip 化 + 裁剪**。

- props：`text: string`、`clamp?: boolean`（默认 `true`）、`lines?: number`（默认 3）。emit：`(e:'detail', text:string)`。
- 渲染：把 `text` 经 `useStockLinkify().tokenize(text)` 切成 `segments`（`{type:'text', s}` | `{type:'stock', code, name}`）。文本段原样输出（`white-space: pre-wrap`）；个股段渲染为 `<button class="stock-chip">{{ name }} {{ code }}</button>`，点击调用注入的 `openStock(code)`。
- chip 触发：HomeView `provide('openStock', openStockCode)`；StockText `inject('openStock')`。注入缺省为 no-op，组件可独立渲染。
- 裁剪：`clamp=true` 时沿用 3 行（`-webkit-line-clamp`）+「详细 ›」（emit `detail`，全文 `text`）。`clamp=false` 时全显、不出按钮。
- 注意：`-webkit-line-clamp` 作用于块级文本，chip 为 inline 元素混排在内可被一同裁剪；详细弹层用现有 `MarkdownModal`（显示**纯全文**，弹层内不强制 chip 化，避免复杂度——见「范围外」）。

### C. 个股识别（前端字典，仅本地匹配）

- 新增 `GET /api/data/stocks/dict` → `{ version: string, items: [string, string][] }`：`items` = `[[code, name], …]` 取自 `stock_names`（仅 `name` 非空）。`version` = `${行数}:${MAX(fetched_at)}`，用于缓存失效。`backend/src/data/service.ts` 加 `getStockDict(): {version, items}`；`routes/data.ts` 加该 GET（`authMiddleware`，无需 admin）。
- 前端 `frontend/src/composables/useStockLinkify.ts`：
  - 启动/首用时 `GET /stocks/dict`；按 `version` 存 `localStorage`（key `sa_stock_dict`），命中则不重新拉。
  - 构建匹配器：`codeToName: Map<code,name>`、`nameToCode: Map<name,code>`；股名按**长度降序**排成扫描序列。
  - `tokenize(text)`：单次左到右扫描——
    - 优先匹配 6 位代码：正则 `/(?:sh|sz|bj)?\s*(\d{6})\b/i`，命中且 `codeToName` 有该 code → stock 段（name 缺失则 chip 仅显示 code）。
    - 否则在当前位置尝试**最长优先**的股名匹配（仅匹配长度 ≥ 2 的名）；命中 → stock 段。
    - 否则推进一个字符并累积到 text 段。
  - **防误识**：股名最短 2 字；最长优先；一份小停用词集合 `STOCK_NAME_STOPLIST`（前端常量，初始可空/极小，后续可调），命中停用词的名不 chip 化。
  - 接受漏识：仅本地字典、不联网补全；个别只报名不在库/被停用词挡掉的提及不链接，可接受。

### D. 后端标记结论

- `backend/src/strategy/generate.ts`：`prejudgePrompt/intradayPrompt/reviewPrompt/holidayPrompt` 四个 prompt 各加要求：**首行先输出一行 `结论：<一句话，≤40字>`，随后再给全文**。不改 `recordStrategy` 落库结构（仍存整段，首行即结论）。
- `backend/src/screen/service.ts`：`discussScreen` 的来财段已以 `🧠 来财推荐：` 为锚点，保留即可（`splitConclusion` 规则 2 命中）。
- 旧内容（无 `结论：` 标记）：`splitConclusion` 回退裁剪，不报错。

### E. 各房间渲染（`frontend/src/views/HomeView.vue`）

1. **core_principle（策略探讨）**：把现 `briefing` 长文 ClampText 改为结构化头：
   - 有策略：`📜 {version_label} · 最后更换 {fmtCN(rb.version.created_at)}` + `[详细 ›]`（→ MarkdownModal 显示完整人设/门槛全文，即原 `buildCpBriefing` 主体），其下保留引导语段（「你想优化哪一方面？… 点下方『🛠 让 agent 提议修改规则』…」）始终可见。
   - 无策略（`needsInit`）：泡泡直接显示访谈引导语（沿用 `CORE_PRINCIPLE_INTERVIEW_FRAMING` 同义文案）。
2. **daily（操盘和复盘）**：每阶段块（休市/预判/盘中各条/复盘）：`const {summary, full, hasSummary} = splitConclusion(content)`。
   - `hasSummary`：渲染 `<StockText :text="summary" :clamp="false" />`（结论已短、仍 linkify）+ 独立 `[详细 ›]` 按钮 → `MarkdownModal(full)`。
   - 否则：`<StockText :text="content" @detail="openDetail" />`（3 行裁剪，详细开 content）。
   - 盘中时间线逐条同理。
3. **screen（选股讨论）**：入选清单 / 「本次无入选个股」照常（已可点 `openStockCode`）；讨论纪要泡泡 `splitConclusion(discussion)` → `hasSummary` 时显示 `summary`（来财推荐结论，StockText clamp=false）+ `[详细 ›]` → 全过程全文（数据员/分析师/来财），否则回退裁剪。
4. **stock（个股讨论）**：消息泡泡 `<StockText :text="m.content" :clamp="false" />` 全显、linkify。
5. **general 及全部消息泡泡**：`<StockText :text="m.content" @detail="openDetail" />`（clamp=true），linkify + 裁剪。

## 数据流

后端生成（结论标记） → 落 `daily_strategy`/`screenings` → 房间渲染时 `splitConclusion` 切出结论作泡泡、全文进弹层 → `StockText` 经 `useStockLinkify` 把代码/股名渲染为 chip → 点击 `openStock(code)` → `openStockCode` 进个股房间。字典 `GET /stocks/dict` 首用拉取、localStorage 按 version 缓存。

## 错误处理 / 边界

- 字典端点失败 / 缓存为空 → `tokenize` 退化为「只识 6 位代码（无名则 chip 显代码）」；名匹配能力缺失但不报错。
- `splitConclusion` 对空串 / 无标记 → `hasSummary=false`，回退裁剪。
- chip 注入缺省 no-op：StockText 在无 provide 的上下文渲染不报错（只是不可点）。
- code 在 `codeToName` 缺失（库未同步到该股）→ chip 仅显代码、仍可点（openStockCode 会兜底建会话并补名）。
- 弹层全文不强制 chip 化（纯文本），避免裁剪/弹层双重渲染复杂度。

## 范围 / 测试

- **后端 jest**：① 四个策略生成器的 prompt 含「首行 `结论：`」要求（`strategy/generate.test.ts` 加断言：mock aiCall 返回带 `结论：` 多行，`getStrategy().content` 首行为结论）；② `screen` 讨论含 `🧠 来财推荐：` 锚点（若无现成断言则补）；③ `GET /api/data/stocks/dict` 返回 `{version, items}`、items 形如 `[code,name]`（`routes/data.test.ts`）。
- **前端无 runner** → `vue-tsc --noEmit` + 走查：策略探讨头(版本+时间+详细+引导语/无策略访谈语)、操盘复盘各阶段显结论+详细全文、选股讨论显来财推荐+详细全过程、个股房全显、任意泡泡内代码/股名变 chip 且点击进个股房。`splitConclusion`/`tokenize` 为纯函数，逻辑以走查核对。

## 不在本次范围

- 不做股名模糊/拼音消歧、不做联网补全个股（仅本地字典，接受个别漏识）。
- 不改分析报告弹层（`ReportModal`）、不改 general 房间除 linkify 外的行为。
- 弹层全文内不二次 chip 化。
- 不改 `daily` 为多 agent（保持单次生成；「详细」即全文，非子 agent 过程）。
