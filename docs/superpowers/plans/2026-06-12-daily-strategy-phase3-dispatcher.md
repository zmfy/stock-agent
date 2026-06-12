# 当天策略引擎 · 阶段③ 调度器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个全局 `strategy_tick` cron(每5分钟)驱动新策略引擎：每 tick 遍历合格用户，按各自调度配置 + 北京时间 + 交易日历做**幂等 due 判断**，调对应生成器；退役旧 `meeting_morning`/`meeting_evening` cron。

**Architecture:** 新文件 `backend/src/strategy/dispatcher.ts`：纯函数 `dueJobs(cfg, now, isTradingToday, inSession, state)` 决定该生成哪些 phase(可穷举测试)；`runStrategyTick(deps?)` 薄胶水(可注入 `now`/`eligibleUserIds`/`generators`，测试不触 AI)读状态→dueJobs→调生成器。注册到 `cron/registry.ts`，移除两个 meeting cron。

**Tech Stack:** Express/TS + jest + node-cron。

参照 spec：`docs/superpowers/specs/2026-06-12-daily-strategy-engine-design.md`(E 调度)。依赖阶段①②(`strategy/service.ts`、`strategy/generate.ts`)。

---

## 文件结构

- Create `backend/src/strategy/dispatcher.ts` — `dueJobs` + `runStrategyTick`
- Create `backend/src/strategy/dispatcher.test.ts` — 单测
- Modify `backend/src/cron/registry.ts` — 注册 `strategy_tick`、移除 `meeting_morning`/`meeting_evening`
- Modify `backend/src/cron/registry.test.ts`、`backend/src/routes/cron.test.ts` — 更新作业数/键断言

---

## Task 1: dispatcher（dueJobs 纯函数 + runStrategyTick，TDD）

**Files:** Create `backend/src/strategy/dispatcher.ts`、`backend/src/strategy/dispatcher.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/strategy/dispatcher.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-strat-disp-'));

const { getDb } = require('../db');
const svc = require('./service');
const disp = require('./dispatcher');

const U = 'u1';
const DEF = { prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' };
// 北京时间构造：Date.UTC(...,hUTC) → 北京 = hUTC+8
const WED = (hUTC: number, m = 0) => Date.UTC(2026, 5, 10, hUTC, m, 0); // 2026-06-10 周三(交易日)
const SUN = (hUTC: number) => Date.UTC(2026, 5, 7, hUTC, 0, 0);         // 2026-06-07 周日(休市)

beforeEach(() => {
  getDb().exec('DELETE FROM daily_strategy; DELETE FROM daily_strategy_config;');
});

describe('dueJobs(纯函数)', () => {
  const empty = { hasPrejudge: false, hasReview: false, hasHoliday: false, lastIntradayMs: null };
  it('休市日：到快报时间且未生成→[holiday]；已生成→[]', () => {
    expect(disp.dueJobs(DEF, SUN(2), false, false, empty)).toEqual(['holiday']); // 北京10:00 ≥09:00
    expect(disp.dueJobs(DEF, SUN(2), false, false, { ...empty, hasHoliday: true })).toEqual([]);
    expect(disp.dueJobs(DEF, SUN(0), false, false, empty)).toEqual([]); // 北京08:00 <09:00
  });
  it('交易日预判：到预判时间且未生成才 due', () => {
    expect(disp.dueJobs(DEF, WED(1), true, false, empty)).toContain('prejudge'); // 北京09:00 ≥08:30
    expect(disp.dueJobs(DEF, WED(0), true, false, empty)).not.toContain('prejudge'); // 北京08:00 <08:30
    expect(disp.dueJobs(DEF, WED(1), true, false, { ...empty, hasPrejudge: true })).not.toContain('prejudge');
  });
  it('交易日盘中：在盘中时段按间隔，间隔=无不生成', () => {
    const t = WED(2); // 北京10:00 盘中
    expect(disp.dueJobs(DEF, t, true, true, empty)).toContain('intraday'); // 无历史→生成
    expect(disp.dueJobs(DEF, t, true, true, { ...empty, lastIntradayMs: t - 30 * 60000 })).not.toContain('intraday'); // 距上次30<60
    expect(disp.dueJobs(DEF, t, true, true, { ...empty, lastIntradayMs: t - 90 * 60000 })).toContain('intraday'); // 90≥60
    expect(disp.dueJobs(DEF, t, true, false, empty)).not.toContain('intraday'); // 非盘中时段
    expect(disp.dueJobs({ ...DEF, intradayInterval: 0 }, t, true, true, empty)).not.toContain('intraday'); // 无盘中
  });
  it('交易日复盘：到复盘时间且未生成才 due', () => {
    expect(disp.dueJobs(DEF, WED(8), true, false, empty)).toContain('review'); // 北京16:00 ≥15:30
    expect(disp.dueJobs(DEF, WED(2), true, false, empty)).not.toContain('review'); // 北京10:00 <15:30
  });
});

describe('runStrategyTick(注入生成器，不触 AI)', () => {
  function stubGens() {
    const calls: string[] = [];
    const mk = (name: string) => async (_uid: string) => { calls.push(name); };
    return { calls, generators: { prejudge: mk('prejudge'), intraday: mk('intraday'), review: mk('review'), holiday: mk('holiday') } };
  }
  it('交易日盘中：无历史→prejudge+intraday，不含 review', async () => {
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: WED(2), eligibleUserIds: () => [U], generators }); // 北京10:00
    expect(calls.sort()).toEqual(['intraday', 'prejudge']);
  });
  it('已生成预判则不重复', async () => {
    svc.recordStrategy(U, 'prejudge', 'x', {}, svc.beijingDate(WED(2)));
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: WED(2), eligibleUserIds: () => [U], generators });
    expect(calls).not.toContain('prejudge');
    expect(calls).toContain('intraday');
  });
  it('休市日只 holiday', async () => {
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: SUN(2), eligibleUserIds: () => [U], generators }); // 周日北京10:00
    expect(calls).toEqual(['holiday']);
  });
  it('无合格用户→无操作', async () => {
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: WED(2), eligibleUserIds: () => [], generators });
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest strategy/dispatcher -i`。Expected: FAIL（`Cannot find module './dispatcher'`）。

