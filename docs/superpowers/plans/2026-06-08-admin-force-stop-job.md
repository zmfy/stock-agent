# Admin 强制中止数据任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 admin 一键强制中止卡死/运行中的数据任务（立刻清进度条 + 解锁重跑）。

**Architecture:** 后端加 `forceStopJob(job)`（一句 UPDATE 把 `sync_status` 重置回 idle + 置 cancel_requested=1）+ admin 路由 `POST /:job/force-stop`；前端 DataView 在 running 时给 admin 显示「⛔ 强制中止」按钮。不改表结构。

**Tech Stack:** Node/Express + better-sqlite3（后端）；Vue 3（前端）；jest + supertest（后端测试）。

**确认契约（实现须对齐）：**
- `routes/data.ts`：`SHARED_JOBS = new Set(['stock_universe','eod'])`；`jobName(req)` 返回合法 job 名或 null；`/:job/cancel` 用 `adminMiddleware`；`successResponse(res, data)` 默认 200；`errorResponse(res, 400, 'BAD_JOB', '未知任务')`。`import * as svc from '../data/service'` 已存在。
- `data/service.ts`：`beginJob/finishJob/requestCancel/getSyncStatus/canRun` 已存在；`sync_status` 列含 `state, cancel_requested, finished_at, message, updated_at`。
- 测试 `routes/data.test.ts`：`h()` = admin 头（默认管理员 stock-agent），`uh()` = 普通用户头。
- 前端 `DataView.vue`：`isAdmin`、`doRun/doCancel/showLog`、`refreshJob(job)`；「取消」按钮 `v-if="isAdmin && jobs.<job>?.state === 'running'"`（stock_universe 行 ~90、eod 行 ~119 各一处）。`api/data.ts`：`runJob/jobStatus/cancelJob/jobLog`（job 类型 `'stock_universe' | 'eod'`）。

---

### Task 1: 后端 forceStopJob + admin 路由（TDD）

**Files:**
- Modify: `backend/src/data/service.ts`（加 `forceStopJob`，紧邻 `requestCancel`）
- Modify: `backend/src/routes/data.ts`（加 `POST /:job/force-stop`，紧邻 `/:job/cancel`）
- Test: `backend/src/routes/data.test.ts`（加一个用例）

- [ ] **Step 1: 写失败测试**

在 `backend/src/routes/data.test.ts` 的 `describe('data routes', ...)` 块内（紧跟现有 cancel 用例之后）加：
```ts
  it('admin 强制中止把 running 重置为 idle；非 admin 403', async () => {
    const svc = require('../data/service');
    svc.beginJob('eod', 'tester', 10);
    expect(svc.getSyncStatus('eod').state).toBe('running');
    // 非 admin → 403
    const forbidden = await request(app).post('/api/data/eod/force-stop').set(uh());
    expect(forbidden.status).toBe(403);
    // admin → 200，状态回 idle
    const ok = await request(app).post('/api/data/eod/force-stop').set(h());
    expect(ok.status).toBe(200);
    expect(ok.body.data.state).toBe('idle');
    // 取消标志置位、可重跑
    expect(svc.getSyncStatus('eod').cancel_requested).toBe(1);
    expect(svc.canRun('eod')).toBe(true);
    // 未知 job → 400
    const bad = await request(app).post('/api/data/nope/force-stop').set(h());
    expect(bad.status).toBe(400);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /home/zhangjq/projects/stock-agent/backend && npx jest src/routes/data.test.ts -t "强制中止" 2>&1 | tail -15`
Expected: FAIL —— force-stop 路由不存在（404，断言 403/200 失败）。

- [ ] **Step 3: 加 `forceStopJob`（service.ts）**

在 `backend/src/data/service.ts` 的 `requestCancel` 函数**之后**插入：
```ts
// 管理员强制中止：无视是否有活线程，把状态打回 idle（清进度条+解锁重跑），
// 并置 cancel_requested=1，让万一还存活的循环下一轮检查时自行退出。
export function forceStopJob(job: string): void {
  getDb()
    .prepare(
      `UPDATE sync_status SET state='idle', message='已被管理员强制中止',
         cancel_requested=1, finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE job=?`
    )
    .run(job);
}
```

- [ ] **Step 4: 加路由（routes/data.ts）**

