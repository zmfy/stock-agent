# 共享数据层：上游探测择优 + 全程溯源 + 共享调度/锁/管控

日期：2026-06-07

## Context（背景与动因）

「股票小作手」的行情/基本面/情绪/新闻数据由 Python sidecar（AkShare 等）抓取，存入
**全系统共享**的缓存表（`stock_names` / `quote_daily` / `fundamentals` / `market_sentiment`
/ `news`，均无 `user_id`）。当前实现存在几个真问题：

1. **行情拉取 0 成功（线上实测，已根因定位）**：`/quote` 主源 BaoStock 登录卡死、兜底
   东方财富 `stock_zh_a_hist`（`push2his.eastmoney.com`）在部署环境被对端重置
   （`RemoteDisconnected`）；而**腾讯 `stock_zh_a_hist_tx`、新浪 `stock_zh_a_daily` 实测
   均正常（各 5934 行）**。错误被三层 `try/except` 吞掉，用户只看到「失败 N」，无原因。
2. **数据源不透明**：系统实际用到的上游（含 BaoStock）没在数据页展示；写死的源顺序在不同
   网络环境下不一定可达。
3. **缺共享治理**：拉取是 per-user 触发的 fire-and-forget，没有"全局唯一/锁/按天/最后成功
   时间/进度可见"，admin 无法取消跑飞的任务、看不到失败原因。

目标：把数据拉取做成**系统级共享资源**——上游可达性动态探测、择优抓取、逐条溯源、来源占比
可见；并加上共享锁、定时调度、进度/最后更新时间展示、admin 取消/日志/失败原因。

## Goals

- 行情/基本面/情绪/新闻**全部上游**纳入「探测择优 + 溯源 + 占比」。
- 拉取前探测各上游「可达 + 延迟」，按快慢动态排序；**不写死顺序**，BaoStock 等全部保留为候选。
- 每条数据记录**实际来源**；一次拉取结束给出**各源占比**。
- 数据页展示所有候选源 + 实时探测状态 + 最后更新时间 + 本次来源占比。
- 共享 job：全局唯一、运行锁、按天、最后成功时间、进度条；任何登录用户可手动触发。
- cron：股票库 09:25、行情 EOD 01:00（首次近一年、之后增量约一天）。
- admin 专属：取消运行中的拉取、查看日志、查看失败原因。
- `data_sources` 改为全局、admin 管理。

## Non-goals

- 不改分析引擎/规则/聊天等其它子系统。
- 不引入付费/带 token 的源（如 Tushare）——本期用免费源（东方财富/腾讯/新浪/BaoStock）。
- 不做跨服务器数据同步；每个部署各自拉取。

## 架构：上游 Provider 抽象

sidecar 内把每类数据的上游做成 **Provider 注册表**（代码定义，不是用户可编辑的 base_url）：

| kind | providers（key） |
|---|---|
| `quote` | `em`(东方财富 stock_zh_a_hist) · `tx`(腾讯 stock_zh_a_hist_tx) · `sina`(新浪 stock_zh_a_daily) · `baostock` |
| `fundamentals` | `baostock` · `em` |
| `sentiment` | `em` |
| `news` | `em` · `cjzc` · `cls` |

每个 provider = `{ key, label, kind, probe(), fetch(...) }`，所有上游调用用现有 `_timed()`
包超时、各自 try/except 隔离。

### sidecar 新增/改造端点

- `GET /probe?kind=quote` → `[{ key, label, reachable: bool, latency_ms: int|null, error: str|null }]`
  - 用一只固定测试股票（如 `600519`）对该 kind 的每个 provider 打一发、计时、带超时。
  - sentiment/news 用各自的轻量测试调用。
