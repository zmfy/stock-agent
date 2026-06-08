# 聊天注入个股/大盘行情(动态窗口 + 按需取数) — 设计

> 让聊天里的「来财」能回答数据问题:「昨天收盘价多少」「近半年走势」「大盘近期怎么样」。根因:`chat()` 单轮、无工具调用,prompt 从不含原始行情;数据虽可得却没喂给 agent。本方案用**意图解析 + 上下文注入(按需取数)**解决;真正的 **function calling 工具调用留作后续单独一期**。

日期:2026-06-08。仓库:`github.com/zmfy/stock-agent`。

## 背景 / 根因(已确认)
- `backend/src/ai/manager.ts` `chat()` 只发 `messages:[{role:'user',content:prompt}]`——无 tools、无多轮回查,agent 只能answer prompt 里的文字。
- `chat/service.ts` 注入的 `extraContext` 都不含历史 OHLC(个股=报告摘要;普通聊天=无)。
- 数据深度现状(本设计的关键前提):
  - 个股日线在 `quote_daily(code,date,open,high,low,close,volume)`;
  - **批量日更 cron `ingestEod` 默认只取 10 天/股**;单股 `refreshStock` 取 120 天;`year_high` 读 250 天。
  - 既有坑:`getStockSnapshot` 仅在「本地一条行情都没有」时才深取 120;一旦 cron 写过 10 天即认为"有数据"不再深取 → `ma60`/`year_high` 用 ~10 天算,偏差。
  - 大盘:`market_sentiment(date PK, limit_up_count, limit_down_count, sse_ma20_slope)` 是**日期序列**(广度/情绪历史有);**上证指数点位(OHLC)历史无处存储**。

## 总体方案
回答前:解析「时间范围 + 目标(个股/大盘)」→ 按需取该范围数据(本地不够就现从 sidecar 取并缓存)→ 组装成紧凑文本注入 `extraContext`。不改 `chat()` 单轮结构(模型不决策,仅我们按意图预取一次)。

分两部分,实现先 A 后 B:
- **A. 个股动态窗口 + 按需取数**(最初痛点,先落地)+ 顺手修 snapshot 深度坑。
- **B. 大盘:上证指数点位日线(新 sidecar 能力 + 新表)+ 情绪/广度历史。**

---

## 意图解析(`backend/src/chat/market-context.ts`,纯逻辑、可单测)
- `RECENT_BARS_N = 30`(默认窗口);`MAX_BARS_N = 500`(上限)。
- `parseTimeWindow(message: string): number` — 映射中文时间词到交易日数:
  - 昨天/今天/这几天/最近几天 → 5;近一周/上周/一周 → 5;近两周/半个月 → 10;
  - 近一月/本月/一个月 → 22;近两月 → 44;近三月/一季度/季度 → 66;
  - **近半年/半年/六个月 → 120**;近一年/一年/今年以来 → 250;近两年/两年 → 480;
  - 无时间词 → `RECENT_BARS_N`(30);结果 `min(N, MAX_BARS_N)`。
- `detectTarget(message: string, sessionRefId: string | null): Target | null`,`Target = {kind:'stock', code} | {kind:'index', code} | null`:
  - 含「大盘/指数/上证/沪指/A股」→ `{index, '000001'}`(上证);含「深证/深成指」→ `{index,'399001'}`;含「创业板指」→ `{index,'399006'}`;
  - 否则含 6 位数字且 `getCachedName(code)` 存在 → `{stock, code}`;
  - 否则**精确名称**匹配:`searchStocks(message)` 结果中某 `name` 是 `message` 子串 → `{stock, code}`;
  - 否则若 `sessionRefId` 存在(个股会话)→ `{stock, sessionRefId}`;
  - 否则 → `null`(不注入)。
  - 取「第一个命中」,不猜歧义。

---

## A. 个股:动态窗口 + 按需取数

### A1. 本地取数(`backend/src/data/service.ts`)
- 新增 `getRecentBars(code, n): Bar[]` — `SELECT date,open,high,low,close,volume FROM quote_daily WHERE code=? ORDER BY date DESC LIMIT ?`,反转为**升序**返回;无数据→`[]`。`Bar = {date, open, high, low, close, volume}`(可空)。

