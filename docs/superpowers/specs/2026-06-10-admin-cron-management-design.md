# Admin 定时任务管理 Design

> admin 可看到系统所有后台定时任务的列表(计划时间/最后运行时间/状态/日志),可改每个任务的每日运行时间、启用/停用、立即运行一次。

最后更新：2026-06-10。仓库：`github.com/zmfy/stock-agent`。

## 背景 / 动机

后台有 5 个 node-cron 定时任务,散在 `cron/{nightly,meetings,shared-data}.ts`,计划时间硬编码、无统一管理、**nightly/早晚会没有任何运行记录**,admin 看不到「几点跑、上次何时跑、成没成」。本功能给一个 admin 可见可调的注册表。

## 已确认决策

1. **改时间到「每天 HH:MM」粒度**(当前 5 个任务都是每日);存成 cron 表达式 `M H * * *`。
2. 每个任务带 **启用/停用开关** + **「立即运行一次」** 按钮。
3. 仅 **admin** 可见可改。

## 当前任务清单(收敛进注册表)

| key | label | 默认 | 说明 | run 函数(复用) |
|---|---|---|---|---|
| `nightly` | 夜间数据刷新 | `0 23 * * *` | 清理新闻日志/同步交易日历/刷新新闻+大盘+缓存个股 | `runNightly` (cron/nightly.ts) |
| `meeting_morning` | 早会生成 | `0 8 * * *` | 刷新大盘+为合格用户生成早会(休市跳过) | `runMeetings('morning')` |
| `meeting_evening` | 晚会复盘 | `45 16 * * *` | 刷新大盘+生成晚会(休市跳过) | `runMeetings('evening')` |
| `stock_universe` | 股票库同步 | `25 9 * * *` | 全量名单 diff 入库 | `runStockUniverse` |
| `eod` | 行情 EOD 入库 | `0 1 * * *` | 全量个股日线(首次365/之后增量) | `runEod` |

全部时区 `Asia/Shanghai`。

## 架构

**`cron/registry.ts`(新)= 单一真相源**:
```ts
export interface CronJobDef { key: string; label: string; description: string; defaultExpr: string; run: () => Promise<void> | void; }
export const CRON_JOBS: CronJobDef[]; // 上表 5 条，import 现有 run 函数
```
现有 `start*Cron()` 三个函数删除/替换为 `startCrons()`:遍历 `CRON_JOBS`,对每个读「生效表达式 + 启用态」(来自 `cron_config`,见下),启用且 `ENABLE_CRON!=='false'` 才 `cron.schedule(expr, tracked(run), {timezone})`,把返回的 `ScheduledTask` 存 `Map<key, ScheduledTask>` 供改期/停用。`index.ts` 把 `startNightlyCron/startMeetingsCron/startSharedDataCron` 三处调用换成单个 `startCrons()`。

> 现有 run 函数(runNightly/runMeetings/runStockUniverse/runEod)**逻辑不动**——休市跳过、ensureSeedGlobal、内部 running 守卫都保留。`cron/{nightly,meetings,shared-data}.ts` 只移除各自的 `start*Cron` + `cron.schedule`(run 函数继续导出供注册表引用)。

**追踪包装器** `tracked(key, run)`:记 `cron_status` running→开跑;`await run()`;成功→`ok`+duration;抛错→`error`+消息(吞掉,不让一个任务崩掉进程);每次往 `sync_log`(key=`cron:<key>`)写起止行。

## 数据模型

