# 当天策略引擎 · 阶段① 数据底座 + 调度配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建好新策略引擎的数据底座：`daily_strategy`(四类内容) + `daily_strategy_config`(每用户调度) 两张表、`strategy/service.ts`(配置读写+校验、`dailyPhase` 时段判定、策略行读写)、以及每用户 `GET/PUT /api/strategy/schedule` 路由。不含生成引擎/调度器/UI(后续阶段)。

**Architecture:** 新模块 `backend/src/strategy/service.ts` 持有所有策略数据访问与时段判定;新路由 `backend/src/routes/strategy.ts` 暴露每用户调度配置。纯数据 + 纯函数,可独立测试。

**Tech Stack:** Express/TS + jest + better-sqlite3。

参照 spec：`docs/superpowers/specs/2026-06-12-daily-strategy-engine-design.md`(A 数据模型、F 时间设置、D 的 `dailyPhase`)。

---

## 文件结构

- Modify `backend/src/db.ts` — 两张新表(migrate)
- Create `backend/src/strategy/service.ts` — 配置 + dailyPhase + 策略行读写
- Create `backend/src/strategy/service.test.ts` — 单测
- Create `backend/src/routes/strategy.ts` — `GET/PUT /api/strategy/schedule`
- Modify `backend/src/index.ts` — 挂载路由
- Create `backend/src/routes/strategy.test.ts` — 路由测试

---

## Task 1: 两张新表

**Files:** Modify `backend/src/db.ts`

- [ ] **Step 1: 在 `migrate()` 末尾加两张表**(紧跟现有 `shared_plugin_optout` 等建表之后；用 `CREATE TABLE IF NOT EXISTS`，幂等)

