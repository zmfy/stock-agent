# Admin 定时任务管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** admin 可查看所有后台定时任务(计划/最后运行/状态/日志)、改每日运行时间、启用/停用、立即运行一次。

**Architecture:** 把散在 3 个文件的 5 个 cron 收敛进 `cron/registry.ts`(单一真相源);用「带追踪的包装器」记 `cron_status` + 复用 `sync_log`;计划/开关覆盖存 `settings.cron_config`;改时间=HH:MM→`M H * * *`+`cron.validate`+停旧排新。admin 路由 + Vue 页。

**Tech Stack:** TS + Express + node-cron@3 + better-sqlite3 + Jest;Vue 3 + vue-tsc。

**测试命令:** 后端 `cd backend && npm test`(当前 267 绿);前端 `cd frontend && npx vue-tsc --noEmit`。

**Spec:** `docs/superpowers/specs/2026-06-10-admin-cron-management-design.md`。

---

## File Structure

- `backend/src/db.ts`(改)— `cron_status` 表。
- `backend/src/data/service.ts`(改)— `getCronConfig/setCronConfig` + `recordCronStart/recordCronFinish/getCronStatus`。
- `backend/src/cron/registry.ts`(新)— CRON_JOBS、纯助手(timeToExpr/exprToTime/nextRunAt/effective)、tracked、startCrons、applyCronChange、runCronNow、listCronJobs。
- `backend/src/cron/registry.test.ts`(新)。
- `backend/src/cron/{nightly,meetings,shared-data}.ts`(改)— `export` run 函数、删 `start*Cron`+`cron.schedule`。
- `backend/src/index.ts`(改)— 三处 start 换成 `startCrons()`,挂 `/api/cron`。
- `backend/src/routes/cron.ts`(新)+ `backend/src/routes/cron.test.ts`(新)。
- `frontend/src/api/cron.ts`(新)。
- `frontend/src/views/CronsView.vue`(新)+ `frontend/src/views/HomeView.vue`(改,菜单加 admin-only 项)。

---

## Task 1: DB 迁移 cron_status

**Files:** Modify `backend/src/db.ts`(`migrate()` 末尾)

- [ ] **Step 1: 追加建表**(在 migrate() 末尾、最后一个 `db.exec` 之后)

