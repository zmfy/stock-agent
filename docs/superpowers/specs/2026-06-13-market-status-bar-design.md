# 大盘状态条 Design（5 指数点数 + 数据更新时间 + 告警高亮）

> 普通用户聊天区下方常驻一条状态条：显示 5 个大盘指数当前点数(按盘前/盘中/盘后/休市取实时或收盘)、数据最近更新时间，并复用 `getDataAlerts` 在数据异常时整条高亮。后台定时缓存、状态条读缓存。

最后更新：2026-06-13。仓库：`github.com/zmfy/stock-agent`。

## 背景

现有基础设施：
- `index_daily`(code,date,ohlcv) + `ensureIndexBars(userId, code, n, {freshThrough})` + sidecar `fetchIndexBars(base, code, days)`——指数日线/收盘。目前仅 `000001`(上证)被取(走 ma20 斜率路径)。
- `realtime_quote`(按 code upsert) + sidecar `fetchRealtime(base, code)`(TDX `c.quotes()`)——个股实时。`realtime` cron 每 5 分钟、仅交易时段，遍历 `listCachedCodes()` 写实时。
- `getDataAlerts(sidecar, nowCN)`(`data/alerts.ts`)——从 sync_status/cron_status/market_sentiment/sidecar 实时算数据告警；目前仅 admin 路由 `GET /api/data/alerts`。
- `inTradingSession(nowMs)`、`isTradingDay(date)`、`beijingDate`/`lastTradingDayBefore`、`resolveSidecarBase`/`pingHealth`。

目标：给普通用户一个一眼可见的大盘+数据健康状态条。

## 已确认决策

- **指数刷新**：后台定时缓存，状态条读缓存(不每次 live)；「最新更新时间」= 缓存拉取时间。
- **告警呈现**：整条高亮(error 红/warn 黄) + 简短「⚠ 数据异常 N 条」，点击展开 `getDataAlerts` 明细。

## A. 5 个指数

| 名称 | key(带市场前缀) | 备注 |
|---|---|---|
| 上证综指 | `sh000001` | |
| 深证成指 | `sz399001` | |
| 创业板指 | `sz399006` | |
| 北证50 | `bj899050` | 代码以实测为准 |
| 科创50 | `sh000688` | |

> **realtime_quote / index_daily 的 key 一律用带市场前缀形式**(如 `sh000001`)，与个股 `000001` 隔离。

## B. sidecar：指数实时点数

- 新增/扩展 sidecar 能力取**指数实时点数**(带市场区分)：`tdx.realtime(code)` 直接用 `c.quotes(symbol=code)` 对 `000001` 有歧义(上证指数 vs 平安银行)。需在 sidecar 用指数专用取数(mootdx 指数接口/带 market 参数，或 `c.index`/`quotes` 指定 market)。
- **实现第一步在容器内验证**可取性与正确点数；TDX 取不到 → 退到 sidecar 现有备用源(sina/eastmoney 指数实时)；仍不行 → 该指数只显示收盘并标注。
- sidecar 端点(或复用 `/realtime/{code}` 扩展接受带前缀指数 code)返回 `{price, prev_close, ...}`。

## C. 后端 service / cron

- **缓存指数实时**：扩展 `realtime` cron(`ingestRealtime`)在拉个股后，额外拉这 5 个指数实时写入 `realtime_quote`(key=带前缀)。仅交易时段(沿用现有闸门)。
- **缓存指数收盘**：`nightly`/`eod` 刷新这 5 指数的 `index_daily`(`ensureIndexBars` 对 5 个 code)。
- **读取/组装**：新 `getMarketStatus(userId, nowMs?)`:
  - 对每个指数：若 `realtime_quote[key]` 的 `fetched_at` 为**今天**(北京) → 用其 `price`；`basis = inTradingSession(now) ? '实时' : '收盘'`。否则用 `index_daily[key]` 最新收盘 → `basis='收盘'`(盘前/休市=上一交易日收盘)。
  - `prevClose`/`changePct`：realtime 带 `prev_close` 则算涨跌幅；收盘态用 index_daily 前一日。
  - `updatedAt`：5 指数中最近的 realtime `fetched_at`(无则最新 index_daily 日期)。
- **alerts**：`getMarketStatus` 内部解析 sidecar 态(`resolveSidecarBase`+`pingHealth`) → `getDataAlerts(...)`，把结果一并返回。

## D. 路由

`GET /api/market/status`(authMiddleware，普通用户可访问)→
```json
{
  "updatedAt": "2026-06-13 10:05:00",
  "indices": [
    { "name": "上证综指", "code": "sh000001", "point": 3120.5, "prevClose": 3110.2, "changePct": 0.33, "basis": "实时" }
  ],
  "alerts": [ { "level": "warn", "source": "market", "message": "..." } ],
  "alertLevel": "warn"   // 汇总：有 error→'error'，否则有 warn→'warn'，否则 null
}
```
新建路由文件 `routes/market.ts` 或并入现有(挂 `/api/market`)；不挂 aiLimiter(纯读)。

## E. 前端状态条

- 普通用户 `HomeView` 聊天区(`<section v-else class="chat">`)**底部**常驻 `MarketStatusBar` 组件(admin 无聊天区，不渲染)。
- 显示：左=5 指数 `名称 点数`(涨跌幅红/绿)，右=`数据更新于 {updatedAt}`。
- `alertLevel='error'`→整条红底、`'warn'`→黄底，显「⚠ 数据异常 {alerts.length} 条」，点击展开告警明细(小弹层/下拉，复用 `Modal` 或内联)。
- 30s 轮询 `GET /api/market/status`;组件卸载清定时器。
- 新 `frontend/src/api/market.ts`(`marketApi.status()`)。

## F. 错误处理 / 边界

- 指数取不到(realtime+daily 均无)：该指数显示「—」，不阻断其它。
- sidecar 不可达：alerts 含 sidecar error → 状态条红;指数走 index_daily 收盘(若有)。
- 休市日/盘前：无今日 realtime → 全用 index_daily 最新收盘(上一交易日)，basis='收盘'。
- 时间一律北京时间。
- 北证50 代码以容器实测为准(若 `899050` 取不到，调整)。

## G. 范围 / 测试

- 后端：sidecar 指数实时(容器验证)、service `getMarketStatus` + 指数缓存写入、cron 加 5 指数、`GET /api/market/status` + jest(状态结构、phase 取值[实时/收盘]、alerts 汇总 level、指数缺失降级)。
- 前端(无 runner)：`vue-tsc` + 走查(状态条显示 5 指数/更新时间、异常高亮+展开、admin 不显示、轮询清理)。

## H. 不在本次范围

- 不做指数的历史走势图/分时。
- 不改 `getDataAlerts` 的计算逻辑(仅复用 + 对用户暴露其结果)。
- 不做个股在状态条的展示(只 5 大盘指数)。
- 指数 realtime 若 TDX 不支持，本期允许退到备用源或仅收盘(不强行实现 TDX 指数实时)。
