# 当天策略引擎 · 阶段④ 房间合并 + 齿轮设置 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把固定房间从 morning/evening 换成单一 `daily`「当天策略和复盘」房间：按北京时段显示预判/盘中时间线/复盘/休市快报，房间内可手动生成与设时间(齿轮 ⚙)，删除旧 morning/evening 房间，chat 注入改 daily。

**Architecture:** 后端：`ChatKind` 加 `daily`，`FIXED_ROOM_KINDS=[core_principle,daily,screen]`，`ensureFixedRooms` 建 daily 并删旧 morning/evening 会话；chat 注入按当前 phase 取策略内容；新 `GET /api/strategy/today`(房间渲染数据) + `POST /api/strategy/generate/:phase`(手动生成,按路由限流)。前端：HomeView 渲染 daily 房间(按 phase) + 齿轮设置，移除旧 meeting 房间逻辑。

**Tech Stack:** Express/TS + jest + Vue 3。依赖阶段①②③。

参照 spec：`docs/superpowers/specs/2026-06-12-daily-strategy-engine-design.md`(D 房间、F 齿轮、G 迁移)。

---

## 文件结构

- Modify `backend/src/chat/service.ts` — ChatKind+FIXED_ROOM_KINDS+迁移+daily 注入
- Modify `backend/src/chat/service.test.ts` / `backend/src/routes/chat.test.ts` — 测试
- Modify `backend/src/routes/strategy.ts` — `GET /today` + `POST /generate/:phase`
- Modify `backend/src/routes/strategy.test.ts` — 测试
- Modify `backend/src/index.ts` — strategy 的生成路由按路由挂 aiLimiter(配置路由不限流)
- Create `frontend/src/api/strategy.ts` — schedule/today/generate 客户端
- Modify `frontend/src/views/HomeView.vue` — daily 房间显示 + 齿轮 + 移除旧 meeting 房间逻辑

---

## Task 1: 后端 daily 房间 + 迁移 + 注入（TDD）

**Files:** Modify `backend/src/chat/service.ts`、`backend/src/routes/chat.test.ts`

- [ ] **Step 1: 改 `chat/service.ts`**

1a. `ChatKind`(line 16) 末尾加 `| 'daily'`：
```ts
export type ChatKind = 'general' | 'core_principle' | 'stock' | 'morning' | 'evening' | 'screen' | 'daily';
```
1b. `FIXED_ROOM_KINDS`(line 18) 改为：
```ts
export const FIXED_ROOM_KINDS = ['core_principle', 'daily', 'screen'] as const satisfies ChatKind[];
```
1c. `FIXED_ROOM_TITLES`(line 19) 改为(键随之变)：
```ts
const FIXED_ROOM_TITLES: Record<typeof FIXED_ROOM_KINDS[number], string> = {
  core_principle: '当前策略探讨',
  daily: '当天策略和复盘',
  screen: '选股讨论',
};
```
1d. `KIND_FRAMING`(Record<ChatKind,string>) 加 `daily` 项(保留 morning/evening 不删，meetings 旧逻辑仍用)：
```ts
  daily: '当天策略与复盘：结合今日的策略预判/盘中/复盘，与用户讨论操作与得失。',
```
1e. 顶部加 import：
```ts
import { isTradingDay } from '../data/trade-calendar';
import { beijingDate, dailyPhase, getStrategy, getIntradayTimeline } from '../strategy/service';
```
1f. `ensureFixedRooms`(line 74-86)：在 `return listSessions(userId);` 之前插入「删除旧 morning/evening 房间(含消息)」迁移：
```ts
  // 迁移：旧的早会/晚会固定房间合并入 daily，删除其会话与消息
  for (const oldKind of ['morning', 'evening']) {
    const rows = db.prepare('SELECT id FROM chat_sessions WHERE user_id = ? AND kind = ?').all(userId, oldKind) as { id: string }[];
    for (const r of rows) {
      db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(r.id);
      db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(r.id);
    }
  }
```
1g. chat 注入：把 morning/evening 分支(约 line 219-221)：
```ts
  if (!extra && (session.kind === 'morning' || session.kind === 'evening')) {
    const mc = getTodayContent(userId, session.kind);
    if (mc) extra = `今日${session.kind === 'morning' ? '早会' : '晚会'}内容：\n${mc}`;
  }
```
替换为 daily 分支(按当前 phase 注入)：
```ts
  if (!extra && session.kind === 'daily') {
    const now = Date.now();
    const date = beijingDate(now);
    const phase = dailyPhase(now, isTradingDay(date));
    if (phase === 'prejudge') {
      const r = getStrategy(userId, date, 'prejudge');
      if (r) extra = `今日策略预判：\n${r.content}`;
    } else if (phase === 'intraday') {
      const tl = getIntradayTimeline(userId, date);
      if (tl.length) extra = `今日盘中时间线：\n${tl.map((x: any) => `· ${x.content}`).join('\n')}`;
    } else if (phase === 'review') {
      const r = getStrategy(userId, date, 'review');
      if (r) extra = `今日复盘：\n${r.content}`;
    } else {
      const r = getStrategy(userId, date, 'holiday');
      if (r) extra = `休市快报：\n${r.content}`;
    }
  }
```
> `buildMarketInjection(userId, session.kind, ...)` 对 `daily` 不识别会安静降级(返回空)，可接受；如需更准可后续把 daily→phase 映射传入，本期不做。

