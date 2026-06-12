# 当天策略引擎 · 阶段⑤ 策略历史 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「早晚会历史」菜单替换为「策略历史」，展示 `daily_strategy`(预判/盘中/复盘/休市快报，按时间倒序、可展开)。收尾整个当天策略引擎。

**Architecture:** 后端加 `listStrategyHistory` + `GET /api/strategy/history`;前端新 `StrategyHistoryView.vue`，`SETTINGS` 菜单项从 MeetingsHistoryView 换成它。

**Tech Stack:** Express/TS + jest + Vue 3。依赖阶段①(`daily_strategy`)。

参照 spec：`docs/superpowers/specs/2026-06-12-daily-strategy-engine-design.md`(G 历史)。

> **范围说明**：旧 meetings 的生成函数/路由/视图(`generateMorning`/`generateEvening`、`routes/meetings`、`MeetingsHistoryView`、`cron/meetings.ts`、`api/meetings`)在本期**不删**——它们已无 cron 触发、菜单入口本期也移除，属无害死码;且 `meetings/service.ts` 还托管着 strategy 复用的助手(`marketText`/`sectorText`/`rulebookText`/`defaultAiCall`/`eligibleUserIds`)，整体删除需先迁助手，风险大收益小。留作可选后续清理(见末尾)。本期只做用户可见的「策略历史」+ 菜单替换。

---

## 文件结构

- Modify `backend/src/strategy/service.ts` — `listStrategyHistory`
- Modify `backend/src/routes/strategy.ts` — `GET /history`
- Modify `backend/src/routes/strategy.test.ts` — 测试
- Modify `frontend/src/api/strategy.ts` — `history` + 类型
- Create `frontend/src/views/StrategyHistoryView.vue`
- Modify `frontend/src/views/HomeView.vue` — SETTINGS 菜单项替换

---

## Task 1: 后端 策略历史（TDD）

