# 「历史分析」聊天室 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第 5 个固定聊天室「历史分析」，把策略历史/分析历史以标题栏按钮搬进房间，聊天复用主 agent「来财」并注入历史摘要。

**Architecture:** 后端加 `history` 固定房间 + `buildHistoryContext` 注入；前端注册房间、两标题按钮开 Modal 复用现有历史视图、设置导航用 `hidden:true` 隐藏两项。复用 core 角色，不新增子 agent。

**Tech Stack:** Express/TS + better-sqlite3 + jest（后端）；Vue 3 + Vite（前端，`vue-tsc --noEmit` 把关）。

Spec：`docs/superpowers/specs/2026-06-13-history-chat-room-design.md`。测试：后端 `cd backend && npm test`（当前 350 绿）；前端 `cd frontend && npx vue-tsc --noEmit`。

> **约定**：仅当用户说「提交」才 commit。各 Task 的 Commit 步骤写好 message 但不执行，攒到放行。

---

## 文件结构

**后端**
- Modify `backend/src/chat/service.ts` — `history` 固定房间 + `buildHistoryContext` + postMessage 注入 + imports。
- Modify `backend/src/routes/chat.ts` — 注释（history 仅 ensure 建）。
- Modify `backend/src/chat/service.test.ts` — 5 房间 ensure + history 注入测试。

**前端**
- Modify `frontend/src/api/chat.ts` — ChatKind += 'history'。
- Modify `frontend/src/views/HomeView.vue` — FIXED_ORDER/图标/sessionLabel、标题按钮、两 Modal、refs、导航 hidden。

---

## Task 1: 后端 `history` 固定房间

**Files:** Modify `backend/src/chat/service.ts`（ChatKind/FIXED_ROOM_KINDS/FIXED_ROOM_TITLES/KIND_FRAMING）、`backend/src/routes/chat.ts`（注释）；Test `backend/src/chat/service.test.ts`。

- [ ] **Step 1: 写失败测试** — 追加到 `backend/src/chat/service.test.ts` 末尾：
```ts
describe('history 固定房间', () => {
  it('ensureFixedRooms 建齐含 历史分析', () => {
    const svcH = require('./service');
    const sessions = svcH.ensureFixedRooms('u-hist5');
    const room = sessions.find((s: any) => s.kind === 'history');
    expect(room).toBeTruthy();
    expect(room.pinned).toBe(1);
    expect(room.title).toBe('历史分析');
    for (const k of ['ai_model', 'core_principle', 'daily', 'screen']) {
      expect(sessions.some((s: any) => s.kind === k)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 确认失败** — `cd backend && npx jest chat/service -i -t "history 固定房间"` → FAIL.

- [ ] **Step 3: 实现** — 改 `backend/src/chat/service.ts`：
  - `ChatKind` 联合类型加 `'history'`。
  - `FIXED_ROOM_KINDS` 加 `'history'`：`['core_principle', 'daily', 'screen', 'ai_model', 'history'] as const satisfies ChatKind[]`（顺序不影响展示）。
  - `FIXED_ROOM_TITLES` 加 `history: '历史分析',`（该 Record 类型按 `FIXED_ROOM_KINDS[number]`，必须加这个键否则 TS 报错）。
  - `KIND_FRAMING` 加（该 Record 类型按 `ChatKind`，必须加否则 TS 报错）：
```ts
  history: '用户在和你回顾历史。结合下方“历史摘要”（最近的策略预判/盘中/复盘记录与个股分析报告），与用户讨论过往策略对错、个股分析结论与经验总结。要看明细可点本房间标题栏的「🗂 策略历史」「📊 分析历史」。基于已有记录作答，不杜撰没发生过的历史。',