- [ ] **Step 2: 写/改测试**（`backend/src/routes/chat.test.ts` 的 `fixed rooms` describe）

把现有断言里的固定 kind 从 morning/evening 改为 daily，并加迁移断言。在该 describe 末尾追加：
```ts
  it('ensure 后固定房间=core_principle/daily/screen，且删除旧 morning/evening 房间', async () => {
    // 先制造一个旧 morning 房间
    await request(app).post('/api/chat/sessions').set(h(userTok)).send({ kind: 'morning' });
    await request(app).post('/api/chat/ensure-fixed-rooms').set(h(userTok));
    const list = (await request(app).get('/api/chat/sessions').set(h(userTok))).body.data as any[];
    expect(list.find((s) => s.kind === 'daily')).toBeTruthy();
    expect(list.filter((s) => s.kind === 'morning' || s.kind === 'evening')).toHaveLength(0);
    const daily = list.find((s) => s.kind === 'daily');
    expect(daily.pinned).toBe(1);
    // daily 不可删/取消置顶
    expect((await request(app).delete(`/api/chat/sessions/${daily.id}`).set(h(userTok))).status).toBe(409);
  });
```
> 若该测试文件已有断言 screen 是固定房间(上一个特性加的)，保留；只是固定集合从含 morning/evening 变为含 daily。检查并更新任何写死 morning/evening 为固定房间的旧断言。

- [ ] **Step 3: 运行 + 全量回归** — `cd ~/projects/stock-agent/backend && npx jest routes/chat chat/service -i` 然后 `npm test`。Expected: 全绿(注：meetings/service 仍测 generateMorning/Evening，它们未删，仍绿；chat live-sidecar flaky 除外)。

- [ ] **Step 4: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/chat/service.ts backend/src/routes/chat.test.ts
git commit -m "feat(chat): daily 固定房间取代 morning/evening(迁移删旧房间)+按 phase 注入策略内容

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: strategy 房间数据 + 手动生成路由（TDD）

**Files:** Modify `backend/src/routes/strategy.ts`、`backend/src/routes/strategy.test.ts`、`backend/src/index.ts`

- [ ] **Step 1: 实现路由**（`backend/src/routes/strategy.ts`，在 schedule 路由之后加）

顶部 import 增补：
```ts
import { aiLimiter } from '../middleware/rate-limit'; // 若 rate-limit 导出名不同，按实际(见 index.ts 用的 aiLimiter 来源)
import { beijingDate, dailyPhase, getStrategy, getIntradayTimeline, StrategyPhase } from '../strategy/service';
import { generatePrejudge, generateIntraday, generateReview, generateHoliday } from '../strategy/generate';
import { isTradingDay } from '../data/trade-calendar';
```
> 先确认 `aiLimiter` 的真实导出位置(看 `backend/src/index.ts` 顶部如何 import aiLimiter)。若不便在路由内引用，改为在 index.ts 挂 `/api/strategy/generate` 时单独加 limiter——二选一，目标是「生成端点限流、配置/读取不限流」。本计划按「在 strategy.ts 内对 generate 路由用 `aiLimiter` 中间件」。