**Files:** Modify `backend/src/strategy/service.ts`、`backend/src/routes/strategy.ts`、`backend/src/routes/strategy.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `backend/src/routes/strategy.test.ts`）

```ts
describe('strategy history', () => {
  it('GET /history 返回该用户策略记录(倒序)', async () => {
    // 经 service 写两条(预判+盘中)，再查 history
    const svc = require('../strategy/service');
    // userTok 对应的 userId 未知，这里改用 service 直接对一个 uid 写，再断言结构即可：
    svc.recordStrategy('hist-uid', 'prejudge', '预判A', {}, '2026-06-09');
    svc.recordStrategy('hist-uid', 'intraday', '盘中B', {}, '2026-06-10');
    const rows = svc.listStrategyHistory('hist-uid');
    expect(rows.length).toBe(2);
    // 倒序：最近写的(盘中B, created_at 更晚)在前
    expect(rows[0].content).toBe('盘中B');
    expect(rows[0]).toHaveProperty('phase');
    expect(rows[0]).toHaveProperty('date');
  });

  it('GET /history 路由返回数组', async () => {
    const res = await request(app).get('/api/strategy/history').set(h(userTok));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
```
> 用 `require('../strategy/service')` 直接对一个固定 uid 写记录测 `listStrategyHistory`(避免依赖 userTok 的内部 id);路由测只断言 200 + 数组。

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest routes/strategy -i -t "history"`。Expected: FAIL（`listStrategyHistory is not a function` / 404）。

- [ ] **Step 3: 实现**

3a. `backend/src/strategy/service.ts` 末尾加：
```ts
// 该用户策略历史(预判/盘中/复盘/休市快报)，按时间倒序，给「策略历史」页用。
export function listStrategyHistory(userId: string, limit = 120): any[] {
  return getDb()
    .prepare('SELECT date, phase, content, created_at, updated_at FROM daily_strategy WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit) as any[];
}
```
3b. `backend/src/routes/strategy.ts` 加路由(在 `/today` 附近)：
```ts
// GET /api/strategy/history — 策略历史(倒序)
router.get('/history', (req: Request, res: Response) => {
  successResponse(res, svc.listStrategyHistory(req.user!.userId));
});
```
(`svc` 命名空间已 import。)

- [ ] **Step 4: 运行确认通过 + 回归** — `cd ~/projects/stock-agent/backend && npx jest routes/strategy strategy -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/strategy/service.ts backend/src/routes/strategy.ts backend/src/routes/strategy.test.ts
git commit -m "feat(strategy): listStrategyHistory + GET /api/strategy/history(策略历史倒序)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 前端 策略历史视图 + 菜单替换

**Files:** Modify `frontend/src/api/strategy.ts`；Create `frontend/src/views/StrategyHistoryView.vue`；Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: `api/strategy.ts` 加 history**

类型区加：
```ts
export interface StrategyHistoryRow {
  date: string;
  phase: StrategyPhase;
  content: string;
  created_at: string;
  updated_at: string;
}
```
`strategyApi` 加：
```ts
  history: () => api.get<{ data: StrategyHistoryRow[] }>('/strategy/history'),
```

- [ ] **Step 2: 创建 `frontend/src/views/StrategyHistoryView.vue`**

```vue
<template>
  <div class="sh">
    <header class="bar"><h1>策略历史</h1></header>
    <p v-if="!list.length" class="muted">还没有策略记录。预判/盘中/复盘会按你的设定时间自动生成，也可在「当天策略和复盘」房间手动生成。</p>
    <section v-for="(m, i) in list" :key="i" class="card">
      <div class="head" @click="toggle(i)">
        <span class="tag" :class="m.phase">{{ phaseLabel(m.phase) }}</span>
        <span class="date">{{ m.date }}</span>
        <span class="summary">{{ open[i] ? '' : summarize(m.content) }}</span>
        <span class="chev">{{ open[i] ? '▾' : '▸' }}</span>
      </div>
      <pre v-if="open[i]" class="full">{{ m.content }}</pre>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { strategyApi, type StrategyHistoryRow, type StrategyPhase } from '../api/strategy';

const list = ref<StrategyHistoryRow[]>([]);
const open = reactive<Record<number, boolean>>({});

const LABELS: Record<StrategyPhase, string> = { prejudge: '预判', intraday: '盘中', review: '复盘', holiday: '休市快报' };
function phaseLabel(p: StrategyPhase) { return LABELS[p] || p; }
function summarize(c: string) {
  const t = (c || '').replace(/[#*\n]/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
function toggle(i: number) { open[i] = !open[i]; }

onMounted(async () => {
  try { list.value = (await strategyApi.history()).data.data; } catch { /* ignore */ }
});
</script>

<style scoped>
.sh { max-width: 960px; margin: 0; padding: 0; }
.muted { color: #999; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 8px 4px; margin-bottom: 10px; }
.head { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 8px; }
.tag.prejudge { background: #fff3d6; color: #a76b00; }
.tag.intraday { background: #e8f3ff; color: #2563a8; }
.tag.review { background: #e9f7e9; color: #2a8a2a; }
.tag.holiday { background: #eee; color: #777; }
.date { color: #666; }
.summary { flex: 1; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chev { color: #aaa; }
.full { white-space: pre-wrap; padding: 0 12px 12px; font-size: 13px; line-height: 1.6; margin: 0; }
</style>
```

- [ ] **Step 3: HomeView SETTINGS 菜单项替换**

3a. 顶部 import：删除 `import MeetingsHistoryView from './MeetingsHistoryView.vue';`(确认 HomeView 不再用它——本期它仅被该菜单项引用);加 `import StrategyHistoryView from './StrategyHistoryView.vue';`。
3b. `SETTINGS` 数组里把：
```ts
  { key: 'meetings', label: '早晚会历史', icon: '🗓', comp: MeetingsHistoryView, roles: 'user' },
```
改为：
```ts
  { key: 'strategy_history', label: '策略历史', icon: '🗓', comp: StrategyHistoryView, roles: 'user' },
```

- [ ] **Step 4: 类型检查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/strategy.ts frontend/src/views/StrategyHistoryView.vue frontend/src/views/HomeView.vue
git commit -m "feat(home): 「策略历史」视图取代「早晚会历史」菜单(展示 daily_strategy)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段⑤ 验收

1. `cd ~/projects/stock-agent/backend && npx jest strategy routes/strategy -i` → 全绿(含 history)。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(可选)：普通用户菜单「策略历史」列出预判/盘中/复盘/休市快报(倒序、标签着色、可展开);旧「早晚会历史」入口消失。
4. **整个「当天策略和复盘」功能(阶段①–⑤)完成。**

## 可选后续清理(不在本期)
旧 meeting 死码可一并删除：`routes/meetings`(+ index 卸载)、`cron/meetings.ts`、`MeetingsHistoryView.vue`、`api/meetings.ts`、`meetings/service.ts` 里的 `generateMorning`/`generateEvening`/`buildMorning*`/`buildEvening*`/`getToday`/`listMeetings`/`getTodayContent`/`upsert`/`GenOpts`/news-adopt 助手及其测试——**前提**：先把 strategy 复用的 `marketText`/`sectorText`/`rulebookText`/`defaultAiCall`/`eligibleUserIds` 迁到中性模块(如 `strategy/inputs.ts` 或 `agent/`),再删 meetings 生成部分。属重构，单独成计划更稳。
