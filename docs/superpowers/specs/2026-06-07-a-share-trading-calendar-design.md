# A 股交易日历 + 休市日不开会 + 夜间攒新闻给下个交易日早会

日期：2026-06-07

## Context（背景）

用户要：
1. 聊天页右侧操作面板**最底部**加「📅 A 股日历」按钮，点击在**按钮上方**弹出当月日历，标出**休市日**（周末 + 节假日），可翻月。
2. **休市日**：定时任务不自动开早会/晚会（手动仍可）。
3. 休市日**夜间仍定时收集当天重要财经新闻**入库；**下一个交易日早会**把这些攒下的新闻（上个交易日以来全部）作为判断凭据。

现状要点：
- 早晚会由 `cron/meetings.ts` 自动生成（早 08:00 / 晚 16:45 Asia/Shanghai，对 `eligibleUserIds()`）；手动经 `meetingsApi.generate` 路由。
- `cron/nightly.ts`（23:00）刷新行情但**不**采集新闻。
- 早会新闻来自 `meetings/service.buildNewsWithIds()`（读 `news_content_log` 最近 8 条）。
- 新闻采集 `data/service.refreshNews(userId)` 已写 `news_content_log`（去重，`collected_at` 为 UTC）。
- sidecar（FastAPI + `import akshare as ak`）目前**无**交易日历端点。

## Goals

- A 股交易日历：sidecar 提供交易日列表，后端缓存并判定休市；前端日历弹窗按月展示休市日（统一标「休」置灰，今天高亮，可 ‹ › 翻月）。
- 休市日：meetings 定时任务跳过（手动不拦）。
- 夜间每天（含休市日）采集新闻入库。
- 早会新闻窗口扩为「上个交易日以来全部」（≤30 条）。

## Non-goals

- 休市日不区分「节假日 / 普通周末」配色（统一「休」）。
- 不改晚会新闻窗口（仍当天）。
- 不做跨年（akshare 仅给到本年末）的精确节假日；超出已知日历的未来月份按「周末=休市」兜底。

## 设计

### A. 交易日历数据源

**A1. sidecar `GET /trade-calendar`**（`sidecar/main.py`）：
```python
@app.get("/trade-calendar")
def trade_calendar():
    # akshare 新浪交易日历（含本年已公布节假日），返回全部 A 股交易日
    df = _timed(lambda: ak.tool_trade_date_hist_sina(), 15)
    dates = sorted({str(d)[:10] for d in df["trade_date"].tolist()})
    return {"source": "sina", "dates": dates}
```
（沿用文件里 `_timed` 包装防卡；失败时 FastAPI 抛错，后端兜底处理。）

**A2. DB 表**（`backend/src/db.ts` schema + `migrate()`）：
```sql
CREATE TABLE IF NOT EXISTS trade_calendar (
  date TEXT PRIMARY KEY        -- 'YYYY-MM-DD'，仅存交易日
);
CREATE TABLE IF NOT EXISTS kv_meta (
  k TEXT PRIMARY KEY, v TEXT   -- 存 trade_calendar_synced_at 等元信息
);
```
（kv_meta 若已存在则复用；本设计仅用它记日历最后同步时间。若已有等价表，用现有的。）