- [ ] **Step 3: 实现 `backend/src/strategy/dispatcher.ts`**

```ts
import { isTradingDay } from '../data/trade-calendar';
import { inTradingSession } from '../data/service';
import { eligibleUserIds } from '../meetings/service';
import { ScheduleConfig, StrategyPhase, getScheduleConfig, beijingDate, hasStrategy, getLatestIntraday } from './service';
import { generatePrejudge, generateIntraday, generateReview, generateHoliday } from './generate';

export interface TickState {
  hasPrejudge: boolean;
  hasReview: boolean;
  hasHoliday: boolean;
  lastIntradayMs: number | null;
}

function toMins(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function beijingMins(nowMs: number): number {
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  return bj.getUTCHours() * 60 + bj.getUTCMinutes();
}

// 纯函数：根据配置 + 时间 + 交易日/盘中 + 当天已生成状态，决定本 tick 该生成哪些 phase。
export function dueJobs(cfg: ScheduleConfig, nowMs: number, isTradingToday: boolean, inSession: boolean, state: TickState): StrategyPhase[] {
  const mins = beijingMins(nowMs);
  const due: StrategyPhase[] = [];
  if (!isTradingToday) {
    if (mins >= toMins(cfg.holidayBriefTime) && !state.hasHoliday) due.push('holiday');
    return due;
  }
  if (mins >= toMins(cfg.prejudgeTime) && !state.hasPrejudge) due.push('prejudge');
  if (inSession && cfg.intradayInterval > 0 && (state.lastIntradayMs == null || nowMs - state.lastIntradayMs >= cfg.intradayInterval * 60000)) {
    due.push('intraday');
  }
  if (mins >= toMins(cfg.reviewTime) && !state.hasReview) due.push('review');
  return due;
}

type Gen = (uid: string) => Promise<unknown>;
export interface TickDeps {
  now?: number;
  eligibleUserIds?: () => string[];
  generators?: Record<StrategyPhase, Gen>;
}
const DEFAULT_GENERATORS: Record<StrategyPhase, Gen> = {
  prejudge: (u) => generatePrejudge(u),
  intraday: (u) => generateIntraday(u),
  review: (u) => generateReview(u),
  holiday: (u) => generateHoliday(u),
};

function parseUtc(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(String(ts).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
}

export async function runStrategyTick(deps: TickDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now();
  const users = (deps.eligibleUserIds ?? eligibleUserIds)();
  if (!users.length) return;
  const date = beijingDate(now);
  const trading = isTradingDay(date);
  const session = inTradingSession(now);
  const gens = deps.generators ?? DEFAULT_GENERATORS;
  for (const uid of users) {
    const cfg = getScheduleConfig(uid);
    const state: TickState = {
      hasPrejudge: hasStrategy(uid, date, 'prejudge'),
      hasReview: hasStrategy(uid, date, 'review'),
      hasHoliday: hasStrategy(uid, date, 'holiday'),
      lastIntradayMs: parseUtc(getLatestIntraday(uid, date)?.created_at),
    };
    for (const phase of dueJobs(cfg, now, trading, session, state)) {
      try {
        await gens[phase](uid);
      } catch (e) {
        console.error(`[strategy_tick] ${phase} failed for ${uid}:`, (e as Error).message);
      }
    }
  }
}
```

