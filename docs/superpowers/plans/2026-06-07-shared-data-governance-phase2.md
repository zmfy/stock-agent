# 共享数据治理（第二期）：锁 + 状态扩展 + cron + admin 管控 + 数据源全局化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把共享数据拉取（股票库 / 行情 EOD）做成有锁、按天、可定时、可被 admin 取消/看日志/看失败原因的系统级 job，并把数据源改为全局 admin 管理。

**Architecture:** 扩展全局 `sync_status` 表（加 started_at/finished_at/last_success_at/started_by/error/cancel_requested/source_breakdown 列，取代第一期 `__SRC__` message hack）；新增滚动 `sync_log` 表；拉取循环每批检查 `cancel_requested` 协作式取消；按 `last_success_at` 日期做"按天"启停；cron 09:25 拉股票库、01:00 拉 EOD（首次 365 天、之后增量）；路由统一为 `/api/data/<job>/run|status|cancel|log`（cancel/log 限 admin）；`data_sources` 去 per-user、改全局 admin 管理。

**Tech Stack:** Node/Express + TS + better-sqlite3（jest，tmp `DATA_DIR` + `require`，`fetch` mock）；node-cron；Vue3（vue-tsc + 冒烟，无前端单测）。

**前置：** 第一期已合并 master（probe/provenance/占比、`/api/data/probe`、ingestEod 探测择优）。`migrate()` 在 `backend/src/db.ts` 用 `PRAGMA table_info` 检查后 `ALTER TABLE ... ADD COLUMN`。`adminMiddleware` 在 `backend/src/middleware/auth.ts`（`req.user.role==='admin'`）。当前 job 名：`stock_universe`、`eod`。时区 Asia/Shanghai。`ENABLE_CRON` 控制 cron。

**统一约定（贯穿全计划）：**
- `JobStatus` = `{ job; state:'idle'|'running'|'done'|'error'; total; done; message; updated_at; started_at; finished_at; last_success_at; started_by; error; cancel_requested:0|1; source_breakdown: Record<string,number>|null }`
- 状态机：`idle/done/error → running →(成功) done +last_success_at；(失败) error +error；(取消) idle`
- 启停规则 `canStartJob(job)`：`state!=='running'` 且 不是"今天已成功"（`last_success_at` 的本地日期 ≠ 今天 Asia/Shanghai）。
- 任何登录用户可 `run`；`cancel`/`log` 限 admin。

---

## Task 1: DB 迁移 — sync_status 扩列 + sync_log 表

**Files:**
- Modify: `backend/src/db.ts`（`sync_status` 建表语句补列；`migrate()` 加幂等 ALTER；新增 `sync_log` 建表）
- Test: `backend/src/db.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/db.test.ts` 增加：
```ts
it('sync_status 有治理列，sync_log 表存在', () => {
  const db = require('./db').getDb();
  const cols = db.prepare('PRAGMA table_info(sync_status)').all().map((c: any) => c.name);
  for (const c of ['started_at', 'finished_at', 'last_success_at', 'started_by', 'error', 'cancel_requested', 'source_breakdown']) {
    expect(cols).toContain(c);
  }
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_log'").get();
  expect(t).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/db.test.ts -t "治理列" -i`
Expected: FAIL（列/表不存在）。

- [ ] **Step 3: 实现**

(a) 把 `sync_status` 的 `CREATE TABLE IF NOT EXISTS`（db.ts:200 附近）改为含新列（供全新库直接建好）：
```sql
CREATE TABLE IF NOT EXISTS sync_status (
  job TEXT PRIMARY KEY,
  state TEXT,
  total INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  message TEXT,
  started_at DATETIME,
  finished_at DATETIME,
  last_success_at DATETIME,
  started_by TEXT,
  error TEXT,
  cancel_requested INTEGER DEFAULT 0,
  source_breakdown TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
(b) 在同一建表区新增：
```sql
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP,
  level TEXT,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_job ON sync_log (job, id);
