# Admin 强制中止卡死的数据任务

日期：2026-06-08

## Context（背景）

生产环境有一个「取得行情(EOD)」的进度条一直卡着、怎么也取消不掉。根因：job 的取消是**协作式**的——`requestCancel(job)` 只把 `sync_status.cancel_requested` 置 1，靠任务循环每轮 `isCancelRequested()` 检查后退出。当任务线程已死或容器重启过、但 `sync_status.state` 仍停在 `'running'`（**孤儿状态**）时，没有活线程去读取消标志，于是：进度条永远卡着、`canRun(job)` 一直返回 false（不能重跑）、「取消」按钮点了也无效。

需要给 admin 一个**强制中止**：无视是否有真线程，直接把 job 状态打回可用，立刻清掉进度条并解锁重跑。

## 现状契约

- `sync_status` 表（每 job 一行）：`job, state('idle'|'running'|'done'|'error'), total, done, message, started_at, finished_at, error, cancel_requested, source_breakdown, updated_at`。
- `data/service.ts`：`beginJob` / `updateProgress` / `finishJob(job,state,...)` / `requestCancel(job)`(仅置 cancel_requested，WHERE state='running') / `isCancelRequested(job)` / `getSyncStatus(job)` / `canRun(job)`(state==='running' → false)。
- 任务循环（`ingestEod` 等）每轮检查 `isCancelRequested`，且每轮的 sidecar 调用都有 `_timed` 超时上限（不会无限卡单步）。
- 统一路由 `routes/data.ts`：`POST /:job/run`、`GET /:job/status`、`POST /:job/cancel`(adminMiddleware)、`GET /:job/log`(adminMiddleware)。
- 前端 `DataView.vue`：`doRun/doCancel/showLog`、`isAdmin`；「取消」按钮 `v-if="isAdmin && jobs.<job>?.state === 'running'"`（stock_universe 与 eod 各一处）。
- `api/data.ts`：`runJob/jobStatus/cancelJob/jobLog`，job 类型 `'stock_universe' | 'eod'`。

## Goals

- admin 一键**强制中止**任意卡死/运行中的数据任务：进度条立刻消失、可立即重跑。
- 对孤儿 `running` 状态有效（无活线程也能清）；对仍存活的循环也能让其尽快退出。
- 不改表结构；不影响现有「取消」「立即更新」「查看日志」。

## Non-goals

- 不做真正的 OS/线程级 kill（Node 单事件循环无法强杀某个 async 任务；协作式 + 状态重置已足够，且每步有超时）。
- 不新增「重新下载」机制（各 job 的「立即更新」按钮已能随时触发；强制中止后即解锁）。
- 强制中止按钮仅在 `state==='running'` 时对 admin 显示（idle 不显示）。

## 设计

### 后端

**`data/service.ts` 新增 `forceStopJob(job)`：**
```ts
// 管理员强制中止：无视是否有活线程，直接把状态打回 idle（清进度条+解锁重跑），
// 并置 cancel_requested=1，让万一还存活的循环下一轮自行退出。
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
说明：
- 立刻 `state='idle'` → 前端进度条消失、`canRun` 恢复 true。
- `cancel_requested=1`：若仍有活循环，它下一轮 `isCancelRequested` 命中后会 `finishJob('idle','已取消…')`（再次确认 idle，无害）；每轮 sidecar 调用有超时，最长一步即退出，不会无限卡。
- 孤儿状态：直接被清。
- 下次 `beginJob` 会把 `cancel_requested` 复位为 0、state 置 running，互不影响。
- 若该 job 行不存在，UPDATE 无命中 = 无害空操作。

**路由 `routes/data.ts` 新增**（放在统一 job 路由区，紧邻 `/:job/cancel`）：
```ts
router.post('/:job/force-stop', adminMiddleware, (req, res) => {
  const job = req.params.job;
  svc.forceStopJob(job);
  successResponse(res, svc.getSyncStatus(job) ?? { state: 'idle', cancel_requested: 0 });
});
```

### 前端

**`api/data.ts`** 加：
```ts
forceStopJob: (job: 'stock_universe' | 'eod') => api.post(`/data/${job}/force-stop`).then((r) => r.data),
```

**`DataView.vue`**：
- script 加 `doForceStop`：
```ts
async function doForceStop(job: 'stock_universe' | 'eod') {
  try { await dataApi.forceStopJob(job); } catch { /* ignore */ }
  await refreshJob(job);
}
```
- 模板：在 stock_universe 与 eod 两处的「取消」按钮**之后**，各加一个仅 admin、仅 running 时显示的按钮：
```html
<button v-if="isAdmin && jobs.<job>?.state === 'running'" class="danger" @click="doForceStop('<job>')">⛔ 强制中止</button>
```
（`<job>` 分别为 `stock_universe`、`eod`。可加一个轻量 `.danger` scoped 样式：红字/红边，区别于「取消」。）

## Testing

- **后端单测**（`data/service` 或 routes/data 测试）：
  - `beginJob('eod','tester',10)` → `getSyncStatus('eod').state==='running'` → `forceStopJob('eod')` → `state==='idle'`、`cancel_requested===1`、`canRun('eod')===true`。
  - 路由：非 admin `POST /api/data/eod/force-stop` → 403；admin → 200 且返回 state==='idle'。
- **Node 全套** `npm test` 保持绿（新增用例外，现有不受影响）。
- **手动冒烟**：构造 running（点「立即更新」或直接置 sync_status）→ admin 点「⛔ 强制中止」→ 进度条立即消失、可再次「立即更新」。

## 默认决定（已确认）

- 强制中止仅在 `state==='running'` 时对 admin 显示。
- 强制中止 = 状态重置回 idle + 置 cancel_requested（不做线程级 kill）。
- 不新增「重新下载」机制（沿用现有「立即更新」，强制中止后解锁）。