```
  - `backend/src/routes/chat.ts`：可创建 `KINDS` 不加 `history`；把那行注释补成「'daily'/'ai_model'/'history' 仅 ensure 建」。无功能改动。

- [ ] **Step 4: 确认通过 + 回归** — `cd backend && npx jest chat/service -i` 然后 `npm test` → 全绿。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/chat/service.ts backend/src/routes/chat.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): 新增第 5 个固定房间 history「历史分析」

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端注入历史摘要

**Files:** Modify `backend/src/chat/service.ts`（imports、新增 `buildHistoryContext`、postMessage history 分支）；Test `backend/src/chat/service.test.ts`。

- [ ] **Step 1: 写失败测试** — 追加到 `backend/src/chat/service.test.ts` 末尾：
```ts
describe('history 房间注入历史摘要', () => {
  it('postMessage 注入「历史摘要」且含最近策略内容', async () => {
    const svcH = require('./service');
    const strat = require('../strategy/service');
    strat.recordStrategy('u-histctx', 'prejudge', '结论：今日偏多关注券商', {}, '2026-06-10');
    const sid = svcH.createSession('u-histctx', 'history', null, '历史分析');
    let captured = '';
    await svcH.postMessage('u-histctx', sid, '上次预判说了啥？', {
      aiCall: async (p: string) => { captured = p; return '上次预判偏多'; },
    });
    expect(captured).toContain('历史摘要');
    expect(captured).toContain('偏多关注券商');
  });
});
```
> `recordStrategy(userId, phase, content, meta, date)` 已存在（strategy/service）。

- [ ] **Step 2: 确认失败** — `cd backend && npx jest chat/service -i -t "history 房间注入"` → FAIL（无「历史摘要」）。

- [ ] **Step 3: 实现** — 改 `backend/src/chat/service.ts`：

① imports：
- `backend/src/chat/service.ts:11` `import { getLatestReportByCode } from '../analysis/report-service';` 改为 `import { getLatestReportByCode, listReports } from '../analysis/report-service';`
- `backend/src/chat/service.ts:16` `import { beijingDate, dailyPhase, getStrategy, getIntradayTimeline } from '../strategy/service';` 改为加 `listStrategyHistory`：`import { beijingDate, dailyPhase, getStrategy, getIntradayTimeline, listStrategyHistory } from '../strategy/service';`

② 新增 `buildHistoryContext`（放在 `buildAiConfigContext` 之后）：
```ts
// 给「历史分析」房间注入最近策略历史 + 个股分析报告摘要，供来财据实回顾。
function buildHistoryContext(userId: string): string {
  const PHASE: Record<string, string> = { prejudge: '预判', intraday: '盘中', review: '复盘', holiday: '休市' };
  const parts: string[] = [];
  try {
    const rows = listStrategyHistory(userId, 8) as Array<{ date: string; phase: string; content: string }>;
    const lines = rows.map((r) => {
      const head = (r.content || '').split('\n').find((l) => l.trim()) || '';
      const snippet = head.length > 40 ? head.slice(0, 40) + '…' : head;
      return `· ${r.date} ${PHASE[r.phase] || r.phase}：${snippet}`;
    });
    parts.push(`最近策略：\n${lines.length ? lines.join('\n') : '（无）'}`);
  } catch { /* 降级 */ }
  try {
    const reps = (listReports(userId) as Array<{ stock_code: string; stock_name: string | null; one_liner: string; created_at: string }>).slice(0, 8);
    const lines = reps.map((r) => `· ${r.stock_name || r.stock_code} ${r.stock_code}：${r.one_liner}（${(r.created_at || '').slice(0, 10)}）`);
    parts.push(`最近个股分析：\n${lines.length ? lines.join('\n') : '（无）'}`);
  } catch { /* 降级 */ }
  const body = parts.join('\n\n');
  return `历史摘要：\n${body || '（暂无历史记录）'}`;
}
```

③ postMessage：在 `if (!extra && session.kind === 'ai_model') { extra = buildAiConfigContext(userId); }`（约 294-296 行）**之后**加：
```ts
  if (!extra && session.kind === 'history') {
    extra = buildHistoryContext(userId);
  }