```ts
  db.exec(`CREATE TABLE IF NOT EXISTS daily_strategy (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    phase TEXT NOT NULL,
    content TEXT,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_daily_strategy_user_date ON daily_strategy (user_id, date, phase)');
  db.exec(`CREATE TABLE IF NOT EXISTS daily_strategy_config (
    user_id TEXT PRIMARY KEY,
    prejudge_time TEXT DEFAULT '08:30',
    intraday_interval INTEGER DEFAULT 60,
    review_time TEXT DEFAULT '15:30',
    holiday_brief_time TEXT DEFAULT '09:00'
  )`);
```
> 先 Read `migrate()` 确认 `db` 变量名与插入位置(在其它 `db.exec(...)` 建表附近)。

- [ ] **Step 2: 编译检查** — `cd ~/projects/stock-agent/backend && npx tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/db.ts
git commit -m "feat(db): daily_strategy + daily_strategy_config 表(当天策略引擎数据底座)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: strategy/service.ts（配置 + dailyPhase + 策略读写，TDD）

**Files:** Create `backend/src/strategy/service.ts`、`backend/src/strategy/service.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/strategy/service.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-strat-'));

const { getDb } = require('../db');
const svc = require('./service');

const U = 'u1';
beforeEach(() => {
  getDb().exec('DELETE FROM daily_strategy; DELETE FROM daily_strategy_config;');
});

describe('schedule config', () => {
  it('无行时返回默认', () => {
    expect(svc.getScheduleConfig(U)).toEqual({ prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' });
  });
  it('set 合法值并 round-trip(部分字段)', () => {
    const out = svc.setScheduleConfig(U, { intradayInterval: 30, reviewTime: '15:45' });
    expect(out).toEqual({ prejudgeTime: '08:30', intradayInterval: 30, reviewTime: '15:45', holidayBriefTime: '09:00' });
    expect(svc.getScheduleConfig(U).intradayInterval).toBe(30);
  });
  it('间隔=0(无盘中)合法', () => {
    expect(svc.setScheduleConfig(U, { intradayInterval: 0 }).intradayInterval).toBe(0);
  });
  it('非法时间 / 非法间隔抛 INVALID_SCHEDULE', () => {
    expect(() => svc.setScheduleConfig(U, { prejudgeTime: '25:00' })).toThrow('INVALID_SCHEDULE');
    expect(() => svc.setScheduleConfig(U, { intradayInterval: 45 })).toThrow('INVALID_SCHEDULE');
  });
});

describe('dailyPhase', () => {
  // 北京 08:00 = UTC 00:00；10:00=02:00；16:00=08:00
  const at = (hUTC: number) => Date.UTC(2026, 5, 10, hUTC, 0, 0);
  it('交易日按时段', () => {
    expect(svc.dailyPhase(at(0), true)).toBe('prejudge');   // 北京08:00
    expect(svc.dailyPhase(at(2), true)).toBe('intraday');   // 北京10:00
    expect(svc.dailyPhase(at(8), true)).toBe('review');     // 北京16:00
  });
  it('边界 9:00→intraday, 15:00→review', () => {
    expect(svc.dailyPhase(Date.UTC(2026, 5, 10, 1, 0, 0), true)).toBe('intraday'); // 北京09:00
    expect(svc.dailyPhase(Date.UTC(2026, 5, 10, 7, 0, 0), true)).toBe('review');   // 北京15:00
  });
  it('休市日恒为 holiday', () => {
    expect(svc.dailyPhase(at(2), false)).toBe('holiday');
  });
});

describe('daily_strategy 行读写', () => {
  const D = '2026-06-10';
  it('singleton(prejudge) upsert：重复写只 1 行、内容更新', () => {
    svc.recordStrategy(U, 'prejudge', '预判v1', { a: 1 }, D);
    svc.recordStrategy(U, 'prejudge', '预判v2', { a: 2 }, D);
    const all = getDb().prepare("SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase='prejudge'").all(U, D);
    expect(all).toHaveLength(1);
    expect(svc.getStrategy(U, D, 'prejudge').content).toBe('预判v2');
  });
  it('intraday 累积成时间线(多行,asc)', () => {
    svc.recordStrategy(U, 'intraday', '盘中1', {}, D);
    svc.recordStrategy(U, 'intraday', '盘中2', {}, D);
    const tl = svc.getIntradayTimeline(U, D);
    expect(tl.map((r: any) => r.content)).toEqual(['盘中1', '盘中2']);
    expect(svc.getLatestIntraday(U, D).content).toBe('盘中2');
  });
  it('hasStrategy / getStrategy 未生成→false/null', () => {
    expect(svc.hasStrategy(U, D, 'review')).toBe(false);
    expect(svc.getStrategy(U, D, 'review')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest strategy/service -i`。Expected: FAIL（`Cannot find module './service'`）。

- [ ] **Step 3: 实现 `backend/src/strategy/service.ts`**

```ts
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';

export type StrategyPhase = 'prejudge' | 'intraday' | 'review' | 'holiday';
const SINGLETON: StrategyPhase[] = ['prejudge', 'review', 'holiday'];

export interface ScheduleConfig {
  prejudgeTime: string;
  intradayInterval: number; // 30 | 60 | 120 | 0
  reviewTime: string;
  holidayBriefTime: string;
}
const DEFAULT_SCHEDULE: ScheduleConfig = { prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const INTERVALS = [0, 30, 60, 120];

// ---- 每用户调度配置 ----
export function getScheduleConfig(userId: string): ScheduleConfig {
  const r = getDb().prepare('SELECT * FROM daily_strategy_config WHERE user_id = ?').get(userId) as any;
  if (!r) return { ...DEFAULT_SCHEDULE };
  return {
    prejudgeTime: r.prejudge_time,
    intradayInterval: r.intraday_interval,
    reviewTime: r.review_time,
    holidayBriefTime: r.holiday_brief_time,
  };
}

export function setScheduleConfig(userId: string, input: Partial<ScheduleConfig>): ScheduleConfig {
  const merged: ScheduleConfig = { ...getScheduleConfig(userId), ...input };
  if (!HHMM.test(merged.prejudgeTime) || !HHMM.test(merged.reviewTime) || !HHMM.test(merged.holidayBriefTime)) {
    throw new Error('INVALID_SCHEDULE');
  }
  if (!INTERVALS.includes(merged.intradayInterval)) throw new Error('INVALID_SCHEDULE');
  getDb()
    .prepare(
      `INSERT INTO daily_strategy_config (user_id, prejudge_time, intraday_interval, review_time, holiday_brief_time)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prejudge_time=excluded.prejudge_time, intraday_interval=excluded.intraday_interval,
         review_time=excluded.review_time, holiday_brief_time=excluded.holiday_brief_time`,
    )
    .run(userId, merged.prejudgeTime, merged.intradayInterval, merged.reviewTime, merged.holidayBriefTime);
  return merged;
}

// ---- 时段判定(北京时间) ----
export function beijingDate(nowMs: number = Date.now()): string {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function dailyPhase(nowMs: number, isTradingToday: boolean): StrategyPhase {
  if (!isTradingToday) return 'holiday';
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  if (mins < 9 * 60) return 'prejudge';
  if (mins < 15 * 60) return 'intraday';
  return 'review';
}

// ---- daily_strategy 读写 ----
export function recordStrategy(userId: string, phase: StrategyPhase, content: string, data: unknown, date: string = beijingDate()): void {
  const db = getDb();
  const dataJson = JSON.stringify(data ?? {});
  if (SINGLETON.includes(phase)) {
    const existing = db.prepare('SELECT id FROM daily_strategy WHERE user_id=? AND date=? AND phase=?').get(userId, date, phase) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE daily_strategy SET content=?, data=?, created_at=CURRENT_TIMESTAMP WHERE id=?').run(content, dataJson, existing.id);
      return;
    }
  }
  db.prepare('INSERT INTO daily_strategy (id, user_id, date, phase, content, data) VALUES (?, ?, ?, ?, ?, ?)').run(uuidv4(), userId, date, phase, content, dataJson);
}

export function getStrategy(userId: string, date: string, phase: StrategyPhase): any | null {
  return (getDb().prepare('SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase=? ORDER BY created_at DESC LIMIT 1').get(userId, date, phase) as any) ?? null;
}
export function getIntradayTimeline(userId: string, date: string): any[] {
  return getDb().prepare("SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase='intraday' ORDER BY created_at").all(userId, date) as any[];
}
export function getLatestIntraday(userId: string, date: string): any | null {
  return (getDb().prepare("SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase='intraday' ORDER BY created_at DESC LIMIT 1").get(userId, date) as any) ?? null;
}
export function hasStrategy(userId: string, date: string, phase: StrategyPhase): boolean {
  return !!getDb().prepare('SELECT 1 FROM daily_strategy WHERE user_id=? AND date=? AND phase=? LIMIT 1').get(userId, date, phase);
}
```

- [ ] **Step 4: 运行确认通过** — `cd ~/projects/stock-agent/backend && npx jest strategy/service -i`。Expected: PASS(全部)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/strategy/service.ts backend/src/strategy/service.test.ts
git commit -m "feat(strategy): service 数据层——调度配置(校验)+dailyPhase+策略行读写(单例upsert/盘中累积)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 每用户调度路由 `GET/PUT /api/strategy/schedule`（TDD）

**Files:** Create `backend/src/routes/strategy.ts`、`backend/src/routes/strategy.test.ts`；Modify `backend/src/index.ts`

- [ ] **Step 1: 写失败测试 `backend/src/routes/strategy.test.ts`**（仿 `chat.test.ts` 的 app/token 模式：admin `tok`、普通 `userTok`、`h(token)` 头）

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-stratroute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let userTok = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456', agreed: true });
  const tok = login.body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${tok}`);
  const reg = await request(app).post('/api/auth/register').send({ username: 'plainu', password: 'secret123', inviteCode: inv.body.data.code, agreed: true });
  userTok = reg.body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('strategy schedule routes', () => {
  it('GET 默认配置', async () => {
    const res = await request(app).get('/api/strategy/schedule').set(h(userTok));
    expect(res.status).toBe(200);
    expect(res.body.data.config).toEqual({ prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' });
  });
  it('PUT 合法保存并读回', async () => {
    const put = await request(app).put('/api/strategy/schedule').set(h(userTok)).send({ intradayInterval: 120, prejudgeTime: '08:45' });
    expect(put.status).toBe(200);
    expect(put.body.data.config).toMatchObject({ intradayInterval: 120, prejudgeTime: '08:45' });
    const get = await request(app).get('/api/strategy/schedule').set(h(userTok));
    expect(get.body.data.config.intradayInterval).toBe(120);
  });
  it('PUT 非法 → 422', async () => {
    expect((await request(app).put('/api/strategy/schedule').set(h(userTok)).send({ intradayInterval: 45 })).status).toBe(422);
    expect((await request(app).put('/api/strategy/schedule').set(h(userTok)).send({ reviewTime: '99:99' })).status).toBe(422);
  });
  it('未登录 401', async () => {
    expect((await request(app).get('/api/strategy/schedule')).status).toBe(401);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest routes/strategy -i`。Expected: FAIL（404 路由不存在）。

- [ ] **Step 3: 实现路由 `backend/src/routes/strategy.ts`**

```ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../strategy/service';

const router = Router();
router.use(authMiddleware);

// GET /api/strategy/schedule — 读自己的调度配置(缺省补默认)
router.get('/schedule', (req: Request, res: Response) => {
  successResponse(res, { config: svc.getScheduleConfig(req.user!.userId) });
});

const schema = z.object({
  prejudgeTime: z.string().optional(),
  intradayInterval: z.number().int().optional(),
  reviewTime: z.string().optional(),
  holidayBriefTime: z.string().optional(),
});

// PUT /api/strategy/schedule — 写自己的(校验在 service)
router.put('/schedule', (req: Request, res: Response) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    const config = svc.setScheduleConfig(req.user!.userId, parsed.data);
    successResponse(res, { config }, '已保存');
  } catch (e: any) {
    if (e.message === 'INVALID_SCHEDULE') return errorResponse(res, 422, 'VALIDATION_ERROR', '时间或盘中间隔不合法(间隔仅 30/60/120/0)');
    throw e;
  }
});

export default router;
```

- [ ] **Step 4: 挂载路由 `backend/src/index.ts`**

import 区(与其它 `import xxxRoutes from './routes/xxx'` 同处)加：
```ts
import strategyRoutes from './routes/strategy';
```
挂载区(`app.use('/api/...')` 群,放在 `meetings` 之后)加：
```ts
  app.use('/api/strategy', aiLimiter, strategyRoutes);
```
> `aiLimiter` 与 meetings/chat 一致即可(纯配置读写其实无所谓限流,但与同组一致;如担心限流影响配置读取,可不加 limiter——二选一,加更稳妥)。确认 `aiLimiter` 在该作用域可用(meetings/chat 已用)。

- [ ] **Step 5: 运行确认通过 + 全量回归** — `cd ~/projects/stock-agent/backend && npx jest routes/strategy -i` 然后 `npm test`。Expected: 路由测试全绿；全量回归(注:`chat/service`、`meetings/service` 真连 live sidecar 用例可能间歇超时,属既有 flaky,与本改无关)。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/routes/strategy.ts backend/src/routes/strategy.test.ts backend/src/index.ts
git commit -m "feat(api): GET/PUT /api/strategy/schedule(每用户调度配置)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段① 验收

1. `cd ~/projects/stock-agent/backend && npx jest strategy -i` → 全绿(service + routes)。
2. `npm test` → 本批相关套件绿(既有 live-sidecar flaky 除外)。
3. 数据底座就位:`daily_strategy`/`daily_strategy_config` 两表 + 读写/校验/`dailyPhase` 全测;`/api/strategy/schedule` 可读写每用户配置。后续阶段②(生成引擎)将用 `recordStrategy`/`getScheduleConfig`/`dailyPhase`。