**A3. 后端服务 `backend/src/data/trade-calendar.ts`**：
```ts
import { getDb } from '../db';
import { fetchTradeDates } from './sidecar';        // A4
import { beijingToday } from ...                     // 后端需要北京日期工具（见 A6）

// 从 sidecar 拉全量交易日，覆盖写入 trade_calendar 表
export async function syncTradeCalendar(): Promise<number> {
  const dates = await fetchTradeDates();             // string[]
  const db = getDb();
  const ins = db.prepare('INSERT OR IGNORE INTO trade_calendar (date) VALUES (?)');
  const tx = db.transaction((ds: string[]) => ds.forEach((d) => ins.run(d)));
  tx(dates);
  db.prepare("INSERT INTO kv_meta (k, v) VALUES ('trade_calendar_synced_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(new Date().toISOString());
  return dates.length;
}

function hasCalendar(): boolean {
  return (getDb().prepare('SELECT COUNT(*) n FROM trade_calendar').get() as { n: number }).n > 0;
}
function isWeekend(date: string): boolean {           // 'YYYY-MM-DD'
  const d = new Date(date + 'T00:00:00+08:00').getUTCDay(); // 0=Sun,6=Sat（用北京零点）
  return d === 0 || d === 6;
}
// 是否交易日：有日历用日历；无日历兜底「非周末=交易」
export function isTradingDay(date: string): boolean {
  if (hasCalendar()) {
    return !!getDb().prepare('SELECT 1 FROM trade_calendar WHERE date = ?').get(date);
  }
  return !isWeekend(date);
}
// 某月每天 {date, trading}
export function monthCalendar(year: number, month: number): Array<{ date: string; trading: boolean }> {
  const out: Array<{ date: string; trading: boolean }> = [];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate(); // month:1-12
  for (let d = 1; d <= days; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push({ date, trading: isTradingDay(date) });
  }
  return out;
}
// 严格早于 date 的最近交易日；无日历兜底回退到最近的非周末
export function lastTradingDayBefore(date: string): string {
  const db = getDb();
  if (hasCalendar()) {
    const row = db.prepare('SELECT date FROM trade_calendar WHERE date < ? ORDER BY date DESC LIMIT 1').get(date) as { date: string } | undefined;
    if (row) return row.date;
  }
  // 兜底：往前找最近一个非周末
  const d = new Date(date + 'T00:00:00+08:00');
  for (let i = 1; i <= 10; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const s = d.toISOString().slice(0, 10);
    if (!isWeekend(s)) return s;
  }
  return date;
}
```

**A4. sidecar 客户端**（`backend/src/data/sidecar.ts`）：加
```ts
export async function fetchTradeDates(): Promise<string[]> {
  const r = await callSidecar('/trade-calendar');   // 沿用本文件既有的 sidecar 调用方式
  return (r?.dates as string[]) || [];
}
```
（实现时按 `sidecar.ts` 现有的请求封装/baseUrl 解析方式来写；本函数返回交易日数组。）

**A5. 路由 `GET /api/data/trade-calendar?year=&month=`**（`backend/src/routes/data.ts`）：
```ts
router.get('/trade-calendar', (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  successResponse(res, { year, month, days: tradeCal.monthCalendar(year, month) });
});
```
注册在已有的 `/:job/*` 之类通配路由**之前**，避免被遮蔽（与 `/news/log` 等同样处理）。

**A6. 北京日期工具（后端）**：`meetings/service.today()` 已是北京日历日。trade-calendar 服务里需要「北京今天」直接复用 `meetings.today()` 或内联 `new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})`（避免 import cycle，内联即可）。

### B. 前端日历按钮 + 弹窗

`frontend/src/api/data.ts` 加：
```ts
tradeCalendar: (year: number, month: number) =>
  api.get('/data/trade-calendar?year=' + year + '&month=' + month)
     .then((r) => r.data.data as { year: number; month: number; days: Array<{ date: string; trading: boolean }> }),
```

`HomeView.vue`（`ops-side` 最底部，所有现有按钮之后）：
- 按钮：`<button class="ops-btn" @click="toggleCalendar">📅 A 股日历</button>`，外层包一个 `position: relative` 容器，弹窗 `position:absolute; bottom:100%`（在按钮**上方**弹出）。
- 状态：`calOpen`、`calYear`、`calMonth`（默认北京当前年月）、`calDays`（拉取结果）、`calLoading`。
- `toggleCalendar()`：切换 `calOpen`，打开时若未加载则 `loadCalendar()`。
- `loadCalendar()`：`calDays = (await dataApi.tradeCalendar(calYear, calMonth)).days`。
- 翻月：`prevMonth()/nextMonth()` 调整 calYear/calMonth 后 `loadCalendar()`。
- 网格：周一~周日表头；首日前按星期补空格（北京 `getUTCDay` of `date+T00:00:00+08:00`）；每个日子：休市（`!trading`）置灰 + 角标「休」；今天（== 北京 today）高亮。
- 纯展示，点日子无动作（YAGNI）。
- 新增 scoped CSS：`.cal-wrap{position:relative}`、`.cal-pop{position:absolute;bottom:100%;right:0;...白底圆角阴影,z-index}`、`.cal-grid`、`.cal-cell`、`.cal-cell.closed`、`.cal-cell.today` 等。