```ts
  db.exec(`CREATE TABLE IF NOT EXISTS cron_status (
    key TEXT PRIMARY KEY,
    last_run_at DATETIME,
    last_status TEXT,
    last_duration_ms INTEGER,
    last_error TEXT,
    run_count INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
```

- [ ] **Step 2: 编译+回归** — `cd backend && npx tsc --noEmit && npm test 2>&1 | tail -4`。Expected: tsc 0,267 绿。

- [ ] **Step 3: 提交** — `git add backend/src/db.ts && git commit -m "feat(db): cron_status 表"`

---

## Task 2: service.ts — cron 配置 + 状态记录(TDD)

**Files:** Modify `backend/src/data/service.ts`、`backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**(追加到 `service.test.ts` 末尾)

```ts
describe('cron config + status', () => {
  it('getCronConfig default empty; set/get round-trips', () => {
    expect(svc.getCronConfig()).toEqual({});
    svc.setCronConfig({ nightly: { expr: '5 23 * * *', enabled: false } });
    expect(svc.getCronConfig()).toEqual({ nightly: { expr: '5 23 * * *', enabled: false } });
  });
  it('records cron start/finish with duration + run_count', () => {
    svc.recordCronStart('nightly');
    let s = svc.getCronStatus('nightly');
    expect(s.last_status).toBe('running');
    svc.recordCronFinish('nightly', 'ok', 1234, null);
    s = svc.getCronStatus('nightly');
    expect(s).toMatchObject({ last_status: 'ok', last_duration_ms: 1234, run_count: 1 });
    svc.recordCronStart('nightly'); svc.recordCronFinish('nightly', 'error', 50, 'boom');
    s = svc.getCronStatus('nightly');
    expect(s).toMatchObject({ last_status: 'error', last_error: 'boom', run_count: 2 });
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest data/service -i -t "cron config"`。Expected: FAIL（`getCronConfig is not a function`）。

- [ ] **Step 3: 实现**(加在 `setProxyConfig` 之后)

```ts
export interface CronOverride { expr?: string; enabled?: boolean }
export type CronConfig = Record<string, CronOverride>;

export function getCronConfig(): CronConfig {
  const r = getDb().prepare("SELECT value FROM settings WHERE key='cron_config'").get() as { value: string } | undefined;
  if (!r?.value) return {};
  try { return JSON.parse(r.value) as CronConfig; } catch { return {}; }
}
export function setCronConfig(cfg: CronConfig): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('cron_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(cfg));
}

export interface CronStatusRow { key: string; last_run_at: string | null; last_status: string | null; last_duration_ms: number | null; last_error: string | null; run_count: number }

export function recordCronStart(key: string): void {
  getDb()
    .prepare(`INSERT INTO cron_status (key, last_run_at, last_status, run_count, updated_at)
              VALUES (?, CURRENT_TIMESTAMP, 'running', 0, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET last_run_at=CURRENT_TIMESTAMP, last_status='running', last_error=NULL, updated_at=CURRENT_TIMESTAMP`)
    .run(key);
}
export function recordCronFinish(key: string, status: 'ok' | 'error', durationMs: number, error: string | null): void {
  getDb()
    .prepare(`UPDATE cron_status SET last_status=?, last_duration_ms=?, last_error=?, run_count=run_count+1, updated_at=CURRENT_TIMESTAMP WHERE key=?`)
    .run(status, durationMs, error, key);
}
export function getCronStatus(key: string): CronStatusRow | null {
  return (getDb().prepare('SELECT key,last_run_at,last_status,last_duration_ms,last_error,run_count FROM cron_status WHERE key=?').get(key) as CronStatusRow) ?? null;
}
```

- [ ] **Step 4: 运行确认通过** — `cd backend && npx jest data/service -i -t "cron config"`。Expected: PASS。

- [ ] **Step 5: 提交** — `git add backend/src/data/service.ts backend/src/data/service.test.ts && git commit -m "feat(data): getCronConfig/setCronConfig + cron_status 记录"`

---

## Task 3: registry 纯助手(TDD)

**Files:** Create `backend/src/cron/registry.ts`、`backend/src/cron/registry.test.ts`;Modify `backend/src/cron/{nightly,meetings,shared-data}.ts`(导出 run 函数,供 registry import)

- [ ] **Step 0: 先导出 4 个 run 函数**(registry 要 import 它们)

`nightly.ts`:`async function runNightly` → `export async function runNightly`。
`meetings.ts`:`async function runMeetings` → `export async function runMeetings`。
`shared-data.ts`:`runStockUniverse` 与 `runEod` 都加 `export`。
（本步先只加 `export`,**不**动各文件的 `start*Cron`/`cron.schedule`——那些在 Task 5 删除。)

- [ ] **Step 1: 写失败测试 `registry.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cron-'));
const reg = require('./registry');

describe('timeToExpr / exprToTime', () => {
  it('converts HH:MM <-> daily cron', () => {
    expect(reg.timeToExpr('23:05')).toBe('5 23 * * *');
    expect(reg.timeToExpr('08:00')).toBe('0 8 * * *');
    expect(reg.exprToTime('5 23 * * *')).toBe('23:05');
    expect(reg.exprToTime('0 8 * * *')).toBe('08:00');
    expect(reg.exprToTime('*/5 * * * *')).toBeNull(); // 非每日
  });
  it('rejects bad time', () => {
    expect(() => reg.timeToExpr('25:00')).toThrow('BAD_TIME');
    expect(() => reg.timeToExpr('8:5')).toThrow('BAD_TIME');
    expect(() => reg.timeToExpr('abc')).toThrow('BAD_TIME');
  });
});

describe('nextRunAt (Asia/Shanghai daily)', () => {
  it('today if target still ahead, else tomorrow', () => {
    // 2026-06-10 10:00 Beijing == 2026-06-10T02:00:00Z
    const now = Date.UTC(2026, 5, 10, 2, 0, 0);
    expect(reg.nextRunAt('0 23 * * *', now)).toBe('2026-06-10T15:00:00.000Z'); // 今天 23:00 北京 = 15:00Z
    expect(reg.nextRunAt('0 8 * * *', now)).toBe('2026-06-11T00:00:00.000Z');  // 08:00 已过 → 明天 = 次日00:00Z
    expect(reg.nextRunAt('*/5 * * * *', now)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest cron/registry -i`。Expected: FAIL（模块/函数缺失）。

- [ ] **Step 3: 实现 `registry.ts` 纯助手部分**(先只写这些 + 导出,后续 Task 追加调度)

```ts
import cron from 'node-cron';
import { runNightly } from './nightly';
import { runMeetings } from './meetings';
import { runStockUniverse, runEod } from './shared-data';
import * as svc from '../data/service';
import { getJobLog } from '../data/service';

export interface CronJobDef { key: string; label: string; description: string; defaultExpr: string; run: () => Promise<void> | void; }
const TZ = 'Asia/Shanghai';

export const CRON_JOBS: CronJobDef[] = [
  { key: 'nightly', label: '夜间数据刷新', description: '清理日志/同步交易日历/刷新新闻+大盘+缓存个股', defaultExpr: '0 23 * * *', run: runNightly },
  { key: 'meeting_morning', label: '早会生成', description: '刷新大盘 + 为合格用户生成早会(休市跳过)', defaultExpr: '0 8 * * *', run: () => runMeetings('morning') },
  { key: 'meeting_evening', label: '晚会复盘', description: '刷新大盘 + 生成晚会(休市跳过)', defaultExpr: '45 16 * * *', run: () => runMeetings('evening') },
  { key: 'stock_universe', label: '股票库同步', description: '全量名单 diff 入库', defaultExpr: '25 9 * * *', run: () => runStockUniverse() },
  { key: 'eod', label: '行情 EOD 入库', description: '全量个股日线(首次365/之后增量)', defaultExpr: '0 1 * * *', run: () => runEod() },
];

export function timeToExpr(hhmm: string): string {
  const m = /^([0-9]{2}):([0-9]{2})$/.exec(hhmm);
  if (!m) throw new Error('BAD_TIME');
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error('BAD_TIME');
  return `${min} ${h} * * *`;
}

export function exprToTime(expr: string): string | null {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5 || p[2] !== '*' || p[3] !== '*' || p[4] !== '*') return null;
  if (!/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return null;
  const min = Number(p[0]), h = Number(p[1]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// 仅每日 'M H * * *' 算下次运行(Asia/Shanghai);非每日返回 null。
export function nextRunAt(expr: string, nowMs: number = Date.now()): string | null {
  const t = exprToTime(expr);
  if (!t) return null;
  const [h, min] = t.split(':').map(Number);
  const bj = new Date(nowMs + 8 * 3600 * 1000); // 把北京墙钟时间放进 UTC 字段
  const curMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const tgtMin = h * 60 + min;
  const deltaDays = tgtMin > curMin ? 0 : 1;
  const bjMidnight = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const runUtcMs = bjMidnight + deltaDays * 86400000 + tgtMin * 60000 - 8 * 3600 * 1000;
  return new Date(runUtcMs).toISOString();
}

export function effective(key: string): { expr: string; enabled: boolean } {
  const def = CRON_JOBS.find((j) => j.key === key)!;
  const o = svc.getCronConfig()[key] || {};
  return { expr: o.expr ?? def.defaultExpr, enabled: o.enabled ?? true };
}
```

- [ ] **Step 4: 运行确认通过** — `cd backend && npx jest cron/registry -i`。Expected: PASS（run 函数已在 Step 0 导出，import 不报错）。

- [ ] **Step 5: 提交** — `git add backend/src/cron/registry.ts backend/src/cron/registry.test.ts && git commit -m "feat(cron): registry 纯助手 timeToExpr/exprToTime/nextRunAt/effective"`

---

## Task 4: registry 追踪包装 + 状态/日志(TDD)

**Files:** Modify `backend/src/cron/registry.ts`、`backend/src/cron/registry.test.ts`

- [ ] **Step 1: 写失败测试**(追加)

```ts
describe('tracked wrapper', () => {
  it('records ok with duration', async () => {
    await reg.tracked('nightly', async () => { /* ok */ });
    const s = require('../data/service').getCronStatus('nightly');
    expect(s.last_status).toBe('ok');
    expect(s.run_count).toBeGreaterThanOrEqual(1);
  });
  it('swallows error and records it (does not throw)', async () => {
    await expect(reg.tracked('eod', async () => { throw new Error('kaboom'); })).resolves.toBeUndefined();
    const s = require('../data/service').getCronStatus('eod');
    expect(s.last_status).toBe('error');
    expect(s.last_error).toContain('kaboom');
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest cron/registry -i -t "tracked"`。Expected: FAIL。

- [ ] **Step 3: 实现 `tracked`**(加到 registry.ts)

```ts
export async function tracked(key: string, run: () => Promise<void> | void): Promise<void> {
  svc.recordCronStart(key);
  svc.jobLog(`cron:${key}`, 'info', '定时任务开始');
  const t0 = Date.now();
  try {
    await run();
    svc.recordCronFinish(key, 'ok', Date.now() - t0, null);
    svc.jobLog(`cron:${key}`, 'info', `完成（${Date.now() - t0}ms）`);
  } catch (e: any) {
    svc.recordCronFinish(key, 'error', Date.now() - t0, String(e?.message || e));
    svc.jobLog(`cron:${key}`, 'error', `失败：${String(e?.message || e)}`);
  }
}
```
> `svc.jobLog` 已存在(写 sync_log)。

- [ ] **Step 4: 运行确认通过** — `cd backend && npx jest cron/registry -i`。Expected: PASS。

- [ ] **Step 5: 提交** — `git add backend/src/cron/registry.ts backend/src/cron/registry.test.ts && git commit -m "feat(cron): tracked 包装(cron_status + sync_log,吞异常)"`

---

## Task 5: 重构 cron 文件 + startCrons/applyCronChange/runCronNow/listCronJobs

**Files:** Modify `backend/src/cron/{nightly,meetings,shared-data}.ts`、`backend/src/cron/registry.ts`、`backend/src/index.ts`

- [ ] **Step 1: 删每个文件的 start*Cron + cron 调度**（run 函数已在 Task 3 Step 0 导出）

`nightly.ts`:删 `import cron from 'node-cron'` 与整个 `startNightlyCron`。
`meetings.ts`:删 `import cron` 与 `startMeetingsCron`。
`shared-data.ts`:删 `import cron` 与 `startSharedDataCron`。
（各文件其它 import 与 run 函数体不动。）

- [ ] **Step 2: registry 加调度/管理函数**

```ts
const tasks = new Map<string, cron.ScheduledTask>();
let started = false;

export function startCrons(): void {
  if (process.env.ENABLE_CRON === 'false') return;
  started = true;
  for (const def of CRON_JOBS) reschedule(def.key);
  console.log('[cron] registry started:', CRON_JOBS.map((j) => j.key).join(', '));
}

function reschedule(key: string): void {
  if (!started) return; // 测试/未启动时不实际调度
  const old = tasks.get(key);
  if (old) { old.stop(); tasks.delete(key); }
  const def = CRON_JOBS.find((j) => j.key === key);
  if (!def) return;
  const { expr, enabled } = effective(key);
  if (!enabled || !cron.validate(expr)) return;
  tasks.set(key, cron.schedule(expr, () => { tracked(key, def.run); }, { timezone: TZ }));
}

export function listCronJobs(): { cronEnabled: boolean; jobs: any[] } {
  const cfg = svc.getCronConfig();
  const jobs = CRON_JOBS.map((def) => {
    const o = cfg[def.key] || {};
    const expr = o.expr ?? def.defaultExpr;
    const enabled = o.enabled ?? true;
    const st = svc.getCronStatus(def.key);
    return {
      key: def.key, label: def.label, description: def.description,
      expr, time: exprToTime(expr), enabled, timezone: TZ,
      lastRunAt: st?.last_run_at ?? null, lastStatus: st?.last_status ?? null,
      lastDurationMs: st?.last_duration_ms ?? null, lastError: st?.last_error ?? null,
      nextRunAt: enabled ? nextRunAt(expr) : null,
    };
  });
  return { cronEnabled: process.env.ENABLE_CRON !== 'false', jobs };
}

export function applyCronChange(key: string, input: { time?: string; enabled?: boolean }): void {
  if (!CRON_JOBS.find((j) => j.key === key)) throw new Error('UNKNOWN_JOB');
  const cfg = svc.getCronConfig();
  const o = { ...(cfg[key] || {}) };
  if (input.time !== undefined) o.expr = timeToExpr(input.time); // 非法 time 抛 BAD_TIME
  if (input.enabled !== undefined) o.enabled = input.enabled;
  cfg[key] = o;
  svc.setCronConfig(cfg);
  reschedule(key);
}

export function runCronNow(key: string): void {
  const def = CRON_JOBS.find((j) => j.key === key);
  if (!def) throw new Error('UNKNOWN_JOB');
  if (svc.getCronStatus(key)?.last_status === 'running') throw new Error('ALREADY_RUNNING');
  tracked(key, def.run); // fire-and-forget
}
```

- [ ] **Step 3: index.ts 换调用**

把 `index.ts` 第 97-99 行三个 require + 102-104 三处 `start*Cron()` 改为:
```ts
  const { startCrons } = require('./cron/registry');
```
(删掉 startNightlyCron/startMeetingsCron/startSharedDataCron 的 require)
并把 `startNightlyCron(); startMeetingsCron(); startSharedDataCron();` 三行换成 `startCrons();`。

- [ ] **Step 4: 编译 + 回归** — `cd backend && npx tsc --noEmit && npm test 2>&1 | tail -5`。Expected: tsc 0;全绿(registry 测试 + 原有,start*Cron 已无引用)。
> 若有别处 import `startNightlyCron` 等(grep 确认),一并改。

- [ ] **Step 5: 提交** — `git add backend/src/cron/ backend/src/index.ts && git commit -m "refactor(cron): 收敛为 registry 驱动的 startCrons(导出 run 函数,删 start*Cron)"`

---

## Task 6: routes/cron.ts(TDD)

**Files:** Create `backend/src/routes/cron.ts`、`backend/src/routes/cron.test.ts`;Modify `backend/src/index.ts`(挂载)

- [ ] **Step 1: 写失败测试 `cron.test.ts`**(仿 `routes/ai.test.ts` 的 admin/user token setup)

```ts
import path from 'path'; import os from 'os'; import fs from 'fs'; import request from 'supertest';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cronroute-'));
process.env.ENABLE_CRON = 'false';
delete process.env.REGISTRATION_MODE;
const { createApp } = require('../index');
const app = createApp();
let aTok = '', uTok = '';
beforeAll(async () => {
  aTok = (await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456', agreed: true })).body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${aTok}`);
  uTok = (await request(app).post('/api/auth/register').send({ username: 'cronu', password: 'secret123', inviteCode: inv.body.data.code, agreed: true })).body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('cron routes', () => {
  it('GET /api/cron requires admin', async () => {
    expect((await request(app).get('/api/cron').set(h(uTok))).status).toBe(403);
  });
  it('lists 5 jobs with cronEnabled flag', async () => {
    const r = await request(app).get('/api/cron').set(h(aTok));
    expect(r.status).toBe(200);
    expect(r.body.data.cronEnabled).toBe(false);
    expect(r.body.data.jobs.length).toBe(5);
    expect(r.body.data.jobs.find((j: any) => j.key === 'nightly').time).toBe('23:00');
  });
  it('PUT changes time + enabled', async () => {
    const r = await request(app).put('/api/cron/nightly').set(h(aTok)).send({ time: '23:30', enabled: false });
    expect(r.status).toBe(200);
    const list = await request(app).get('/api/cron').set(h(aTok));
    const n = list.body.data.jobs.find((j: any) => j.key === 'nightly');
    expect(n.time).toBe('23:30'); expect(n.enabled).toBe(false); expect(n.nextRunAt).toBeNull();
  });
  it('PUT rejects bad time 422 / unknown job 404', async () => {
    expect((await request(app).put('/api/cron/nightly').set(h(aTok)).send({ time: '99:99' })).status).toBe(422);
    expect((await request(app).put('/api/cron/nope').set(h(aTok)).send({ enabled: true })).status).toBe(404);
  });
  it('GET log + run (admin)', async () => {
    expect((await request(app).get('/api/cron/nightly/log').set(h(aTok))).status).toBe(200);
    expect((await request(app).post('/api/cron/nightly/run').set(h(uTok))).status).toBe(403);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest routes/cron -i`。Expected: FAIL（404，未挂载）。

- [ ] **Step 3: 实现 `routes/cron.ts`**

```ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { listCronJobs, applyCronChange, runCronNow, CRON_JOBS } from '../cron/registry';
import { getJobLog } from '../data/service';

const router = Router();
router.use(authMiddleware, adminMiddleware);

router.get('/', (_req: Request, res: Response) => successResponse(res, listCronJobs()));

router.put('/:key', (req: Request, res: Response) => {
  const parsed = z.object({ time: z.string().optional(), enabled: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    applyCronChange(req.params.key, parsed.data);
    const job = listCronJobs().jobs.find((j) => j.key === req.params.key);
    successResponse(res, job);
  } catch (e: any) {
    if (e.message === 'UNKNOWN_JOB') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知定时任务');
    if (e.message === 'BAD_TIME') return errorResponse(res, 422, 'VALIDATION_ERROR', '时间格式应为 HH:MM');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '操作失败');
  }
});

router.post('/:key/run', (req: Request, res: Response) => {
  try {
    runCronNow(req.params.key);
    successResponse(res, { started: true });
  } catch (e: any) {
    if (e.message === 'UNKNOWN_JOB') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知定时任务');
    if (e.message === 'ALREADY_RUNNING') return errorResponse(res, 409, 'JOB_LOCKED', '该任务正在运行');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '操作失败');
  }
});

router.get('/:key/log', (req: Request, res: Response) => {
  if (!CRON_JOBS.find((j) => j.key === req.params.key)) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知定时任务');
  successResponse(res, getJobLog(`cron:${req.params.key}`));
});

export default router;
```

- [ ] **Step 4: 挂载** — `backend/src/index.ts` 在其它 `app.use('/api/...')` 处加:
```ts
  app.use('/api/cron', require('./routes/cron').default);
```
(放在 createApp 内挂路由的区域,与现有 `/api/data` 等并列。实现时 grep `app.use('/api/data'` 找到位置。)

- [ ] **Step 5: 运行确认通过 + 回归** — `cd backend && npx jest routes/cron -i && npm test 2>&1 | tail -5`。Expected: 全绿。

- [ ] **Step 6: 提交** — `git add backend/src/routes/cron.ts backend/src/routes/cron.test.ts backend/src/index.ts && git commit -m "feat(api): /api/cron list/put/run/log(admin)"`

---

## Task 7: 前端 api/cron.ts

**Files:** Create `frontend/src/api/cron.ts`

- [ ] **Step 1: 实现**

```ts
import api from './client';

export interface CronJob {
  key: string; label: string; description: string;
  expr: string; time: string | null; enabled: boolean; timezone: string;
  lastRunAt: string | null; lastStatus: string | null; lastDurationMs: number | null; lastError: string | null;
  nextRunAt: string | null;
}
export interface CronList { cronEnabled: boolean; jobs: CronJob[] }

export const cronApi = {
  list: () => api.get<{ data: CronList }>('/cron').then((r) => r.data.data),
  update: (key: string, body: { time?: string; enabled?: boolean }) => api.put(`/cron/${key}`, body).then((r) => r.data.data as CronJob),
  runNow: (key: string) => api.post(`/cron/${key}/run`).then((r) => r.data),
  log: (key: string) => api.get(`/cron/${key}/log`).then((r) => r.data.data as Array<{ ts: string; level: string; message: string }>),
};
```

- [ ] **Step 2: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 提交** — `git add frontend/src/api/cron.ts && git commit -m "feat(api): cronApi"`

---

## Task 8: 前端 CronsView.vue + HomeView 菜单(admin-only)

**Files:** Create `frontend/src/views/CronsView.vue`;Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: HomeView 菜单加 admin-only 项**

`HomeView.vue` import 区加:`import CronsView from './CronsView.vue';`
`SETTINGS` 数组加一项(`account` 之前):`{ key: 'crons', label: '定时任务', icon: '⏰', comp: CronsView, adminOnly: true },`
模板里菜单 `v-for="s in SETTINGS"` 改为 `v-for="s in settingsMenu"`,并加 computed:
```ts
const settingsMenu = computed(() => SETTINGS.filter((s: any) => !s.adminOnly || auth.isAdmin));
```
（`auth` 已在 HomeView 存在。）

- [ ] **Step 2: CronsView.vue**

```vue
<template>
  <div class="crons">
    <h2>定时任务</h2>
    <p v-if="!cronEnabled" class="err">⚠️ 定时未全局启用（ENABLE_CRON=false），以下配置将在启用后生效。</p>
    <table class="ctable">
      <thead><tr><th>任务</th><th>每天时间</th><th>启用</th><th>最后运行</th><th>下次运行</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="j in jobs" :key="j.key">
          <td><b>{{ j.label }}</b><div class="muted">{{ j.description }}</div></td>
          <td>
            <template v-if="j.time !== null">
              <input type="time" v-model="edit[j.key]" /> <button @click="saveTime(j)">保存</button>
            </template>
            <span v-else class="muted">自定义({{ j.expr }})</span>
          </td>
          <td><input type="checkbox" :checked="j.enabled" @change="toggle(j, ($event.target as HTMLInputElement).checked)" /></td>
          <td>
            <span v-if="j.lastRunAt">{{ fmtCN(j.lastRunAt) }}
              <span :class="j.lastStatus === 'error' ? 'err' : j.lastStatus === 'running' ? 'muted' : 'okmsg'">
                {{ j.lastStatus === 'ok' ? '✅' : j.lastStatus === 'error' ? '❌' : '⏳' }}{{ j.lastDurationMs != null ? ` ${j.lastDurationMs}ms` : '' }}
              </span>
            </span><span v-else class="muted">从未</span>
            <div v-if="j.lastError" class="err">{{ j.lastError }}</div>
          </td>
          <td>{{ j.nextRunAt ? fmtCN(j.nextRunAt) : '—' }}</td>
          <td>
            <button @click="runNow(j)" :disabled="j.lastStatus === 'running'">立即运行</button>
            <button @click="showLog(j)">日志</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="msg" :class="msgOk ? 'okmsg' : 'err'">{{ msg }}</p>
    <div v-if="logKey" class="logbox">
      <h3>{{ logKey }} 日志 <button @click="logKey = null">关闭</button></h3>
      <div v-for="(l, i) in logLines" :key="i" :class="l.level === 'error' ? 'err' : 'muted'">{{ fmtCN(l.ts) }} [{{ l.level }}] {{ l.message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import { cronApi, type CronJob } from '../api/cron';
import { fmtCN } from '../utils/time';

const jobs = ref<CronJob[]>([]);
const cronEnabled = ref(true);
const edit = reactive<Record<string, string>>({});
const msg = ref(''); const msgOk = ref(false);
const logKey = ref<string | null>(null);
const logLines = ref<Array<{ ts: string; level: string; message: string }>>([]);
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  const d = await cronApi.list();
  cronEnabled.value = d.cronEnabled;
  jobs.value = d.jobs;
  for (const j of d.jobs) if (j.time) edit[j.key] = j.time;
}
async function saveTime(j: CronJob) {
  try { await cronApi.update(j.key, { time: edit[j.key] }); msgOk.value = true; msg.value = `${j.label} 已改为每天 ${edit[j.key]}`; await load(); }
  catch (e: any) { msgOk.value = false; msg.value = e.response?.data?.message || '保存失败'; }
}
async function toggle(j: CronJob, enabled: boolean) {
  try { await cronApi.update(j.key, { enabled }); msgOk.value = true; msg.value = `${j.label} 已${enabled ? '启用' : '停用'}`; await load(); }
  catch (e: any) { msgOk.value = false; msg.value = e.response?.data?.message || '操作失败'; }
}
async function runNow(j: CronJob) {
  try { await cronApi.runNow(j.key); msgOk.value = true; msg.value = `${j.label} 已触发`; setTimeout(load, 800); }
  catch (e: any) { msgOk.value = false; msg.value = e.response?.data?.message || '触发失败'; }
}
async function showLog(j: CronJob) { logKey.value = j.key; logLines.value = await cronApi.log(j.key); }

onMounted(async () => { await load(); timer = setInterval(() => { if (jobs.value.some((j) => j.lastStatus === 'running')) load(); }, 1500); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.crons { max-width: 960px; }
.ctable { width: 100%; border-collapse: collapse; }
.ctable th, .ctable td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
.okmsg { color: var(--accent, #2a8a2a); }
.err { color: #e5484d; }
.muted { color: #888; font-size: 12px; }
.logbox { margin-top: 12px; font-family: monospace; font-size: 12px; }
</style>
```
> `fmtCN` 来自 `frontend/src/utils/time.ts`(已存在,锁 Asia/Shanghai)。

- [ ] **Step 3: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 4: 提交** — `git add frontend/src/views/CronsView.vue frontend/src/views/HomeView.vue && git commit -m "feat(cron-ui): CronsView 列表/改时间/启停/立即运行/日志(admin 菜单)"`

---

## 端到端验证

1. `cd backend && npm test` 全绿;`cd frontend && npx vue-tsc --noEmit` exit 0。
2. `docker compose up -d --build`,admin 登录 → 菜单见「⏰ 定时任务」(普通用户不可见)。
3. 列表显示 5 个任务 + 默认时间;改某任务时间→保存→`GET /api/cron` 该任务 time 变;停用→nextRunAt 变 —;「立即运行」nightly→几秒后最后运行变 ✅ + 有日志;普通用户 `GET /api/cron` → 403。

## 风险 / 注意
- `reschedule` 仅在 `started`(startCrons 已跑、ENABLE_CRON≠false)时实际操作 node-cron;测试 NODE_ENV 下 ENABLE_CRON=false → 不调度,只测配置/状态/路由逻辑。
- run 函数现在被 registry import;确保删 start*Cron 后无其它引用(grep `startNightlyCron|startMeetingsCron|startSharedDataCron`)。
- 「立即运行」对数据类任务(stock_universe/eod)仍受其自身 running 守卫;cron_status 的 running 判断防 cron 触发重复。
- 时区:全 Asia/Shanghai;nextRunAt 已按北京算;前端 fmtCN 锁北京显示。
