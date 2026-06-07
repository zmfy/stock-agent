# 选股聊天化 + 历史回溯 + 入选原因 + 操作按钮转圈

日期：2026-06-07

## Context（背景）

「按核心原则选股」现在的结果 + 讨论显示在右侧操作框的内联折叠面板里，和早会/晚会那种聊天框体验不一致。用户希望：
- 选股结果 + 讨论做成**聊天框**（像早/晚会），且是**单一窗口**（点几次都进同一个），可在里面向来财**追问**。
- 选股要有**历史日志**可回溯：什么时候选的、选中哪些股票、**每只入选股选中的原因**（确定性门槛摘要）。
- 所有耗时操作按钮点击后立即显示**转圈 loading**，避免用户以为卡死。

## Goals
- 选股结果/讨论 = 单一 `screen` 聊天会话，支持追问（prompt 锚定最近一次选股）。
- 每只入选股记录确定性「入选原因」（通过了哪些硬门槛）。
- 选股聊天窗内可折叠查看「历史选股记录」（时间 + 入选股 + 原因），可回溯、点股票开个股聊天。
- 生成早会/晚会/选股/让 agent 提议修改规则 等按钮点击即转圈 + 禁用至完成。

## Non-goals
- 不改选股算法（仍是确定性 evaluateGates 严格 PASS）；入选原因不调 AI（用门槛摘要）。
- 不新增顶栏 tab（历史放在选股聊天窗内）。

## 设计

### 后端
1. **`screen` ChatKind**（`backend/src/chat/service.ts`）
   - `ChatKind` 加 `'screen'`；`KIND_FRAMING.screen = '按核心原则的选股讨论：解释本次选股结果与依据，回答关于入选/未入选个股的追问；不替用户做买卖决定。'`
   - `buildPrompt`/`postMessage`：`session.kind==='screen'` 且无 extra 时，extra = 最近一次选股摘要：`screen/service.getLatest(userId)` 的 `note` + `discussion` + top 结果（`code 名称 入选/未入选 · reason`，取前 ~12 条）。
   - import `getLatest` from `../screen/service`（确认无 import cycle：screen/service 不 import chat/service）。

2. **入选原因（确定性门槛摘要）**（`backend/src/screen/service.ts`）
   - `ScreenResult` 增字段 `reason: string`。
   - `screenCode` 用 `evaluateGates` 的逐条 pass/fail：入选（严格 PASS 所有否决门槛）→ `reason = '通过 ' + 各系统通过的门槛 label 列表`（如「通过 A 系统：ROE≥10、PE<60、PB<5、PS<8、ma20>ma60」）；未入选 → `reason = '未入选：' + 被否决/未过的门槛`（如「ROE 1.28 未达 ≥10」）。数据缺失门槛标注「数据缺失」。
   - `runScreen` 存 `screenings.results`（已是 JSON）时带上每条 `reason`。

3. **历史**（`backend/src/routes/screen.ts` + `screen/service.ts`）
   - `screenings` 表已按次存（id, user_id, source_note, results JSON, discussion, created_at）。
   - 加 `getHistory(userId, limit=20)`：返回最近 N 次 `{ created_at, note, picks: [{code,name,reason}] }`（picks = results 里入选的那部分）。
   - 路由 `GET /api/screen/history?limit=`。

### 前端
1. **runScreen 改为开聊天会话**（`HomeView.vue`）
   - `runScreen()`：`await screenApi.run({})` → `await openScreen()`；不再设 `screenOpen`/内联面板。
   - `openScreen()`：找/建 `kind==='screen'` 会话（复用单一），`open(s)`。
   - `screen` ref 持有最近一次结果（run 返回或 `screenApi.latest()`）。
2. **screen 会话主区**
   - `briefing` computed 加 `screen` 分支：`active.kind==='screen'` → 显示选股纪要（note + discussion）。
   - briefing 下方渲染**结果列表**（复用「box 下挂列表」样式）：每条 A/B 徽标 + 名称代码 + `reason`，点击 → `openStockCode(code)`。
   - **顶部可折叠「历史选股记录」**：`screenApi.history()` → 每次：`时间` + 入选股（`名称 · reason`），点股票 → `openStockCode`。默认折叠。
3. **移除 ops-side 内联 `.screen-list` 面板**；保留「按核心原则选股」按钮（点 = runScreen → 打开 screen 聊天）。
4. **转圈 loading**
   - 加全局/scoped `.spinner`（CSS 旋转小圆环）。
   - `生成早会`(`genning==='morning'`)、`生成晚会`(`genning==='evening'`)、`按核心原则选股`(`screening`)、`让 agent 提议修改规则`(`proposing`) 按钮：loading 时 `:disabled` + 按钮内显示 `<span class="spinner">` 替代/伴随原 `…` 文本。

### 前端 api（`frontend/src/api/screen.ts`）
- `history: (limit=20) => api.get('/screen/history?limit='+limit).then(r => r.data.data as Array<{ created_at: string; note: string; picks: Array<{ code: string; name: string; reason: string }> }>)`
- `ScreenResult`/`ScreenRun` 增 `reason?: string`。

## Testing
- 后端：`screenCode` 入选/未入选 reason 文案（注入门槛 + snapshot mock）；`buildPrompt` kind='screen' 注入 getLatest 摘要；`GET /api/screen/history` 返回结构（含 picks reason）。
- 前端：vue-tsc + 冒烟（选股进单一聊天窗、结果列表带原因可点开个股、历史折叠可回溯、四个按钮转圈）。
- 全套测试保持绿。

## 默认决定（已确认 / 可改）
- screen 单一会话复用（点几次都进同一个，展示最近一次；重跑更新结果、不清空已有追问）。
- 入选原因 = 确定性门槛摘要（不调 AI）。
- 历史在选股聊天窗内（不新增顶栏 tab）。
- 转圈覆盖：生成早会/晚会、选股、让 agent 提议修改规则。