- [ ] **Step 4: 运行确认通过** — `cd ~/projects/stock-agent/backend && npx jest strategy/dispatcher -i`。Expected: PASS(全部)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/strategy/dispatcher.ts backend/src/strategy/dispatcher.test.ts
git commit -m "feat(strategy): 调度器——dueJobs 幂等判定(纯函数)+runStrategyTick(按用户config/交易日历调生成器,可注入)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 注册 strategy_tick cron + 退役 meeting cron

**Files:** Modify `backend/src/cron/registry.ts`、`backend/src/cron/registry.test.ts`、`backend/src/routes/cron.test.ts`

- [ ] **Step 1: 改 `registry.ts`**

1a. 顶部 import：删除 `import { runMeetings } from './meetings';`；新增 `import { runStrategyTick } from '../strategy/dispatcher';`。
1b. `CRON_JOBS` 数组：**删除** `meeting_morning`、`meeting_evening` 两项(line 19-20)；在 `realtime` 项之后**新增**：
```ts
  { key: 'strategy_tick', label: '策略调度', description: '每5分钟按各用户配置生成预判/盘中/复盘/休市快报(交易日历闸门)', defaultExpr: '*/5 * * * *', run: () => runStrategyTick() },
```
> 保留 nightly/stock_universe/eod/realtime。结果 6 项 → 5 项(去 2 加 1)。

- [ ] **Step 2: 更新测试作业数/键断言**

2a. `backend/src/cron/registry.test.ts`：`expect(jobs.length).toBe(6)` → `toBe(5)`。在该断言附近加：
```ts
    expect(jobs.find((j: any) => j.key === 'strategy_tick')).toBeTruthy();
    expect(jobs.find((j: any) => j.key === 'meeting_morning')).toBeFalsy();
```
2b. `backend/src/routes/cron.test.ts`：`expect(r.body.data.jobs.length).toBe(6)` → `toBe(5)`。
> 先 Read 两文件确认上下文(jobs 变量来源、是否还有其它对 meeting_morning/evening 的断言需一并删/改)。

- [ ] **Step 3: 运行 cron 测试 + 全量回归**

Run: `cd ~/projects/stock-agent/backend && npx jest cron strategy -i`
Expected: 全绿(cron 列表含 strategy_tick、不含 meeting_*;dispatcher 测试绿)。

Run: `cd ~/projects/stock-agent/backend && npm test`
Expected: 本批相关绿(既有 chat/meetings live-sidecar flaky 除外;注意：`meetings/service.test.ts` 仍测 generateMorning/Evening 函数本身——这些函数未删,仅 cron 不再调,测试应仍绿)。

- [ ] **Step 4: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/cron/registry.ts backend/src/cron/registry.test.ts backend/src/routes/cron.test.ts
git commit -m "feat(cron): 注册 strategy_tick(每5分钟策略调度);退役 meeting_morning/meeting_evening cron

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段③ 验收

1. `cd ~/projects/stock-agent/backend && npx jest strategy cron -i` → 全绿(dispatcher + cron 列表)。
2. `npm test` → 本批相关绿。
3. `strategy_tick` 已注册(`listCronJobs` 含之、admin「定时任务」页可见可启停/改频率/立即跑);`meeting_morning`/`meeting_evening` 已从 cron 退役(generateMorning/Evening 函数暂留,阶段④处理房间后可清理)。新策略引擎自此自动按各用户配置生成。下一步=阶段④(daily 房间合并 + 按时段显示 + 齿轮 ⚙ 设置 + 删旧 morning/evening 房间)。