加路由：
```ts
// GET /api/strategy/today — 当天策略房间渲染数据(按北京时段)
router.get('/today', (req: Request, res: Response) => {
  const uid = req.user!.userId;
  const now = Date.now();
  const date = beijingDate(now);
  const trading = isTradingDay(date);
  const pick = (p: StrategyPhase) => {
    const r = getStrategy(uid, date, p);
    return r ? { content: r.content, updatedAt: r.updated_at ?? r.created_at } : null;
  };
  successResponse(res, {
    date,
    isTradingDay: trading,
    phase: dailyPhase(now, trading),
    prejudge: pick('prejudge'),
    review: pick('review'),
    holiday: pick('holiday'),
    intraday: getIntradayTimeline(uid, date).map((x: any) => ({ content: x.content, createdAt: x.created_at })),
  });
});

const GEN_PHASES: Record<string, (uid: string) => Promise<string>> = {
  prejudge: generatePrejudge,
  intraday: generateIntraday,
  review: generateReview,
  holiday: generateHoliday,
};

// POST /api/strategy/generate/:phase — 手动生成某 phase(限流)
router.post('/generate/:phase', aiLimiter, async (req: Request, res: Response) => {
  const fn = GEN_PHASES[req.params.phase];
  if (!fn) return errorResponse(res, 422, 'VALIDATION_ERROR', '未知阶段');
  try {
    const content = await fn(req.user!.userId);
    successResponse(res, { content }, '已生成');
  } catch (e: any) {
    return errorResponse(res, 502, 'UPSTREAM_ERROR', e?.message || '生成失败');
  }
});
```

- [ ] **Step 2: 写测试**（`backend/src/routes/strategy.test.ts` 追加；注入生成器不便走路由，故 generate 路由用「mock 掉 strategy/generate」或直接断言 422 未知 phase + 200 已知 phase 但 stub aiCall 不可控——改为：测 `/today` 结构 + `/generate/:phase` 的 422 未知 phase；已知 phase 的真实生成涉及 AI，标记为不在路由测试覆盖，由阶段② service 测覆盖）

```ts
describe('strategy today + generate routes', () => {
  it('GET /today 返回结构', async () => {
    const res = await request(app).get('/api/strategy/today').set(h(userTok));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('phase');
    expect(res.body.data).toHaveProperty('isTradingDay');
    expect(Array.isArray(res.body.data.intraday)).toBe(true);
    expect(res.body.data).toHaveProperty('prejudge'); // null 或对象
  });
  it('POST /generate/未知phase → 422', async () => {
    expect((await request(app).post('/api/strategy/generate/foo').set(h(userTok))).status).toBe(422);
  });
});
```
> `h`/`userTok` 沿用该文件 Phase① 已建的辅助。已知 phase 的真实生成会触发 AI/取数，路由测试不覆盖(阶段② 已测生成器本身);如需可后续用 jest.mock。

- [ ] **Step 3: 运行 + 回归** — `cd ~/projects/stock-agent/backend && npx jest routes/strategy -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/routes/strategy.ts backend/src/routes/strategy.test.ts backend/src/index.ts
git commit -m "feat(api): GET /api/strategy/today(房间数据) + POST /generate/:phase(手动生成,限流)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 前端 daily 房间显示 + 移除旧 meeting 房间逻辑

**Files:** Create `frontend/src/api/strategy.ts`；Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: `frontend/src/api/strategy.ts`**

```ts
import api from './client';

export interface ScheduleConfig {
  prejudgeTime: string;
  intradayInterval: number;
  reviewTime: string;
  holidayBriefTime: string;
}
export type StrategyPhase = 'prejudge' | 'intraday' | 'review' | 'holiday';
export interface StrategyEntry { content: string; updatedAt: string }
export interface StrategyToday {
  date: string;
  isTradingDay: boolean;
  phase: StrategyPhase;
  prejudge: StrategyEntry | null;
  review: StrategyEntry | null;
  holiday: StrategyEntry | null;
  intraday: Array<{ content: string; createdAt: string }>;
}