**新表 `cron_status`**:
```sql
CREATE TABLE IF NOT EXISTS cron_status (
  key TEXT PRIMARY KEY,
  last_run_at DATETIME,
  last_status TEXT,            -- 'ok' | 'error' | 'running'
  last_duration_ms INTEGER,
  last_error TEXT,
  run_count INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
**计划/开关覆盖**:`settings` 单键 `cron_config`(JSON)`{ [key]: { expr?: string; enabled?: boolean } }`。`data/service.ts` settings 模板新增 `getCronConfig()/setCronConfig(cfg)`(沿用 getProxyConfig 写法)。生效:`expr = cfg[key]?.expr ?? defaultExpr`;`enabled = cfg[key]?.enabled ?? true`。

日志复用现有 `sync_log` + `getJobLog('cron:'+key)`(无需新表)。`cron_status` 是 admin 分析数据,不进 per-user 清空。

## 注册表服务 `cron/registry.ts`(纯逻辑可测部分)

- `timeToExpr(hhmm: string): string` — `'23:05'→'5 23 * * *'`;非法(非 HH:MM 或越界)抛 `BAD_TIME`。
- `exprToTime(expr: string): string | null` — `'M H * * *'→'HH:MM'`;非每日形态返回 null。
- `nextRunAt(expr: string, nowMs: number): string | null` — 仅每日 `M H * * *`:今天 H:M(Asia/Shanghai)若未过则今天否则明天,返回 ISO;非每日返回 null。
- `effective(key): { expr; enabled }` — 读 cron_config 合并默认。
- `listCronJobs()` — 组装 `GET /api/cron` 的数据(定义 + effective + cron_status + nextRunAt)。停用的任务 `nextRunAt=null`;`exprToTime` 为 null(非每日)时 `time=null`(前端显示「自定义」、时间不可视化改)。
- `applyCronChange(key, { time?, enabled? })` — 校验 time→expr、写 cron_config、**重排**(stop 旧 task;启用则 schedule 新);返回更新条目。
- `runCronNow(key)` — 立即跑 `tracked(key, def.run)`(不 await 完成,fire-and-forget;若该 key 的 `cron_status.last_status==='running'` 则拒绝重复)。
- `recordCronStart/recordCronFinish` — `cron_status` upsert。

## API `routes/cron.ts`(全部 authMiddleware + adminMiddleware)

- `GET /api/cron` → `{ cronEnabled: boolean(=ENABLE_CRON!=='false'), jobs: listCronJobs() }`。
- `PUT /api/cron/:key` → body `{ time?: 'HH:MM'; enabled?: boolean }`:未知 key→404;time 非法→422;否则 `applyCronChange` 返回更新条目。
- `POST /api/cron/:key/run` → `runCronNow`;已在运行→409;返回 `{started:true}`。
- `GET /api/cron/:key/log` → `getJobLog('cron:'+key)`。

`index.ts` 挂载 `/api/cron`。

## 前端

`api/cron.ts`:`list()/update(key,{time?,enabled?})/runNow(key)/log(key)` + 类型。
HomeView `SETTINGS` 加 `{ key:'crons', label:'定时任务', icon:'⏰', comp: CronsView }`,**仅 `auth.isAdmin` 时出现在菜单**。
`CronsView.vue`(仅 admin):顶部若 `!cronEnabled` 显示「⚠️ 定时未全局启用(ENABLE_CRON=false),以下配置将在启用后生效」。表格列:任务(label+说明) │ 每天时间(`<input type="time">` + 保存) │ 启用(开关) │ 最后运行(`fmtCN(lastRunAt)` + ✅/❌/⏳ + `lastDurationMs`) │ 下次运行(`fmtCN(nextRunAt)`) │ 操作(立即运行 / 看日志(展开))。运行中(任一 status=running)轮询 1.5s 刷新。

## 边界 / 错误

- `ENABLE_CRON=false`:`startCrons` 不实际调度;API/页面照常(改配置持久化,启用后生效)。
- 改时间非法 → 422 `BAD_TIME`。
- 重排:`applyCronChange` 先 `task.stop()`(若存在)再按新表达式 schedule;停用则只 stop 不重排。
- 立即运行的任务自身有 running 守卫(数据类)/休市跳过(早晚会)——保持,不重复触发。
- 包装器吞异常 + 记 `error`,绝不让定时任务崩进程。

## 测试

- **registry 纯逻辑**:`timeToExpr`(含非法抛错)、`exprToTime`(每日↔null)、`nextRunAt`(今天未过→今天、已过→明天,用注入 nowMs)、`effective`(覆盖/默认)。
- **cron_status**:`recordCronStart/Finish` 记 running→ok(带 duration)、→error(带消息)、run_count 自增;`tracked` 包装 run 抛错时不外抛、记 error。
- **routes**:admin 守卫(非 admin 403);`GET /api/cron` 结构 + cronEnabled;`PUT` 改 time(校验/持久化/返回新 expr)、改 enabled;未知 key 404;time 非法 422;`run` 触发(mock def.run);`log` 返回。重排里的 node-cron schedule/stop 在测试中桩掉(注册表对 ScheduledTask 的依赖通过可注入的 scheduler 或在测试环境跳过实际 schedule)。
- node-cron 真实定时不单测。

## 不在本次范围

非每日(周/小时级)可视化编辑(只做 HH:MM;直接存的非每日表达式仍能跑但 UI 显示「自定义」且不可视化改)、任务依赖编排、分布式多实例去重、运行历史长保留(沿用 sync_log 滚动200行)。