### A2. 按需取数(`backend/src/data/service.ts`)
- 新增 `ensureStockBars(userId, code, n): Promise<Bar[]>`:
  - `local = getRecentBars(code, n)`;若 `local.length >= n` 且 `local` 最新日期是最近交易日(用 `trade-calendar.lastTradingDayBefore`/`isTradingDay` 判断"够新")→ 直接返回 `local`。
  - 否则:`base = resolveSidecarBase(userId)`;`res = await fetchQuotes(base, code, n)`(已有函数,向 sidecar 取 n 日线);`if (res?.rows.length) cacheQuotes(res.rows, res.source)`;再 `return getRecentBars(code, n)`。
  - 取数失败/无 base → 返回 `local`(可能为空),不抛错。

### A3. 顺手修 `getStockSnapshot` 深度坑(`backend/src/data/service.ts`)
- 把深取触发条件从「一条都没有」改为「**深度不足**」:
  - 现:`const haveQuotes = recentCloses(code, 1).length > 0; if (!haveQuotes || !haveFund) refreshStock(...)`
  - 改:`const depth = recentCloses(code, 60).length; if (depth < 60 || !haveFund) refreshStock(...)`(本地不足 60 根即深取,保证 ma60 准)。
- 把 `refreshStock` 的行情取数深度从 120 提到 **250**:`fetchQuotes(base, code, 250)`,使 `year_high`(读 250)也准确。
- 影响:cron 只写 10 天的股,首次看快照时会深取 250 并缓存,之后命中本地;ma60/year_high 由此准确。

### A4. 组装(`market-context.ts`)
- `buildStockContext(code, snapshot, bars): string`:
  - 头:`【<code> <name>】现价 X｜MA20 ..｜MA60 ..｜PE ..｜PB ..｜ROE ..%｜年内高 ..`(缺失 `—`);
  - 表:`日期│开│高│低│收│量`(升序;价两位小数,量保留原值/万手,缺失 `—`);
  - 末:`以上为 <code> 最近 <bars.length> 个交易日日线(截至 <末行 date>);更早数据本地暂未提供。这些数字系统已算好,请勿臆造窗口外数据。`
  - 空 bars 且空 snapshot → 返回 `''`。

---

## B. 大盘:上证指数点位日线 + 情绪/广度历史

### B1. sidecar 取指数日线(`sidecar/tdx.py` + `sidecar/main.py`)
- `tdx.py` 新增 `index_bars(code, days)`:用 mootdx 指数接口取上证/深证指数日线(指数**不需要前复权**)。
  ⚠️ mootdx 指数的确切调用方式(方法名/market 参数)**必须在容器内实连确认**——沿用 TDX 接入时的实证做法(`selfcheck`/`docker exec` 实跑),不照搬假设的 API。实测取不到 → `index_bars` 返回 `[]`,B 部分降级为「只用情绪/广度历史」。
- `main.py` 新增 `GET /index/{code}?days=N` → 返回 `{rows:[{date,open,high,low,close,volume}], source:'tdx'}`。
- 新增 `.py` 不需要(改现有两文件);`Dockerfile` 已 `COPY *.py ./`,无需改。

### B2. 后端入库 + 取数(`backend/src/db.ts` + `data/service.ts` + `data/sidecar.ts`)
- `db.ts` 新增表 `index_daily(code TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, source TEXT, fetched_at DATETIME, PRIMARY KEY(code,date))`——与个股 `quote_daily` 隔离,避开上证 `000001` 与平安银行 `000001` 撞码。
- `sidecar.ts` 新增 `fetchIndexBars(base, code, days)` → 调 `GET /index/{code}?days=N`。
- `service.ts` 新增 `cacheIndexBars(rows, source)`、`getRecentIndexBars(code, n)`(同 quote_daily 模式,查 index_daily)、`ensureIndexBars(userId, code, n)`(本地不足则 `fetchIndexBars` 入库后再读)。
- 新增 `getMarketSentimentSeries(n): Array<{date, limit_up_count, limit_down_count, sse_ma20_slope}>` — `... FROM market_sentiment ORDER BY date DESC LIMIT n`,升序返回。