export const strategyApi = {
  getSchedule: () => api.get<{ data: { config: ScheduleConfig } }>('/strategy/schedule'),
  setSchedule: (cfg: Partial<ScheduleConfig>) => api.put<{ data: { config: ScheduleConfig } }>('/strategy/schedule', cfg),
  today: () => api.get<{ data: StrategyToday }>('/strategy/today'),
  generate: (phase: StrategyPhase) => api.post<{ data: { content: string } }>(`/strategy/generate/${phase}`),
};
```

- [ ] **Step 2: HomeView 接入 daily 房间状态**（`<script setup>`）

2a. 顶部加 `import { strategyApi, type StrategyToday, type StrategyPhase } from '../api/strategy';`。
2b. `FIXED_ORDER`(line 327) 改为 `['core_principle', 'daily', 'screen']`。
2c. `kindIcon`(line 592) 的 icons 加 `daily: '📋'`(morning/evening 可保留映射，不再用作固定房间)。
2d. `sessionLabel`(约 line 595) 加：`if (s.kind === 'daily') return '当天策略和复盘';`。
2e. 加状态与加载：
```ts
const strategyToday = ref<StrategyToday | null>(null);
const strategyGenerating = ref(false);
async function loadStrategyToday() {
  try { strategyToday.value = (await strategyApi.today()).data.data; } catch { strategyToday.value = null; }
}
async function genStrategy(phase: StrategyPhase) {
  strategyGenerating.value = true;
  try { await strategyApi.generate(phase); await loadStrategyToday(); }
  catch (e: any) { noteErrorToSession(sessions.value.find((x) => x.kind === 'daily')?.id, `生成失败：${e.response?.data?.message || ''}`); }
  finally { strategyGenerating.value = false; }
}
```
2f. 在 `open(s)`(打开会话)里：当 `s.kind === 'daily'` 时 `await loadStrategyToday()`(参照其它 kind 的按需加载，如 screen)。

- [ ] **Step 3: HomeView 模板 — daily 房间内容**

3a. 把 morning/evening 的 room-actions 块(line 111-115)替换为 daily 块：
```vue
              <div v-if="active.kind === 'daily'" class="daily-room">
                <div class="room-actions">
                  <button v-if="strategyToday && !strategyToday.isTradingDay" class="ops-btn dashed" :disabled="strategyGenerating" @click="genStrategy('holiday')">🛌 生成休市快报</button>
                  <template v-else-if="strategyToday">
                    <button v-if="strategyToday.phase === 'prejudge'" class="ops-btn dashed" :disabled="strategyGenerating" @click="genStrategy('prejudge')">📈 生成今日预判</button>
                    <button v-else-if="strategyToday.phase === 'intraday'" class="ops-btn dashed" :disabled="strategyGenerating" @click="genStrategy('intraday')">⏱ 生成一条盘中</button>
                    <button v-else-if="strategyToday.phase === 'review'" class="ops-btn dashed" :disabled="strategyGenerating" @click="genStrategy('review')">🔁 生成复盘</button>
                  </template>
                  <button class="ops-btn" @click="scheduleOpen = !scheduleOpen">⚙ 时间设置</button>
                </div>
                <ScheduleSettings v-if="scheduleOpen" @saved="scheduleOpen = false" />
                <div v-if="strategyToday" class="daily-content">
                  <template v-if="!strategyToday.isTradingDay">
                    <div class="phase-head">🛌 休市日 · 新闻与板块</div>
                    <ClampText v-if="strategyToday.holiday" :text="strategyToday.holiday.content" @detail="openDetail" />
                    <p v-else class="muted">休市快报将于设定时间生成。</p>
                  </template>
                  <template v-else-if="strategyToday.phase === 'prejudge'">
                    <div class="phase-head">📈 盘前 · 今日策略预判</div>
                    <ClampText v-if="strategyToday.prejudge" :text="strategyToday.prejudge.content" @detail="openDetail" />
                    <p v-else class="muted">预判将于设定时间生成。</p>
                  </template>
                  <template v-else-if="strategyToday.phase === 'intraday'">
                    <div class="phase-head">⏱ 盘中 · 策略时间线</div>
                    <p v-if="!strategyToday.intraday.length" class="muted">盘中小结将按你的间隔生成。</p>
                    <div v-for="(it, i) in [...strategyToday.intraday].reverse()" :key="i" class="intraday-item">
                      <div class="muted">{{ fmtCN(it.createdAt) }}</div>
                      <ClampText :text="it.content" @detail="openDetail" />
                    </div>
                  </template>
                  <template v-else>
                    <div class="phase-head">🔁 盘后 · 复盘</div>
                    <ClampText v-if="strategyToday.review" :text="strategyToday.review.content" @detail="openDetail" />
                    <p v-else class="muted">复盘将于设定时间生成。</p>
                  </template>
                </div>
              </div>