```
> role 推导无需改：现有 `const role = session.kind === 'ai_model' ? 'ai_helper' : 'core';` 对 history 自动取 core（来财）。

- [ ] **Step 4: 确认通过 + 回归** — `cd backend && npx jest chat/service -i` 然后 `npm test` → 全绿。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/chat/service.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): history 房间注入最近策略历史+分析报告摘要(来财据实回顾)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 前端房间注册 + 标题按钮 + Modal + 导航隐藏

**Files:** Modify `frontend/src/api/chat.ts`、`frontend/src/views/HomeView.vue`。

- [ ] **Step 1: api/chat ChatKind** — `frontend/src/api/chat.ts` 的 `ChatKind` 联合末尾加 `| 'history'`。

- [ ] **Step 2: HomeView 注册** —
  - `FIXED_ORDER`（`const FIXED_ORDER: ChatKind[] = ['ai_model', 'core_principle', 'daily', 'screen'];`）末尾加 `'history'` → `['ai_model', 'core_principle', 'daily', 'screen', 'history']`。
  - 图标 Record（`const icons: Record<ChatKind, string> = { … }`）加 `history: '🗂'`（Record<ChatKind> 必须加键，否则 TS 报错）。
  - `sessionLabel`（连续的 `if (s.kind === 'screen') return '选股讨论';` 等）加 `if (s.kind === 'history') return '历史分析';`。

- [ ] **Step 3: 导航隐藏两项** — `SETTINGS` 数组里给 `strategy_history`、`analysis` 两项加 `hidden: true`（与 `account` 同）：
```ts
  { key: 'strategy_history', label: '策略历史', icon: '🗓', comp: StrategyHistoryView, roles: 'user', hidden: true },
  { key: 'analysis', label: '分析历史', icon: '📊', comp: AnalysisView, roles: 'user', hidden: true },
```
> 用 `grep -n "strategy_history\|key: 'analysis'" HomeView.vue` 定位原两行，原样保留其它字段、仅加 `hidden: true`。

- [ ] **Step 4: 标题按钮** — `title-actions` 内、`🧹 清理` 按钮**之前**（其它 `<template v-if="active.kind === '…'">` 兄弟块旁）加：
```vue
                  <template v-if="active.kind === 'history'">
                    <button class="mini" @click="strategyHistOpen = true">🗂 策略历史</button>
                    <button class="mini" @click="analysisHistOpen = true">📊 分析历史</button>
                  </template>
```

- [ ] **Step 5: 两个 Modal** — 模板末尾、AI 模型/能力插件 Modal 旁加：
```vue
    <Modal v-if="strategyHistOpen" title="策略历史" @close="strategyHistOpen = false"><StrategyHistoryView /></Modal>
    <Modal v-if="analysisHistOpen" title="分析历史" @close="analysisHistOpen = false"><AnalysisView /></Modal>
```

- [ ] **Step 6: refs** — `<script setup>` 内（`aiModelModalOpen` ref 旁）加：
```ts
const strategyHistOpen = ref(false);
const analysisHistOpen = ref(false);
```
> `StrategyHistoryView`、`AnalysisView` 已 import（现为 SETTINGS comp）；勿重复 import。

- [ ] **Step 7: 类型检查** — `cd frontend && npx vue-tsc --noEmit` → exit 0。

- [ ] **Step 8: 走查（dev）** — `npm run dev`，普通用户：左侧固定房间末尾多出「历史分析」(🗂、置顶)；标题栏 `🗂 策略历史`/`📊 分析历史`/`🧹 清理`，点开各自 Modal 即原历史页；空房间问历史由来财据注入摘要作答；设置下拉不再有 策略历史/分析历史。

- [ ] **Step 9: Commit（待放行）**
```bash
git add frontend/src/api/chat.ts frontend/src/views/HomeView.vue
git commit -m "feat(home): 历史分析房间(标题按钮 策略历史/分析历史 Modal)+注册;导航隐藏两项

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 端到端验证

1. `cd backend && npm test` → 全绿（350 + 2 新增）。
2. `cd frontend && npx vue-tsc --noEmit` → exit 0。
3. `npm run dev` 走查 Task 3 Step 8。

## 风险 / 注意
- `FIXED_ROOM_TITLES` / `KIND_FRAMING` / 前端 `icons` 都是按 kind 的 Record——加 `history` kind 后这三处必须各补一个键，否则 TS 报错。
- 老用户首次进入由 `ensureFixedRooms` 补建第 5 间。
- `StrategyHistoryView`/`AnalysisView` 原样嵌入 Modal 复用；走查确认显示正常。
- 注入摘要只读历史，不杜撰（framing 已声明）。
