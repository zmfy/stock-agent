# 当天策略和复盘引擎 Design（替代早会/晚会）

> 用「按北京时间分时段的每日策略引擎」取代原早会/晚会(morning/evening meeting)模型：预判 / 盘中(每小时累积) / 复盘 / 休市快报四类内容，按用户生成、由用户自定义时间，统一显示在一个「当天策略和复盘」房间。

最后更新：2026-06-12。仓库：`github.com/zmfy/stock-agent`。

## 背景与目标

现状：`meetings`(kind=morning/evening) 由 `meeting_morning`(08:00)/`meeting_evening`(16:45) 两个全局 cron 生成，UI 是两个固定聊天房间（上一个改动刚把它们做成固定置顶房间）。

「早会/晚会」概念取消，改为**每日分时段策略引擎**：
- 北京时间分三段：**0–9 策略预判** / **9–15 盘中策略** / **15–24 复盘**。
- **交易日**三段都有；**休市日**只有「新闻归纳 + 可能受影响板块」（休市快报），无预判/盘中/复盘。
- 时间由**每个用户自己设定**（房间齿轮）；盘中是间隔选择（30分/1小时/2小时/无）。
- 全部按用户生成（个性化到其当前策略；无策略时只给大盘/板块/新闻）。

## 已确认决策

- 盘中：**每隔用户设定的间隔生成一条，累积成当天时间线**（不覆盖），复盘可回看整条。
- 默认时刻：预判 08:30 / 盘中间隔 60 分 / 复盘 15:30 / 休市快报 09:00（每用户可改）。
- 旧 morning/evening 两个固定房间合并为一个 `daily` 房间（📋「当天策略和复盘」）；**旧 morning/evening 聊天会话(含消息)在迁移时直接删除**。
- 调度：废弃 4 个固定全局 cron，改为**一个全局 `strategy_tick` 调度器 cron**（默认每 5 分钟）按各用户配置幂等生成；admin「定时任务」页只看到这一个 tick。
- 时间设置 UI：在「当天策略和复盘」房间顶部**齿轮 ⚙**；旧「早晚会历史」菜单改为「策略历史」。

---

## A. 数据模型

### 新表 `daily_strategy`
```sql
CREATE TABLE IF NOT EXISTS daily_strategy (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,                       -- 北京日期 YYYY-MM-DD
  phase TEXT NOT NULL,                      -- 'prejudge' | 'intraday' | 'review' | 'holiday'
  content TEXT,
  data TEXT,                                -- JSON：原始大盘/板块/新闻/讨论分解
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_daily_strategy_user_date ON daily_strategy (user_id, date, phase);
```
- `prejudge` / `review` / `holiday`：每用户每天至多 1 条 → 生成时若当天该 phase 已有则更新(upsert 语义)，否则插入。
- `intraday`：每用户每天**多条**，每次生成插入新行，按 `created_at` 升序构成当天时间线。

### 新表 `daily_strategy_config`（每用户调度）
```sql
CREATE TABLE IF NOT EXISTS daily_strategy_config (
  user_id TEXT PRIMARY KEY,
  prejudge_time TEXT DEFAULT '08:30',       -- HH:MM
  intraday_interval INTEGER DEFAULT 60,     -- 30 | 60 | 120 | 0(=无,不生成盘中)
  review_time TEXT DEFAULT '15:30',
  holiday_brief_time TEXT DEFAULT '09:00'
);
```
读取时若无行返回默认值；写入 upsert。`intraday_interval ∈ {30,60,120,0}` 校验。

### 旧数据
旧 `meetings` 表与 morning/evening 生成逻辑**退役**（代码移除/停用 cron）；旧 meetings 行**留库不删**，仅不再有 UI 入口。

## B. 生成引擎（按用户）

所有生成沿用现有 meetings 的「为有数据源的合格用户生成 + AI 角色分工(`getModelForRole`/`personaOf`)」模式；读取全局行情数据（由 nightly/eod/realtime 等数据 cron 维护，不变）。无当前策略(`getActive` 空)时只产出大盘/板块/新闻，不含个人策略建议。新写 4 套 prompt（仿 `meetings/service.ts` 现有 prompt 风格）。

- **预判 `prejudge`**：盘前。输入＝大盘预期 + 板块 + 新闻 + 当前策略 → 当天操作预判。**节后第一个交易日**：新闻取「上一交易日之后至今」累积的（含各休市日 refreshNews / 休市快报覆盖的新闻），用 `lastTradingDayBefore(today)` 界定窗口。
- **盘中 `intraday`**：交易日盘中。输入＝当前大盘走势 + 板块热度 + 当前策略 → 「用户可能的交易策略」。每条独立累积。
- **复盘 `review`**：收盘后。输入＝**今天**的 `prejudge` + 当天全部 `intraday` 条目 + 当天实际行情 → 对照总结对错。仅复盘当日。
- **休市快报 `holiday`**：休市日。输入＝新闻 + 受影响板块。无策略成分必需（可标注「可能受影响板块」）。

每个生成函数可由 ① 调度器自动触发 ② 房间内「立即生成」按钮手动触发（同一函数）。

## C. 休市日

- `isTradingDay(today北京)` 为假 → 只可能生成 `holiday`；预判/盘中/复盘的闸门都要求交易日，休市日自动跳过。
- 休市日新闻照旧由数据 cron(`nightly` refreshNews) 累积；休市快报读取当天新闻。
- 节后预判并入休市期间新闻见 B。

## D. 房间（kind=`daily`，📋「当天策略和复盘」）

