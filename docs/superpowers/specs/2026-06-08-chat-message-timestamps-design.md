# 对话内所有 agent/用户发言显示日期时间

日期：2026-06-08

## Context（背景）

用户希望对话框里 agent 与用户的每条发言都带日期+时间，方便判断信息是否过时。现状：聊天气泡（用户消息 + agent 消息）**已经**显示 `fmtTime(m.created_at)`（日期+时间，`.mtime`）。缺口只在几处「属于发言但不是 message 气泡」的块：早会/晚会/选股的**纪要块**（agent 的研判，最容易过时）没有生成时间；刚发出的乐观临时消息 `created_at:''` 在刷新前不显示时间；规则修改**提议卡片**（agent 的发言）没有时间。

## 现状契约

- `HomeView.vue`：
  - 聊天气泡循环已含 `<div v-if="m.created_at" class="mtime">{{ fmtTime(m.created_at) }}</div>`。`fmtTime(ts)=fmtCN(ts)`（北京日期+时间）。已 `import { fmtCN, fmtCNDate } from '../utils/time'`。
  - `briefing` computed：morning→`meetings.value.morning?.content`、evening→`meetings.value.evening?.content`、screen→`screen.value.note(+discussion)`、core_principle→`buildCpBriefing`。模板 `<div v-if="briefing" class="briefing">{{ briefing }}</div>`。
  - `meetings.value.morning/evening` 为 `Meeting`（含 `created_at`）；`screen.value` 为 `ScreenRun`（含 `created_at`）。
  - `proposal` ref（`ProposeResult|null`，409）；`propose()`（425）在 430 设 `proposal.value=...`；提议卡片在 `<div v-if="proposal" class="msg assistant">` 内。
  - 乐观临时用户消息（704）：`messages.value.push({ id:'tmp', ..., content:text, created_at:'' })`。

## Goals

- 早会/晚会/选股**纪要块**显示生成时间（北京）。
- 规则修改**提议卡片**显示提议时间。
- 刚发出的用户消息**立即**带时间（不必等刷新）。

## Non-goals

- 不动已带时间的聊天气泡、历史选股（已显示）、采用新闻列表（链接型，非发言）。
- 核心原则纪要不加生成时间——它正文已含「最后更换:日期」，那才是其时效信号。
- 纯前端，后端零改。

## 设计（全在 `frontend/src/views/HomeView.vue`）

1. **纪要生成时间** computed：
```ts
const briefingTime = computed<string | null>(() => {
  if (active.value?.kind === 'morning') return meetings.value.morning?.created_at ?? null;
  if (active.value?.kind === 'evening') return meetings.value.evening?.created_at ?? null;
  if (active.value?.kind === 'screen') return screen.value?.created_at ?? null;
  return null;
});
```
模板：在 `<div v-if="briefing" class="briefing">` **之前**插入：
```html
<div v-if="briefing && briefingTime" class="briefing-time muted">🕐 生成于 {{ fmtCN(briefingTime) }}</div>
```
（`briefing` 非空且有时间才显示。）

2. **提议时间**：加 ref `const proposedAt = ref<string>('')`；`propose()` 里设 `proposal.value=...` 之后加 `proposedAt.value = new Date().toISOString()`。提议卡片内（采纳/放弃按钮的 `<div class="ops">` 之前）加：
```html
<p v-if="proposedAt" class="muted">🕐 {{ fmtCN(proposedAt) }}</p>
```

3. **乐观消息即时时间**：把 704 行 `created_at: ''` 改为 `created_at: new Date().toISOString()`（刷新后被服务器值覆盖，一致）。

4. **样式**：`.briefing-time { font-size: 11px; margin: 2px 0 0; }`（`.muted` 已有灰色样式）。

## Testing

- `cd frontend && npx vue-tsc --noEmit` 干净。
- 手动冒烟：开早会/晚会/选股 → 纪要块上方显示「🕐 生成于 …」（北京时间）；发一条消息 → 自己的气泡立刻带时间；进核心原则讨论点「让 agent 提议」→ 提议卡片显示提议时间。
- 后端零改 → Node 测试不受影响（无需重跑，但可 `npm test` 确认）。

## 默认决定（已确认）

- 仅补纪要块/提议卡/乐观消息;聊天气泡、历史、采用新闻不动;核心原则纪要不加(已有「最后更换」)。
- 时间统一走 `fmtCN`(北京日期+时间)。