- 数据端点改为**带溯源**返回，并接受候选顺序：
  - `GET /quote/{code}?days=120&order=tx,sina,em,baostock`
    → `{ "source": "tx", "rows": [ {date,open,high,low,close,volume}... ] }`
    （按 `order` 逐个试，返回第一个非空的，`source` 标明实际来源；全失败 → `{ "source": null, "rows": [] }`）
  - `GET /fundamentals/{code}?order=baostock,em` → `{ "source": "...", "data": {...} }`
  - `GET /market/sentiment?order=em` → `{ "source": "...", "data": {...} }`
  - `GET /news?order=em,cjzc,cls&limit=20` → `{ "source": "...", "rows": [...] }`
  - 兼容：`order` 缺省时用注册表默认顺序。

> 现有 `/sina/quote`、`/tx/quote` 等"后缀源"端点在新模型下冗余，可保留（向后兼容）但不再
> 是主路径；`data_sources` 里那几条 `/sina`、`/tx` 后缀源迁移时合并掉。

## 第一期：探测择优 + 溯源 + 占比（含 0 成功根治）

### sidecar
- 实现 Provider 注册表 + `/probe` + 数据端点的 `order` 参数与 `{source, rows/data}` 溯源返回。
- `quote` 候选含 `em/tx/sina/baostock`，**保留全部、不写死顺序**。

### Node（backend/src/data）
- `sidecar.ts`：`probe(base, kind)`；`fetchQuotes/fetchFundamentals/...` 适配新返回
  `{source, rows}`，返回 `{ source, rows }`（向上传递来源）。
- `service.ts`：
  - `ingestEod` / `syncStockUniverse` / market / news 拉取前调用 `probe`，得到「可达且按延迟
    升序」的 `order`，传给逐条 fetch。
  - `cacheQuotes(rows, source)` 的 `source` 改为**实际 provider key**（修正现在写死的 `'eod'`）；
    `fundamentals`/`market_sentiment`/`news` 同样存实际来源。
  - 拉取过程累计 `{ providerKey: count }`，结束算占比。

### 溯源与占比
- `quote_daily.source` / `fundamentals.source` 等列存 provider key（`tx`/`sina`/`em`/`baostock`）。
- 一次 job 结束，把 `{ tx: 0.92, sina: 0.08 }` 写入 `sync_status.source_breakdown`（JSON）。

### 数据页（第一期可见部分）
- 「数据源」区展示**所有候选 provider** + 探测状态（可达/延迟/错误）+ 一个「探测」按钮。
- 行情/基本面区显示最后更新时间 + 本次**来源占比**。

> 完成即解阻塞：本环境腾讯/新浪秒回，EOD 不再 0 成功。

## 第二期：共享调度 + 锁 + 进度 + admin 管控

### 数据模型
- `sync_status`（已是全局、按 `job`）扩列（用现有 `migrate()` ALTER）：
  `started_at`、`finished_at`、`last_success_at`（DATETIME）、`started_by`（TEXT，用户名或 `'cron'`）、
  `error`（TEXT 失败原因）、`cancel_requested`（INT 0/1）、`source_breakdown`（TEXT JSON）。
- 新表 `sync_log`：`(id INTEGER PK, job TEXT, ts DATETIME, level TEXT, message TEXT)`，滚动保留
  每 job 最近约 200 行。
- `data_sources` → **全局**：去掉 `user_id` 作用域；一次性迁移把现有 per-user 行按 `base_url`
  去重合并成一套；`sources-service` 全部去掉 `userId` 形参。仅代表"**sidecar 基址**"。

### 锁与按天语义（每个共享 job：`stock_universe`、`eod`、可扩展 `fundamentals` 等）
- 状态机：`idle → running → done|error`，外加协作式 `cancel_requested`。
- 按钮启用 ⇔ `state ∉ {running}` 且「今天未成功」（`last_success_at` 的日期 ≠ 今天，Asia/Shanghai）。
- 首个触发者置 `running`，他人见进度条、按钮禁用。
- 成功 → `last_success_at=今天` → 当天保持禁用，次日/下次定时自动重新可点。
- 失败 → 按钮重新可点（允许重试），展示错误。
- **任何登录用户**可触发；触发端点对 running 直接拒绝（"已有用户在更新"）。