在 `backend/src/routes/data.ts` 的 `router.post('/:job/cancel', ...)` 块**之后**插入：
```ts
router.post('/:job/force-stop', adminMiddleware, (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  svc.forceStopJob(job);
  successResponse(res, svc.getSyncStatus(job) ?? { state: 'idle', cancel_requested: 0 });
});
```
（`adminMiddleware`、`jobName`、`errorResponse`、`successResponse`、`svc` 均已在该文件中可用。）

- [ ] **Step 5: 运行确认通过 + 全套回归**

Run: `cd /home/zhangjq/projects/stock-agent/backend && npx jest src/routes/data.test.ts -t "强制中止" 2>&1 | tail -8`
Expected: PASS。
Run: `cd /home/zhangjq/projects/stock-agent/backend && npm test 2>&1 | tail -5`
Expected: 全套通过（原 202 + 本用例）。

- [ ] **Step 6: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add backend/src/data/service.ts backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(data): admin forceStopJob + POST /:job/force-stop(强制中止卡死任务)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 前端 强制中止按钮（DataView，仅 admin/running）

**Files:**
- Modify: `frontend/src/api/data.ts`（加 `forceStopJob`）
- Modify: `frontend/src/views/DataView.vue`（加 `doForceStop` + 两处按钮 + `.danger` 样式）

- [ ] **Step 1: api 方法**

在 `frontend/src/api/data.ts` 的 `cancelJob` 行**之后**加：
```ts
  forceStopJob: (job: 'stock_universe' | 'eod') => api.post(`/data/${job}/force-stop`).then((r) => r.data),
```

- [ ] **Step 2: DataView 加 `doForceStop`**

在 `frontend/src/views/DataView.vue` 的 `<script setup>` 中（紧邻已有的 `doCancel` 函数）加：
```ts
async function doForceStop(job: 'stock_universe' | 'eod') {
  try { await dataApi.forceStopJob(job); } catch { /* ignore */ }
  await refreshJob(job);
}
```

- [ ] **Step 3: 两处按钮（stock_universe 与 eod）**

在 stock_universe 的「取消」按钮
```html
<button
  v-if="isAdmin && jobs.stock_universe?.state === 'running'"
  @click="doCancel('stock_universe')"
>取消</button>
```
**之后**加：
```html
<button
  v-if="isAdmin && jobs.stock_universe?.state === 'running'"
  class="danger"
  @click="doForceStop('stock_universe')"
>⛔ 强制中止</button>
```
同样，在 eod 的「取消」按钮（`@click="doCancel('eod')"`）之后加：
```html
<button
  v-if="isAdmin && jobs.eod?.state === 'running'"
  class="danger"
  @click="doForceStop('eod')"
>⛔ 强制中止</button>
```

- [ ] **Step 4: `.danger` 样式**

在 `DataView.vue` 的 `<style scoped>` 末尾加：
```css
.danger { color: #cf1322; border-color: #ffccc7; }
```

- [ ] **Step 5: 类型检查**

Run: `cd /home/zhangjq/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: 干净（无输出）。

- [ ] **Step 6: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add frontend/src/api/data.ts frontend/src/views/DataView.vue
git commit -m "feat(ui): DataView 加 admin「强制中止」按钮(仅 running 显示)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：**
- `forceStopJob`（重置 idle + cancel_requested=1，不改表结构）→ Task 1 Step 3。✓
- admin 路由 `POST /:job/force-stop`（jobName 校验、adminMiddleware）→ Task 1 Step 4。✓
- 后端单测（running→force-stop→idle、cancel_requested=1、canRun true、非 admin 403、未知 job 400）→ Task 1 Step 1。✓
- 前端 api + DataView 按钮（仅 admin + 仅 running，stock_universe 与 eod 两处）→ Task 2。✓
- 「随时重拉」沿用现有「立即更新」(doRun)，无需新增 → 计划未触碰，符合 spec non-goal。✓
- Node 全套保持绿 → Task 1 Step 5。✓

**Placeholder scan：** 无 TBD/TODO；每步给出完整代码与精确命令。

**Type/契约一致性：** `forceStopJob(job: string)`（service）↔ 路由 `svc.forceStopJob(job)` ↔ api `forceStopJob(job)` ↔ DataView `doForceStop(job)`：命名一致。job 类型 `'stock_universe'|'eod'` 与现有 api 一致。路由用 `jobName(req)`/`errorResponse`/`successResponse`/`adminMiddleware`（均文件内已有）。测试用 `h()`(admin)/`uh()`(非 admin)，与文件现有定义一致。