按北京时间 + `isTradingDay(today)` 决定当前 phase 与显示（`dailyPhase()` 助手）：
- **交易日 0–9**：当天 `prejudge`。未生成 → 占位「预判将于 {prejudge_time} 生成」+「立即生成预判」按钮。
- **交易日 9–15**：当天 `intraday` 时间线（最新在上），顶部「📈 盘中策略」。间隔=无 → 提示「你已关闭盘中策略（齿轮里可开启）」。未到首条 → 占位 +「立即生成一条盘中」。
- **交易日 15–24**：当天 `review`，顶部「🔁 复盘」；可折叠回看当天预判 + 盘中时间线。未生成 → 占位 +「立即生成复盘」。
- **休市日全天**：当天 `holiday`，顶部「🛌 休市日·新闻与板块」。未生成 → 占位 +「立即生成快报」。
- 房间顶部 **⚙ 时间设置**（见 G）。
- **聊天注入**：用户在该房间发言时，按当前 phase 注入对应内容（预判 / 盘中全时间线 / 复盘 / 快报）+ 对应大盘上下文；framing 按 phase 切。

## E. 调度：每用户配置 + 全局 tick

- 废弃 `meeting_morning`/`meeting_evening` cron。
- 新增全局 cron **`strategy_tick`**，默认 `*/5 * * * *`（admin「定时任务」页可启停/改频率——admin 唯一可见的策略相关定时项）。
- 每次 tick，遍历**合格用户**（有数据源的普通用户），按各自 `daily_strategy_config` + 北京时间 + 交易日历，对每个 phase 做**幂等 due 检查**，满足才生成：
  - 预判：交易日 ∧ now≥`prejudge_time` ∧ 当天无 `prejudge` → 生成。
  - 盘中：交易日 ∧ 在盘中时段(9:30–11:30/13:00–15:00) ∧ `intraday_interval>0` ∧ (当天无 intraday ∨ now−最近 intraday ≥ interval 分钟) → 生成一条。
  - 复盘：交易日 ∧ now≥`review_time` ∧ 当天无 `review` → 生成。
  - 休市快报：休市日 ∧ now≥`holiday_brief_time` ∧ 当天无 `holiday` → 生成。
- tick 频率 ≤ 最细间隔（30分），默认 5 分钟即可在用户设定时刻 5 分钟内触发。生成本身重（AI），由 due 检查避免重复。

## F. 每用户时间设置（房间齿轮 ⚙）

- 后端 `GET /api/strategy/schedule`（读自己的，缺省补默认）、`PUT /api/strategy/schedule`（写自己的；校验 HH:MM 与 interval∈{30,60,120,0}）。普通用户鉴权（authMiddleware，作用于 `req.user`）。
- 前端房间顶部 ⚙ 弹出：预判时间(time input)、盘中间隔(下拉 30分/1小时/2小时/无)、复盘时间、休市快报时间；保存调 PUT。

## G. 房间合并 / 迁移 / 历史

- `ChatKind` 去掉以 morning/evening 作为房间的用法；固定房间 `FIXED_ROOM_KINDS = [core_principle, daily, screen]`，`daily` 标签「当天策略和复盘」、图标 📋。
- `ensureFixedRooms`：建 `daily` 房间并置顶；**删除该用户旧的 `morning`/`evening` 聊天会话(含消息)**。固定房间守卫(`FIXED_ROOM`→409) 保护 `daily`。
- 「早晚会历史」菜单改为「**策略历史**」，展示 `daily_strategy`（按日期列预判/盘中/复盘/快报）。

## H. 错误处理 / 边界

- 单用户单 phase 生成失败：记录错误（沿用 `noteErrorToSession`/日志），不影响其它用户/phase；tick 继续。
- 幂等：所有 due 检查基于「当天该 phase 是否已有行」（intraday 用「距最近一条 ≥ interval」），tick 重入安全。
- 无数据源 / sidecar 不可达：该用户该轮跳过（不产空内容）。
- 时区：一律北京时间（`now+8h` 取 UTC 字段，或现有 `todayCN`/`isTradingDay` 同款），不依赖服务器/用户本地时区。
- admin 纯运维无聊天，不生成策略、房间不显示。

## I. 测试

- 后端(jest)：
  - `daily_strategy` / `daily_strategy_config` 读写、默认值、interval 校验。
  - `dailyPhase()`：各时间点 + 交易日/休市日 → 正确 phase。
  - 调度 due 判断：预判/复盘/快报「当天已有则跳过」；盘中按 interval 与「距最近一条」判断、间隔=无 跳过；非交易日只快报、休市日不生成三段。
  - 节后预判新闻窗口含休市日（构造上一交易日缺口）。
  - 复盘输入含当天 prejudge + 全部 intraday。
  - `ensureFixedRooms` 迁移：建 daily、删旧 morning/evening 会话+消息、daily 置顶；固定房间守卫 409。
  - chat 注入：daily 房间按 phase 选对内容。
  - 时间设置路由：用户读写自己的、校验失败 422。
- 前端(无 runner)：`vue-tsc` + 走查——房间按 phase 显示与生成按钮、盘中时间线、⚙ 设置、策略历史视图。

## J. 不在本次范围

- 不改全局行情数据 cron（nightly/eod/stock_universe/realtime）与数据源/sidecar。
- 不做盘中逐笔/分时级别数据（盘中小结基于现有大盘/板块快照）。
- 不迁移旧 meetings 历史数据到新表（旧数据留库、无入口）。
- 不做跨用户的策略共享/广播（每用户独立）。