### B3. 组装(`market-context.ts`)
- `buildIndexContext(code, bars, sentiment): string`:
  - 指数表:`日期│收(点位)│涨跌幅%`(涨跌幅=相邻收盘环比;升序);
  - 附最近一段情绪:`近 K 日情绪:涨停 ../跌停 ../上证20日线斜率 ..`(取 sentiment 序列末几条,或汇总趋势一句);
  - 末:范围说明句同 A4。
  - 指数无 bars 时 → 仅输出情绪/广度历史(降级)。

---

## 注入(`backend/src/chat/service.ts` `postMessage`)
在 `extraContext` 组装处增补,**不破坏既有各 kind 分支**:
- 计算 `target = detectTarget(content, session.kind==='stock' ? session.ref_id : null)`;`n = parseTimeWindow(content)`。
- `target.kind==='stock'`:`bars = await ensureStockBars(userId, code, n)`;`snap = await getStockSnapshot(userId, code).catch(()=>null)`;`mc = buildStockContext(code, snap, bars)`。
- `target.kind==='index'`:`bars = await ensureIndexBars(userId, code, n)`;`sent = getMarketSentimentSeries(min(n,30))`;`mc = buildIndexContext(code, bars, sent)`。
- 个股会话(`kind==='stock'`)即使没解析出别的 target,默认对 `ref_id` 走 stock 分支(与现有报告摘要**并存**:`extra = [报告摘要, mc].filter(Boolean).join('\n\n')`)。
- 普通聊天(`kind==='general'`):`target` 为 null → 不注入(原样)。
- 其他场景(核心原则/早晚会/选股)本期不动。
- **全程 try/catch**:取数/组装异常 → 安静跳过注入,聊天照常,绝不中断、不编数。

## token / 性能边界
- N ≤ 500、每行精简;指数另加 ≤30 条情绪。范围说明句声明边界与"勿臆造"。
- 按需取数仅在「本地不足或不够新」时联网;命中本地则零网络。每轮最多一次取数(用户已接受 ~1-2s)。

## 单元边界
- `getRecentBars`/`getRecentIndexBars`/`getMarketSentimentSeries`:纯查询。
- `ensureStockBars`/`ensureIndexBars`:本地优先 + 按需联网 + 缓存。
- `market-context.ts`:`parseTimeWindow`/`detectTarget`(纯逻辑)、`buildStockContext`/`buildIndexContext`(纯格式化)。
- `service.postMessage`:仅 `extraContext` 处增补,余不动。

## 测试
- `parseTimeWindow`:「昨天」→5、「近半年」→120、「近一年」→250、无词→30、超大→截 500。
- `detectTarget`:「大盘/上证」→index 000001;「深成指」→399001;6 位已知代码→stock;精确名(先 `cacheName`)→stock;个股会话无命中→ref_id;普通无命中→null。
- `getRecentBars`/`getRecentIndexBars`:升序、限 N、未知→空。
- `getMarketSentimentSeries`:升序、限 N。
- `ensureStockBars`:本地够新→不联网(注入假 fetch 断言未调用);本地不足→调 fetch 并缓存后返回。
- `getStockSnapshot` 深度修复:本地仅 10 根 → 触发深取(注入假 refresh 验证被调用);≥60 根→不触发。
- `buildStockContext`/`buildIndexContext`:含日期/收列、快照头/涨跌幅、范围说明句;空→`''`/降级。
- `postMessage` 集成(注入假 aiCall 捕获 prompt):个股会话含行情块;普通聊天带「近半年 + 代码」含 120 行窗口;带「大盘近半年」含指数块;普通无目标→不含。
- sidecar:`index_bars`/`/index` 的纯解析或实连自检(实连按 TDX 既有方式在容器内验)。
- 全量 `cd backend && npm test` 绿;`cd frontend && npx vue-tsc --noEmit` 不受影响(无前端改动)。

## 部署
- `docker compose up -d --build`(重建 app + sidecar,因 sidecar 加了 /index)。无新增 .py 模块(改现有),Dockerfile 不变。

## 非目标(留后续)
- function calling 工具调用(模型主动按需查任意股票/任意日期/横向对比)。
- 分钟级/盘中历史。
- 核心原则/早晚会/选股场景的数据注入。