### cron（Asia/Shanghai，受 `ENABLE_CRON` 控制）
- `25 9 * * *` → 股票库（`started_by='cron'`）。
- `0 1 * * *` → 行情 EOD：无 `last_success_at`/`quote_daily` 空 → 拉**近 365 天**；否则
  从 `max(date)+1` 增量（约 1 天）。⚠️ 首次 5000+ 只 × 1 年很慢、占盘，作为长后台任务带进度跑。
- 基本面/情绪/新闻沿用夜间 `0 23 * * *`；从 23:00 任务里**移除** EOD（交给 01:00）。
- cron 与手动均作为**系统级 job**，用**全局 primary 源**（`primaryBase()` 无 userId），废弃"挑一个
  admin 用户"的旧逻辑。

### admin 专属
- `POST /api/data/<job>/cancel`（admin）→ 置 `cancel_requested=1`；拉取循环每批检查，干净停止，
  记日志"canceled by <admin>"，`state→idle`。
- `GET /api/data/<job>/log`（admin）→ 返回该 job 的 `sync_log`（含失败原因）。
- 非 admin：见状态 + 最后成功时间 + 进度 + 占比 + 朴素「失败」标记；admin 另有 取消/日志/失败原因。

### 数据页（第二期补全）
- 股票库 / 行情库 各区：本地条数、**最后成功更新时间**、进度条（running 轮询）、来源占比、
  「立即更新」按钮（按上面规则启停、禁用给原因）。admin 额外：running 时「取消」、「查看日志」，
  error 时显示原因 + 日志。

## API 变更汇总

新增/改造（均在 `routes/data.ts`，`authMiddleware`；cancel/log 加 `adminMiddleware`）：
- `GET /api/data/probe?kind=` — 触发探测、返回各 provider 状态。
- `GET /api/data/<job>/status` — 含 last_success_at、进度、source_breakdown、error。
- `POST /api/data/<job>/run` — 手动触发（任何用户，running 拒绝）。`<job>` ∈ `stock_universe`/`eod`。
- `POST /api/data/<job>/cancel` —（admin）请求取消。
- `GET /api/data/<job>/log` —（admin）日志。
- `data_sources` 端点去掉 per-user 语义，改 admin 写、所有人读。

## Testing

- sidecar：一次性脚本验证 `/probe`（区分可达/不可达 provider）与带 `order` 的 `/quote` 返回
  `{source, rows}` 且 source 正确。
- Node 单测：probe→order 排序（按 latency、剔除不可达）；逐条 fallback 与 provenance 记录；
  占比计算；锁状态机（running/按天/失败重试）；cancel 标志被循环响应；全局 `data_sources` 迁移去重；
  cancel/log 的 admin 鉴权。EOD first-vs-incremental 区间计算。
- 现有测试套件保持绿。

## 默认决定（已与用户确认 / 可再改）

- 数据源管理改全局 admin；手动触发任何登录用户可点；cancel/log/失败原因 admin 专属。
- 探测在每次拉取开始时做一次、整轮复用该顺序。
- 全部上游（行情/基本面/情绪/新闻）都纳入探测择优 + 溯源 + 占比。
- 第一期先上（解阻塞），第二期紧随。
- 失败后按钮重新可点（不永久锁死）；23:00 夜间任务移除 EOD、由 01:00 接管。

## 落地顺序

1. 第一期：sidecar Provider/probe/溯源 → Node 适配 + provenance + 占比 → 数据页源展示。（解 0 成功）
2. 第二期：sync_status 扩列 + sync_log → 锁/按天/手动触发 → cron 09:25 & 01:00 → admin 取消/日志
   → data_sources 全局化 → 数据页补全。