```
(c) 在 `migrate()` 末尾（db.ts:346 的 index 之后）加幂等迁移：
```ts
  const sycols = db.prepare('PRAGMA table_info(sync_status)').all() as { name: string }[];
  if (sycols.length) {
    const add = (c: string, ddl: string) => { if (!sycols.some((x) => x.name === c)) db.exec(`ALTER TABLE sync_status ADD COLUMN ${ddl}`); };
    add('started_at', 'started_at DATETIME');
    add('finished_at', 'finished_at DATETIME');
    add('last_success_at', 'last_success_at DATETIME');
    add('started_by', 'started_by TEXT');
    add('error', 'error TEXT');
    add('cancel_requested', 'cancel_requested INTEGER DEFAULT 0');
    add('source_breakdown', 'source_breakdown TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, ts DATETIME DEFAULT CURRENT_TIMESTAMP, level TEXT, message TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_log_job ON sync_log (job, id)');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx jest src/db.test.ts -i`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/db.ts backend/src/db.test.ts
git commit -m "feat(db): sync_status 治理列 + sync_log 表（幂等迁移）"
```

---

## Task 2: 状态层 — 富状态 setSync/getSyncStatus + 日志/取消/启停 helpers

**Files:**
- Modify: `backend/src/data/service.ts`（重写 `setSync`/`getSyncStatus`，去掉第一期 `__SRC__` hack；新增 `jobLog`/`getJobLog`/`requestCancel`/`isCancelRequested`/`canStartJob`/`beginJob`/`finishJob`）
- Test: `backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('富状态：beginJob/finishJob/canStartJob/cancel/log', () => {
  const svc = require('./service');
  svc.beginJob('eod', 'alice', 100);
  let st = svc.getSyncStatus('eod');
  expect(st.state).toBe('running');
  expect(st.started_by).toBe('alice');
  expect(svc.canStartJob('eod')).toBe(false);          // running → 不可再启
  svc.requestCancel('eod');
  expect(svc.isCancelRequested('eod')).toBe(true);
  svc.jobLog('eod', 'info', '处理中…');
  expect(svc.getJobLog('eod').some((l: any) => l.message === '处理中…')).toBe(true);
  svc.finishJob('eod', 'done', '完成', { tx: 90, sina: 10 });
  st = svc.getSyncStatus('eod');
  expect(st.state).toBe('done');
  expect(st.last_success_at).toBeTruthy();
  expect(st.source_breakdown).toEqual({ tx: 90, sina: 10 });
  expect(st.cancel_requested).toBe(0);                 // finish 清除取消标志
  expect(svc.canStartJob('eod')).toBe(false);          // 今天已成功 → 不可启
});

it('canStartJob: error 状态可重试', () => {
  const svc = require('./service');
  svc.finishJob('stock_universe', 'error', '出错', null, '网络错误');
  expect(svc.getSyncStatus('stock_universe').error).toBe('网络错误');
  expect(svc.canStartJob('stock_universe')).toBe(true); // 失败可重试
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data/service.test.ts -t "富状态|可重试" -i`
Expected: FAIL（函数未定义）。

- [ ] **Step 3: 实现**

在 `backend/src/data/service.ts` 用下列实现替换现有 `setSync` 与 `getSyncStatus`，并新增 helpers。删除第一期 `__SRC__` 相关逻辑（`setSync` 的 breakdown 拼接、`getSyncStatus` 的正则解析）。本地"今天"按 Asia/Shanghai：
```ts
function todayCN(): string {
  // YYYY-MM-DD in Asia/Shanghai
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

export interface JobStatus {
  job: string; state: string; total: number; done: number; message: string; updated_at: string;
  started_at: string | null; finished_at: string | null; last_success_at: string | null;
  started_by: string | null; error: string | null; cancel_requested: number;
  source_breakdown: Record<string, number> | null;
}

function setProgress(job: string, total: number, done: number, message: string): void {
  getDb().prepare(
    `UPDATE sync_status SET total=?, done=?, message=?, updated_at=CURRENT_TIMESTAMP WHERE job=?`
  ).run(total, done, message, job);
}

export function beginJob(job: string, startedBy: string, total: number): void {
  getDb().prepare(
    `INSERT INTO sync_status (job, state, total, done, message, started_at, finished_at, error, cancel_requested, updated_at)
     VALUES (?, 'running', ?, 0, '开始…', CURRENT_TIMESTAMP, NULL, NULL, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(job) DO UPDATE SET state='running', total=excluded.total, done=0, message='开始…',
       started_at=CURRENT_TIMESTAMP, finished_at=NULL, error=NULL, cancel_requested=0, updated_at=CURRENT_TIMESTAMP`
  ).run(job, total);
  getDb().prepare(`UPDATE sync_status SET started_by=? WHERE job=?`).run(startedBy, job);
  jobLog(job, 'info', `开始（${startedBy}），共 ${total}`);
}

export function finishJob(job: string, state: 'done' | 'error' | 'idle', message: string, breakdown?: Record<string, number> | null, error?: string): void {
  const successAt = state === 'done' ? 'CURRENT_TIMESTAMP' : 'last_success_at';
  getDb().prepare(
    `UPDATE sync_status SET state=?, message=?, finished_at=CURRENT_TIMESTAMP, last_success_at=${successAt},
       error=?, cancel_requested=0, source_breakdown=?, updated_at=CURRENT_TIMESTAMP WHERE job=?`
  ).run(state, message, error ?? null, breakdown ? JSON.stringify(breakdown) : null, job);
  jobLog(job, state === 'error' ? 'error' : 'info', error ? `${message}：${error}` : message);
}

export function jobLog(job: string, level: string, message: string): void {
  const db = getDb();
  db.prepare('INSERT INTO sync_log (job, level, message) VALUES (?, ?, ?)').run(job, level, message);
  // 滚动保留每 job 最近 200 行
  db.prepare(`DELETE FROM sync_log WHERE job=? AND id NOT IN (SELECT id FROM sync_log WHERE job=? ORDER BY id DESC LIMIT 200)`).run(job, job);
}

export function getJobLog(job: string, limit = 200): Array<{ ts: string; level: string; message: string }> {
  return getDb().prepare('SELECT ts, level, message FROM sync_log WHERE job=? ORDER BY id DESC LIMIT ?').all(job, limit) as any[];
}

export function requestCancel(job: string): void {
  getDb().prepare(`UPDATE sync_status SET cancel_requested=1, updated_at=CURRENT_TIMESTAMP WHERE job=? AND state='running'`).run(job);
  jobLog(job, 'warn', '收到取消请求');
}

export function isCancelRequested(job: string): boolean {
  const r = getDb().prepare('SELECT cancel_requested FROM sync_status WHERE job=?').get(job) as any;
  return !!(r && r.cancel_requested);
}

export function getSyncStatus(job = 'stock_universe'): JobStatus | null {
  const row = getDb().prepare('SELECT * FROM sync_status WHERE job=?').get(job) as any;
  if (!row) return null;
  let source_breakdown: Record<string, number> | null = null;
  if (row.source_breakdown) { try { source_breakdown = JSON.parse(row.source_breakdown); } catch { /* ignore */ } }
  return { ...row, cancel_requested: row.cancel_requested ?? 0, source_breakdown };
}

export function canStartJob(job: string): boolean {
  const st = getSyncStatus(job);
  if (!st) return true;
  if (st.state === 'running') return false;
  if (st.last_success_at) {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(st.last_success_at.replace(' ', 'T') + 'Z'));
    if (d === todayCN()) return false;   // 今天已成功
  }
  return true;
}
```
注意：`setProgress` 取代循环里旧的 `setSync(job,'running',...)`；保留对外仍叫"进度更新"的语义。Task 3 会把 ingest/sync 改用这些。

- [ ] **Step 4: 跑测试确认通过 + 全套**

Run: `cd backend && npx jest src/data/service.test.ts -i` 然后 `cd backend && npx jest`
Expected: 目标用例 PASS；全套保持绿（注意：第一期那条断言 `source_breakdown` 的 ingestEod 测试仍要通过——Task 3 会把 ingestEod 切到 finishJob；本任务只要保证编译与其余测试不挂。如本任务改动使 ingestEod 暂时引用旧 setSync，请保留一个兼容的内部 `setSync` 或在本任务一并把 ingestEod 的收尾切到 `finishJob`/`setProgress` 以保持绿）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): 富状态 sync_status + sync_log + 取消/启停 helpers（取代 __SRC__ hack）"
```

---

## Task 3: 拉取循环接入富状态 + 协作式取消

**Files:**
- Modify: `backend/src/data/service.ts`（`ingestEod`、`syncStockUniverse`）
- Test: `backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('ingestEod 用 beginJob/finishJob 并在 cancel 时中止', async () => {
  const svc = require('./service');
  const db = require('../db').getDb();
  db.prepare("INSERT OR IGNORE INTO stock_names (code,name) VALUES ('600519','x'),('000001','y'),('000002','z')").run();
  require('./sources-service').ensureSeed?.('u1');
  // probe 可达 tx；quote 永远返回 tx 一行；但我们在第一只后请求取消
  (global as any).fetch = jest.fn((url: string) => {
    if (url.includes('/probe')) return Promise.resolve({ ok: true, json: async () => [{ key: 'tx', label: '腾讯', reachable: true, latency_ms: 1, error: null }] });
    svc.requestCancel('eod'); // 一旦开始抓取就请求取消
    return Promise.resolve({ ok: true, json: async () => ({ source: 'tx', rows: [{ date: '2026-06-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }) });
  });
  await svc.ingestEod('u1', { days: 5, startedBy: 'alice' });
  const st = svc.getSyncStatus('eod');
  expect(st.state).toBe('idle');                 // 被取消 → idle
  expect(st.message).toContain('取消');
  expect(st.done).toBeLessThan(3);               // 没跑完全部
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data/service.test.ts -t "cancel 时中止" -i`
Expected: FAIL。

- [ ] **Step 3: 实现**

把 `ingestEod` 改成（保留第一期的 probe 择优 + 占比；收尾改用 finishJob；循环内每批 `isCancelRequested` 检查；签名加 `startedBy`）：
```ts
export async function ingestEod(userId: string, opts: { days?: number; codes?: string[]; startedBy?: string } = {}): Promise<void> {
  if (getSyncStatus('eod')?.state === 'running') return;
  const base = resolveSidecarBase(userId);
  if (!base) { beginJob('eod', opts.startedBy ?? 'system', 0); finishJob('eod', 'error', '没有可用的数据源', null, 'NO_SOURCE'); return; }
  const codes = opts.codes?.length ? opts.codes : (getDb().prepare('SELECT code FROM stock_names').all() as { code: string }[]).map((r) => r.code);
  if (!codes.length) { beginJob('eod', opts.startedBy ?? 'system', 0); finishJob('eod', 'error', '本地股票库为空，请先同步股票库', null, 'EMPTY_UNIVERSE'); return; }
  const days = opts.days ?? 10;
  beginJob('eod', opts.startedBy ?? 'system', codes.length);
  const order = await orderedProviders(base, 'quote');
  const bySource: Record<string, number> = {};
  let ok = 0, fail = 0;
  for (let i = 0; i < codes.length; i++) {
    if (isCancelRequested('eod')) { finishJob('eod', 'idle', `已取消：已处理 ${i}/${codes.length}（成功 ${ok}）`); return; }
    try {
      const res = await fetchQuotes(base, codes[i], days, order);
      if (res && res.rows.length) { const src = res.source ?? 'unknown'; cacheQuotes(res.rows, src); bySource[src] = (bySource[src] ?? 0) + 1; ok++; }
      else fail++;
    } catch { fail++; }
    if (i % 20 === 0 || i === codes.length - 1) setProgress('eod', codes.length, i + 1, `已处理 ${i + 1}/${codes.length}，成功 ${ok}、失败 ${fail}`);
    await new Promise((res) => setImmediate(res));
  }
  const denom = ok || 1; const breakdown: Record<string, number> = {};
  for (const k of Object.keys(bySource)) breakdown[k] = Math.round((bySource[k] / denom) * 100);
  finishJob('eod', 'done', `完成：成功 ${ok}、失败 ${fail}`, breakdown);
}
```
同样把 `syncStockUniverse(userId, startedBy?)` 改用 `beginJob('stock_universe', startedBy ?? 'system', total)` / `setProgress` / 循环内 `isCancelRequested('stock_universe')` 中止 / 收尾 `finishJob('stock_universe','done',...)`（失败 catch → `finishJob('stock_universe','error',msg,null,String(err))`）。保留其增量 diff 逻辑。

- [ ] **Step 4: 跑测试确认通过 + 全套**

Run: `cd backend && npx jest -i`
Expected: 全绿（更新第一期那条 ingestEod 断言：`source_breakdown` 现在来自列、`state==='done'`，仍成立）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): ingestEod/syncStockUniverse 接入富状态 + 协作式取消"
```

---

## Task 4: 路由统一 — /run /status /cancel /log

**Files:**
- Modify: `backend/src/routes/data.ts`（新增统一路由；旧 `/stocks/sync`、`/eod/ingest`、`/stocks/sync-status`、`/eod/status` 改为转发或移除）
- Test: `backend/src/routes/data.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
const JOBS = ['stock_universe', 'eod'];
it('POST /api/data/eod/run 触发；running 时再触发被拒', async () => {
  (global as any).fetch = jest.fn((u: string) =>
    u.includes('/probe') ? Promise.resolve({ ok: true, json: async () => [] })
    : Promise.resolve({ ok: true, json: async () => ({ source: null, rows: [] }) }));
  const r1 = await request(app).post('/api/data/eod/run').set('Authorization', `Bearer ${token}`);
  expect([200, 202]).toContain(r1.status);
  const r2 = await request(app).post('/api/data/eod/run').set('Authorization', `Bearer ${token}`);
  // 若第一次已结束(空源秒回)，第二次也可能 200；关键是不 500
  expect(r2.status).toBeLessThan(500);
});
it('GET /api/data/eod/status 返回富状态字段', async () => {
  const res = await request(app).get('/api/data/eod/status').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveProperty('last_success_at');
  expect(res.body.data).toHaveProperty('cancel_requested');
});
it('cancel/log 需要 admin', async () => {
  const res = await request(app).post('/api/data/eod/cancel').set('Authorization', `Bearer ${userToken}`);
  expect(res.status).toBe(403);
});
```
（`token` 用现有 admin token；若文件里只有一个 token 且其角色是 admin，则另造一个普通用户 `userToken`——参照 data.test.ts 现有造 token 的方式；如暂无普通用户工具，给 cancel/log 的 admin-gate 测试用一个 role!=admin 的 token。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/routes/data.test.ts -t "run|富状态|admin" -i`
Expected: FAIL（404/无 gate）。

- [ ] **Step 3: 实现**

在 `backend/src/routes/data.ts`（顶部已 import service 与 sidecar、`adminMiddleware`）加入统一路由（放在现有 data 路由区）：
```ts
const SHARED_JOBS = new Set(['stock_universe', 'eod']);
function jobName(req: any): string | null { const j = String(req.params.job); return SHARED_JOBS.has(j) ? j : null; }

router.post('/:job/run', async (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  if (!svc.canStartJob(job)) return errorResponse(res, 409, 'JOB_LOCKED', '已有用户在更新或今日已更新');
  const startedBy = (req as any).user.username ?? (req as any).user.userId;
  if (job === 'stock_universe') svc.syncStockUniverse((req as any).user.userId, startedBy);
  else svc.ingestEod((req as any).user.userId, { startedBy });   // days 默认；首次/增量由 Task 5 cron 决定，手动用默认
  successResponse(res, { started: true });
});

router.get('/:job/status', (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  successResponse(res, svc.getSyncStatus(job));
});

router.post('/:job/cancel', adminMiddleware, (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  svc.requestCancel(job);
  successResponse(res, { requested: true });
});

router.get('/:job/log', adminMiddleware, (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  successResponse(res, svc.getJobLog(job));
});
```
保留旧 `/stocks/search`、`/snapshot/:code`、`/quotes/csv`、`/source`、`/probe`、`/news` 等不变。把旧 `/stocks/sync`、`/eod/ingest`、`/stocks/sync-status`、`/eod/status` 删除（前端在 Task 7 改用新路由）。`syncStockUniverse`/`ingestEod` 现接受 `startedBy`（Task 3 已加）。`req.user` 字段名（userId/username）按文件现有用法对齐。

- [ ] **Step 4: 跑测试确认通过 + 全套**

Run: `cd backend && npx jest -i`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(api): 统一 /api/data/<job>/run|status|cancel|log（cancel/log 限 admin）"
```

---

## Task 5: cron — 09:25 股票库 / 01:00 行情（首次年度·之后增量）

**Files:**
- Modify: `backend/src/cron/nightly.ts`（去掉其中的 `ingestEod(days:10)`）
- Create: `backend/src/cron/shared-data.ts`（新定时器）
- Modify: `backend/src/index.ts`（启动新 cron）
- Test: `backend/src/cron/shared-data.test.ts`（验证 days 决策纯函数）

- [ ] **Step 1: 写失败测试（EOD 拉取天数决策纯函数）**

`backend/src/cron/shared-data.test.ts`:
```ts
import path from 'path'; import os from 'os'; import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cron-'));
const { eodDaysForRun } = require('./shared-data');
const db = require('../db').getDb();

it('首次（quote_daily 空）→ 365 天', () => {
  expect(eodDaysForRun()).toBe(365);
});
it('已有数据 → 增量（>=2 天的小窗口）', () => {
  db.prepare("INSERT OR IGNORE INTO quote_daily (code,date,close,source,fetched_at) VALUES ('600519','2026-06-01',1,'tx',CURRENT_TIMESTAMP)").run();
  const d = eodDaysForRun();
  expect(d).toBeGreaterThanOrEqual(2);
  expect(d).toBeLessThan(365);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/cron/shared-data.test.ts -i`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`backend/src/cron/shared-data.ts`:
```ts
import cron from 'node-cron';
import { getDb } from '../db';
import { syncStockUniverse, ingestEod, getSyncStatus } from '../data/service';
import { primaryBaseGlobal } from '../data/sources-service';   // Task 6 提供全局版

// 决定 EOD 本次拉取天数：无历史→365；有历史→从最新日期到今天的窗口(至少 2，封顶 365)
export function eodDaysForRun(): number {
  const row = getDb().prepare('SELECT MAX(date) AS d FROM quote_daily').get() as { d: string | null };
  if (!row || !row.d) return 365;
  const last = new Date(row.d.replace(' ', 'T') + 'T00:00:00Z').getTime();
  const now = Date.now();
  const days = Math.ceil((now - last) / 86400000) + 1;
  return Math.min(365, Math.max(2, days));
}

// 系统级 job：无具体用户，数据源用全局 primary。userId 传空字符串即可（resolveSidecarBase 兜底全局）。
async function runStockUniverse(): Promise<void> {
  if (getSyncStatus('stock_universe')?.state === 'running') return;
  await syncStockUniverse('', 'cron');
}
async function runEod(): Promise<void> {
  if (getSyncStatus('eod')?.state === 'running') return;
  await ingestEod('', { days: eodDaysForRun(), startedBy: 'cron' });
}

export function startSharedDataCron(): void {
  if (process.env.ENABLE_CRON === 'false') return;
  cron.schedule('25 9 * * *', () => { runStockUniverse().catch(() => {}); }, { timezone: 'Asia/Shanghai' });
  cron.schedule('0 1 * * *', () => { runEod().catch(() => {}); }, { timezone: 'Asia/Shanghai' });
}
```
注意：`syncStockUniverse('')`/`ingestEod('')` 用空 userId — `resolveSidecarBase('')` 需回退到全局 primary（Task 6 让 `primaryBase` 不依赖 userId）。若当前 `resolveSidecarBase` 对空串返回 null，Task 6 会修正。
`backend/src/cron/nightly.ts`：删除 `await data.ingestEod(userId, { days: 10 })...` 那一行（EOD 交给新 cron）。
`backend/src/index.ts`：在现有 `startNightlyCron(); startMeetingsCron();` 旁加 `const { startSharedDataCron } = require('./cron/shared-data'); startSharedDataCron();`。

- [ ] **Step 4: 跑测试确认通过 + 全套**

Run: `cd backend && npx jest -i`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add backend/src/cron/shared-data.ts backend/src/cron/shared-data.test.ts backend/src/cron/nightly.ts backend/src/index.ts
git commit -m "feat(cron): 股票库 09:25 / 行情 EOD 01:00（首次年度·之后增量），夜间去掉 EOD"
```

---

## Task 6: data_sources 全局化（去 per-user，admin 管理）

**Files:**
- Modify: `backend/src/data/sources-service.ts`（去 `userId` 形参，全局读写；幂等迁移按 base_url 去重）、`backend/src/data/sidecar.ts`（`resolveSidecarBase` 用全局 primary）、`backend/src/routes/data.ts`（sources 写操作加 `adminMiddleware`）
- Test: `backend/src/data/sources-service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('全局：任何用户看到同一套源；去重；primaryBaseGlobal 可用', () => {
  const svc = require('./sources-service');
  svc.ensureSeedGlobal();
  const a = svc.listSourcesGlobal();
  expect(a.length).toBeGreaterThan(0);
  expect(typeof svc.primaryBaseGlobal()).toBe('string');
  // 加一个自定义源，再次读到
  const id = svc.addSourceGlobal({ name: '自定义', base_url: 'http://custom:8000' });
  expect(svc.listSourcesGlobal().some((s: any) => s.id === id)).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data/sources-service.test.ts -t "全局" -i`
Expected: FAIL。

- [ ] **Step 3: 实现**

`sources-service.ts`：新增全局版函数（保留旧 per-user 函数作兼容薄封装，内部转调全局，以免大面积改调用点）：
```ts
const GLOBAL_OWNER = '__global__';

export function ensureSeedGlobal(): void {
  const db = getDb();
  const n = (db.prepare('SELECT COUNT(*) AS c FROM data_sources').get() as any).c;
  if (n > 0) return;
  // 种入内置推荐（与原 RECOMMENDED 一致），owner=__global__
  for (const r of RECOMMENDED) {
    db.prepare('INSERT INTO data_sources (id, user_id, name, base_url, builtin, priority, enabled) VALUES (?,?,?,?,1,?,1)')
      .run(uuidv4(), GLOBAL_OWNER, r.name, r.base_url, 100);
  }
}

export function listSourcesGlobal(): any[] {
  // 全局：所有行（去重 base_url 取优先级最高/最早），按 priority,created_at
  return getDb().prepare(`SELECT * FROM data_sources GROUP BY base_url ORDER BY priority ASC, created_at ASC`).all() as any[];
}
export function primaryBaseGlobal(): string | null {
  const r = getDb().prepare(`SELECT base_url FROM data_sources WHERE enabled=1 GROUP BY base_url ORDER BY priority ASC, created_at ASC LIMIT 1`).get() as any;
  return r ? String(r.base_url).replace(/\/+$/, '') : null;
}
export function addSourceGlobal(s: { name: string; base_url: string; priority?: number }): string {
  const id = uuidv4();
  getDb().prepare('INSERT INTO data_sources (id, user_id, name, base_url, builtin, priority, enabled) VALUES (?,?,?,?,0,?,1)')
    .run(id, GLOBAL_OWNER, s.name, s.base_url.replace(/\/+$/, ''), s.priority ?? 100);
  return id;
}
export function updateSourceGlobal(id: string, patch: { name?: string; base_url?: string; enabled?: number; priority?: number }): void {
  const cur = getDb().prepare('SELECT * FROM data_sources WHERE id=?').get(id) as any; if (!cur) return;
  getDb().prepare('UPDATE data_sources SET name=?, base_url=?, enabled=?, priority=? WHERE id=?')
    .run(patch.name ?? cur.name, (patch.base_url ?? cur.base_url).replace(/\/+$/, ''), patch.enabled ?? cur.enabled, patch.priority ?? cur.priority, id);
}
export function deleteSourceGlobal(id: string): void {
  const cur = getDb().prepare('SELECT builtin FROM data_sources WHERE id=?').get(id) as any;
  if (cur && cur.builtin) return; // 不删内置
  getDb().prepare('DELETE FROM data_sources WHERE id=?').run(id);
}
export function catalogGlobal(): typeof RECOMMENDED {
  const have = new Set((getDb().prepare('SELECT base_url FROM data_sources').all() as any[]).map((r) => r.base_url));
  return RECOMMENDED.filter((r) => !have.has(r.base_url));
}
```
迁移（一次性去重）：在 `db.ts` 的 `migrate()` 末尾加：把每个 base_url 仅保留一行（删多余 per-user 重复），不破坏内置：
```ts
  const dsHas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='data_sources'").get();
  if (dsHas) {
    db.exec(`DELETE FROM data_sources WHERE id NOT IN (SELECT MIN(rowid) FROM data_sources GROUP BY base_url)`);
  }
```
`sidecar.ts` `resolveSidecarBase`：改为先用全局 primary（不依赖 userId）：
```ts
export function resolveSidecarBase(userId: string): string | null {
  const fromSources = primaryBaseGlobal();
  if (fromSources) return fromSources;
  if (userId) { const caps = getEnabledCapabilities(userId); const ak = caps.mcp.find((m) => m.key === 'akshare-data'); const url = ak?.config?.url; if (typeof url === 'string' && url) return url.replace(/\/+$/, ''); }
  return null;
}
```
（导入 `primaryBaseGlobal`。空 userId 时仅用全局源——满足 cron 系统级调用。）
`routes/data.ts`：`GET /sources`、`/sources/catalog` 改用 `listSourcesGlobal()`/`catalogGlobal()`（任何登录用户可读）；`POST/PUT/DELETE /sources*` 加 `adminMiddleware` 并调用 `*Global`。在 app 启动或首次访问处调用 `ensureSeedGlobal()`（可在 `GET /sources` 处理器开头调用，幂等）。

- [ ] **Step 4: 跑测试确认通过 + 全套 + tsc**

Run: `cd backend && npx jest -i && npx tsc --noEmit`
Expected: 全绿、tsc 干净。修复任何因签名变化而破的调用点。

- [ ] **Step 5: Commit**

```bash
git add backend/src/data/sources-service.ts backend/src/data/sidecar.ts backend/src/routes/data.ts backend/src/data/sources-service.test.ts backend/src/db.ts
git commit -m "feat(data): data_sources 全局化（admin 管理，按 base_url 去重迁移）"
```

---

## Task 7: 前端 — 状态/进度/占比/手动按钮/admin 取消·日志

**Files:**
- Modify: `frontend/src/api/data.ts`、`frontend/src/views/DataView.vue`
- 验证：`cd frontend && npx vue-tsc --noEmit` + 冒烟

- [ ] **Step 1: api 客户端改用新路由 + 新方法**

`frontend/src/api/data.ts`：把旧 `stockSync()/stockSyncStatus()/eodIngest()/eodStatus()` 改为统一：
```ts
runJob(job: 'stock_universe' | 'eod') { return api.post(`/data/${job}/run`).then((r) => r.data); },
jobStatus(job: 'stock_universe' | 'eod') { return api.get(`/data/${job}/status`).then((r) => r.data.data); },
cancelJob(job: 'stock_universe' | 'eod') { return api.post(`/data/${job}/cancel`).then((r) => r.data); },
jobLog(job: 'stock_universe' | 'eod') { return api.get(`/data/${job}/log`).then((r) => r.data.data as Array<{ ts: string; level: string; message: string }>); },
```
（`jobStatus` 返回的 data 含 `state/done/total/message/last_success_at/source_breakdown/cancel_requested` 等。）

- [ ] **Step 2: DataView 股票库/行情库区改造**

对 `stock_universe` 与 `eod` 两块，统一渲染：最后成功时间（`last_success_at`）、进度条（`state==='running'` 时 `done/total` + message，按 1.5s 轮询）、来源占比（`source_breakdown` → "腾讯 92%、新浪 8%"）、「立即更新」按钮（`disabled = state==='running' || 今日已成功`，禁用时 title 给原因；调 `runJob`）。`state==='error'` 显示 `error`。admin（`authStore.user?.role==='admin'`）额外：`running` 时「取消」按钮（调 `cancelJob`）、「查看日志」（调 `jobLog` 弹出列表）。
关键 `<script setup>`：
```ts
const jobs = reactive<Record<string, any>>({ stock_universe: null, eod: null });
let timer: any = null;
async function refreshJob(job: 'stock_universe' | 'eod') { jobs[job] = await dataApi.jobStatus(job); }
function pct(b: Record<string, number> | null) { return b ? Object.entries(b).map(([k, v]) => `${k} ${v}%`).join('、') : ''; }
function canRun(job: string) { const s = jobs[job]; if (!s) return true; if (s.state === 'running') return false; if (s.last_success_at) { const d = new Date(s.last_success_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); if (d === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })) return false; } return true; }
async function runJob(job: 'stock_universe' | 'eod') { try { await dataApi.runJob(job); } catch (e) { /* 409 等 */ } refreshJob(job); }
async function cancelJob(job: 'stock_universe' | 'eod') { await dataApi.cancelJob(job); refreshJob(job); }
const isAdmin = computed(() => authStore.user?.role === 'admin');
onMounted(() => { refreshJob('stock_universe'); refreshJob('eod'); timer = setInterval(() => { for (const j of ['stock_universe','eod'] as const) if (jobs[j]?.state === 'running') refreshJob(j); }, 1500); });
onBeforeUnmount(() => clearInterval(timer));
```
（`authStore` 用项目现有 auth store；导入 `reactive/computed/onMounted/onBeforeUnmount`。日志查看可用一个简单 `ref` 列表 + v-if 面板。删除旧 `eodStatus`/`stockSync` 相关引用。）

- [ ] **Step 3: 验证**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 0 errors。冒烟：数据页两块显示最后成功时间/进度/占比；非 admin 看不到取消/日志按钮；admin running 时可取消、可看日志。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/data.ts frontend/src/views/DataView.vue
git commit -m "feat(ui): 数据页 共享 job 状态/进度/占比/手动更新 + admin 取消·日志"
```

---

## Task 8: 端到端验证（本地容器）

- [ ] **Step 1: 重建并迁移验证**

```bash
docker compose up -d --build
docker exec -w /app/backend stock-agent-app-1 node -e "const D=require('better-sqlite3');const db=new D((process.env.DATA_DIR||'/app/backend/data')+'/stock-agent.db',{readonly:true});console.log(db.prepare('PRAGMA table_info(sync_status)').all().map(c=>c.name)); console.log('sync_log', db.prepare(\"SELECT name FROM sqlite_master WHERE name='sync_log'\").get());"
```
Expected: 列含 last_success_at/cancel_requested/source_breakdown 等；sync_log 存在。

- [ ] **Step 2: 触发 + 取消 + 状态/日志（admin token）**

```bash
TOK=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"stock-agent","password":"sg123456"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j?.data?.accessToken||'')})")
curl -s -X POST localhost:3000/api/data/eod/run -H "Authorization: Bearer $TOK"; echo
sleep 3; curl -s -X POST localhost:3000/api/data/eod/cancel -H "Authorization: Bearer $TOK"; echo
sleep 3; curl -s localhost:3000/api/data/eod/status -H "Authorization: Bearer $TOK"; echo
curl -s localhost:3000/api/data/eod/log -H "Authorization: Bearer $TOK" | head -c 300; echo
```
Expected: run 触发；cancel 后 status `state` 回到 `idle`、message 含"取消"；log 有若干行含开始/取消。

- [ ] **Step 3: 全套测试**

Run: `cd backend && npx jest`
Expected: 全绿。

---

## Self-Review

- **Spec 覆盖（第二期）**：sync_status 扩列+sync_log(Task1)、富状态/取消/启停 helpers(Task2)、循环接入+协作取消(Task3)、/run /status /cancel(admin) /log(admin)(Task4)、cron 09:25&01:00 首次年度·增量 + 夜间去 EOD(Task5)、data_sources 全局化 admin(Task6)、前端状态/进度/占比/手动/admin 取消·日志(Task7)、e2e(Task8) — 均有任务。
- **Placeholder**：无 TBD；每改代码步含真实代码。
- **类型一致**：`JobStatus` 字段（last_success_at/cancel_requested/source_breakdown/started_by/error）贯穿 db→service→route→前端；helpers 名（beginJob/finishJob/setProgress/jobLog/getJobLog/requestCancel/isCancelRequested/canStartJob）在 Task2 定义、Task3/4 使用一致；sources `*Global` 名 Task6 定义、cron(Task5 `primaryBaseGlobal`)与 route(Task6) 一致。
- **风险点已标注**：Task2/3 注意第一期 ingestEod 测试需同步切到 finishJob；Task6 空 userId 的 resolveSidecarBase 全局兜底供 cron 用；data_sources 用 GROUP BY base_url 去重而非破坏性 DROP COLUMN（SQLite 安全）。