### C. cron 改动

**C1. 休市日跳过开会** `backend/src/cron/meetings.ts`：`runMeetings` 开头：
```ts
import { isTradingDay } from '../data/trade-calendar';
import { today } from '../meetings/service';
// ...
if (!isTradingDay(today())) { console.log(`[cron] ${kind} 跳过：今日休市`); return; }
```
手动路由 `meetingsApi.generate` 不变（休市可手动）。

**C2. 夜间每天采集新闻 + 同步日历** `backend/src/cron/nightly.ts`：`runNightly` 内（取得 userId 后）加：
```ts
try { await syncTradeCalendar(); } catch { /* ignore */ }   // 每晚刷新交易日历
try { await data.refreshNews(userId); } catch { /* ignore */ } // 每天采集新闻（含休市日）入库
```
（`syncTradeCalendar` 也在服务启动时跑一次——见 D。）

### D. 启动时同步日历

`backend/src/index.ts`（启动 cron 处附近）：启动后异步 `syncTradeCalendar().catch(()=>{})` 一次，保证首跑/重启后有日历（失败则 isTradingDay 走周末兜底）。

### E. 早会新闻窗口扩大

`backend/src/meetings/service.ts`：新增/改造取新闻函数，早会用「上个交易日以来」：
```ts
import { lastTradingDayBefore } from '../data/trade-calendar';
// 北京日期 >= 上个交易日 的新闻，最近优先，最多 30
function buildMorningNewsWithIds(): { text: string; idMap: Record<string, string> } {
  const since = lastTradingDayBefore(today());           // 'YYYY-MM-DD'
  const rows = getDb().prepare(
    "SELECT id, title, collected_at FROM news_content_log ORDER BY collected_at DESC, rowid DESC LIMIT 60"
  ).all() as Array<{ id: string; title: string; collected_at: string }>;
  // 过滤：collected_at 的北京日期 >= since（含 since 当天）
  const kept = rows.filter((r) => beijingDateOf(r.collected_at) >= since).slice(0, 30);
  // 拼 [N1..] 文本 + idMap（与现有 buildNewsWithIds 同格式）
  ...
}
```
- `generateMorning` 改用 `buildMorningNewsWithIds()`；`generateEvening` 仍用现有 `buildNewsWithIds()`（当天/最近 8）。
- `beijingDateOf(utcTs)`：后端内联实现（`new Date(utc).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})`，注意 sqlite 串补 'Z'）。
- 若 `kept` 为空（极端：无任何近期新闻）→ 退回 `buildNewsWithIds()` 最近 8 条，避免早会无新闻。

## Testing

- **sidecar**：手动 `curl /trade-calendar` 确认返回 dates（或在 sidecar 既有测试风格下加轻量校验；sidecar 主要靠手测）。
- **后端**（jest）：
  - `trade-calendar`：注入 trade_calendar 表数据，断言 `isTradingDay` / `monthCalendar` / `lastTradingDayBefore`；空表时走周末兜底（如某周六 isTradingDay=false，周三=true）。
  - `cron/meetings`：休市日（mock isTradingDay=false 或注入日历）`runMeetings` 不调用 generate；交易日调用。
  - `meetings`：注入 news_content_log 多条（跨「上个交易日」边界），断言早会 prompt 含上个交易日以来的新闻、且未越界包含更早的；`lastTradingDayBefore` 用注入日历。
  - 全套保持绿（195 + 新增）。
- **前端**：`vue-tsc --noEmit` 干净 + 冒烟（按钮在面板底部、点击在上方弹日历、休市置灰、今天高亮、翻月可用）。

## 默认决定（已确认）

- 早会新闻 = 上个交易日以来全部（≤30）。
- 休市日定时跳过、手动可生成。
- 日历当月 + 可翻月；休市日统一「休」置灰（不区分周末/节假日）。
- 日历源 = akshare `tool_trade_date_hist_sina`（新浪线路）+ 周末兜底；夜间同步 + 启动同步。