```
> `ClampText`/`fmtCN`/`openDetail`/`noteErrorToSession` 文件已用，沿用。`ScheduleSettings` 在 Task 4 创建并 import；本步可先用占位(Task 4 补)或与 Task 4 合并。建议：本步先放 `<div v-if="scheduleOpen" class="muted">（时间设置见下一步）</div>` 占位，Task 4 替换为 `ScheduleSettings`，避免未定义组件报错。

3b. `briefing` computed(line 486-492)：删除 morning/evening 两行(daily 不走 briefing，单独渲染)。`briefingTime`(495-500) 同删 morning/evening 行。`adoptedNews`(518-522) 的 morning/evening 逻辑可保留(对 daily 返回空，无害)或简化；最简：把 line 519 改为 `const mt = null;`(daily 不展示 adopted_news 入口)——确认 adoptedNews 仅旧 meeting 用。

3c. 移除旧 meeting 房间入口：`genMeeting`/`openMeeting` 函数若仅被旧 room-actions 调用，现已无引用→删除;`meetings` ref 与 `loadMeetings()`：`loadMeetings` 仍可能被「早晚会历史」用?「早晚会历史」是独立视图(MeetingsHistoryView)自取数,HomeView 的 `meetings` ref 只服务旧房间→可删 `meetings` ref + `loadMeetings` 调用 + import meetingsApi(若 HomeView 不再用)。**先 grep 确认** `meetings`/`meetingsApi`/`genMeeting`/`openMeeting`/`showMeetingNews`/`openMeetingNews`/`adoptedNews` 的所有引用，逐个安全移除或保留;`vue-tsc` 必须 0。

- [ ] **Step 4: 样式 + 类型检查**

`<style scoped>` 末尾加：
```css
.daily-room { display: flex; flex-direction: column; gap: 10px; }
.phase-head { font-weight: 700; margin: 4px 0; }
.intraday-item { border-left: 3px solid var(--border, #e5e5e5); padding-left: 10px; margin-bottom: 10px; }
```
Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0（先在 onMounted 普通用户分支按需调用 `loadStrategyToday()`，或仅 open daily 时加载；确保无未用变量报错）。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/strategy.ts frontend/src/views/HomeView.vue
git commit -m "feat(home): daily 房间按时段显示(预判/盘中时间线/复盘/休市快报)+手动生成;移除旧早晚会房间逻辑

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 齿轮 ⚙ 时间设置组件

**Files:** Create `frontend/src/views/ScheduleSettings.vue`；Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 创建 `frontend/src/views/ScheduleSettings.vue`**

```vue
<template>
  <div class="sched">
    <div class="row">预判时间 <input type="time" v-model="cfg.prejudgeTime" /></div>
    <div class="row">盘中间隔
      <select v-model.number="cfg.intradayInterval">
        <option :value="30">每 30 分钟</option>
        <option :value="60">每 1 小时</option>
        <option :value="120">每 2 小时</option>
        <option :value="0">无</option>
      </select>
    </div>
    <div class="row">复盘时间 <input type="time" v-model="cfg.reviewTime" /></div>
    <div class="row">休市快报时间 <input type="time" v-model="cfg.holidayBriefTime" /></div>
    <div class="row">
      <button :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      <span v-if="msg" class="muted">{{ msg }}</span>
    </div>
  </div>
</template>
<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue';
import { strategyApi, type ScheduleConfig } from '../api/strategy';
const emit = defineEmits<{ (e: 'saved'): void }>();
const cfg = reactive<ScheduleConfig>({ prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' });
const saving = ref(false);
const msg = ref('');
onMounted(async () => {
  try { Object.assign(cfg, (await strategyApi.getSchedule()).data.data.config); } catch { /* ignore */ }
});
async function save() {
  saving.value = true; msg.value = '';
  try { Object.assign(cfg, (await strategyApi.setSchedule({ ...cfg })).data.data.config); msg.value = '已保存'; emit('saved'); }
  catch (e: any) { msg.value = e.response?.data?.message || '保存失败'; }
  finally { saving.value = false; }
}
</script>
<style scoped>
.sched { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border, #e5e5e5); border-radius: 8px; }
.row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
</style>
```

- [ ] **Step 2: HomeView 接入组件**

在 HomeView `<script setup>` 顶部加 `import ScheduleSettings from './ScheduleSettings.vue';` 与 `const scheduleOpen = ref(false);`；把 Task 3 Step 3a 里的占位 `<div v-if="scheduleOpen" ...>（时间设置见下一步）</div>` 替换为 `<ScheduleSettings v-if="scheduleOpen" @saved="scheduleOpen = false" />`(若 Task 3 已直接写 `<ScheduleSettings .../>`，本步只需补 import + scheduleOpen ref)。

- [ ] **Step 3: 类型检查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。

- [ ] **Step 4: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/ScheduleSettings.vue frontend/src/views/HomeView.vue
git commit -m "feat(home): 当天策略房间齿轮⚙时间设置(预判/盘中间隔/复盘/快报)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段④ 验收

1. `cd ~/projects/stock-agent/backend && npx jest routes/chat routes/strategy strategy -i` → 全绿。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(可选)：普通用户左栏固定房间为 📜当前策略 · 📋当天策略和复盘 · 🔍选股(旧早会/晚会消失);进「当天策略和复盘」房间——交易日按 0-9/9-15/15-24 显示预判/盘中时间线/复盘，休市日显示休市快报，缺内容有「生成」按钮 + 占位;齿轮 ⚙ 可设预判/盘中间隔(30/60/120/无)/复盘/快报时间并保存;在房间发言注入当前时段内容。
4. 下一步=阶段⑤(「早晚会历史」菜单改「策略历史」展示 daily_strategy)。
