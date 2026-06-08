# 聊天注入个股近期行情(上下文注入) — 设计

> 让聊天里的「来财」能回答数据问题(如「昨天收盘价多少」「近一周走势」)。当前根因:`chat()` 是单轮补全、无工具调用,聊天 prompt 里从不含原始行情,数据虽在 `quote_daily` 里却没喂给 agent。本方案用**上下文注入**先解决痛点;**工具调用(function calling)留作后续单独一期**。

日期:2026-06-08。仓库:`github.com/zmfy/stock-agent`。

## 背景 / 根因(已确认)
- `backend/src/ai/manager.ts` 的 `chat()` 只发 `messages:[{role:'user',content:prompt}]`,**无 tools/function-calling、无多轮回查**——agent 只能answer prompt 里的文字。
- `backend/src/chat/service.ts` 的 `buildPrompt`/`postMessage` 注入的 `extraContext`:个股会话=报告摘要(结论,非原始行情);普通聊天=无;其他场景=规则/纪要/选股。**都不含历史 OHLC**。
- 数据在 `quote_daily(code,date,open,high,low,close,volume)`(每股完整日线)里,且 `getStockSnapshot` 已给当前快照(close/ma20/ma60/pe/pb/ps/roe_ttm/year_high 等)。缺的只是把它喂给聊天 agent。

## 方案:回答前预取近期日线 → 注入 `extraContext`
不改 `chat()` 单轮结构。

### 1. 取数(`backend/src/data/service.ts`)
- 新增 `getRecentBars(code: string, n: number): Array<{ date: string; open: number|null; high: number|null; low: number|null; close: number|null; volume: number|null }>`
  - SQL:`SELECT date, open, high, low, close, volume FROM quote_daily WHERE code = ? ORDER BY date DESC LIMIT ?`,结果**反转为按 date 升序**返回。
  - 未知 code / 无数据 → 返回 `[]`。

### 2. 行情上下文模块(新增 `backend/src/chat/market-context.ts`)
保持 `chat/service.ts` 精简,识别 + 组装独立成模块。

- `detectStockCode(message: string): string | null`(**保守识别**)
  - 先用 `/\d{6}/` 提取候选 6 位数字;若 `getCachedName(code)` 存在(是已知股票)则返回该 code。
  - 否则:对消息做精确名称匹配——`searchStocks(message)` 的结果中,若某结果的 `name` 是 `message` 的子串(精确名命中)则返回其 code。
  - 多个互相矛盾的命中 / 无命中 → 返回 `null`(不猜)。
- `buildMarketContext(code: string, snapshot: StockSnapshot | null, bars: Bar[]): string`
  - 无 bars 且无 snapshot → 返回 `''`(调用方据此决定注入"本地暂无"提示,见 §3)。
  - 头部快照行(snapshot 非空时):`现价/ MA20/ MA60/ PE/ PB/ ROE/ 年内高`(缺失显示 `—`)。
  - 近 N 日表:每行 `日期│开│高│低│收│量`(升序;数值保留两位,量可用万手/原值,缺失 `—`)。
  - 末尾范围说明句:`以上为 <code> 最近 <bars.length> 个交易日的日线(截至 <最后一行 date>);更早的数据本地暂未提供,如需更早请到「数据」页同步。`
- 常量 `RECENT_BARS_N = 30`。

### 3. 注入(`backend/src/chat/service.ts` 的 `postMessage`)
在现有 `extraContext` 组装逻辑里增补(不破坏既有各 kind 分支):
- **个股会话(`kind === 'stock'` 且有 `ref_id`)**:在现有 `reportContext(...)` 之外,**追加**该 `ref_id` 的行情块。最终 `extra = [报告摘要, 行情块].filter(Boolean).join('\n\n')`。
  - 取 `bars = getRecentBars(ref_id, RECENT_BARS_N)`;`snap = getStockSnapshot(userId, ref_id)`(失败则 null);`ctx = buildMarketContext(ref_id, snap, bars)`。
  - 若 `bars` 为空且 `snap` 为空 → 追加一句「本地暂无 <ref_id> 的历史行情,如需我据数据回答请先到『数据』页同步该股」。
- **普通聊天(`kind === 'general'`)**:`code = detectStockCode(content)`;命中则按上面同样方式取数+组装并注入(无数据则注入"本地暂无…同步"提示);未命中 → 不注入(保持原样,agent 会请用户给代码/精确名称或按常识答)。
- **其他场景(core_principle / morning / evening / screen)**:本期不动。
- **取数异常**:`getRecentBars`/`getStockSnapshot` 抛错时安静跳过行情注入(try/catch),聊天照常进行,绝不因取数失败中断对话。

### 4. 失败/边界语义
- 「昨天」= 表里最新交易日的前一交易日那一行;模型从升序表自行读取。
- 被问超出 N 日窗口的更早日期 → 范围说明句已告知边界,agent 应如实说"只有最近约 N 个交易日的数据"。
- 不编造:prompt 明确这些数字是系统算好的、范围有限;不得臆造窗口外数据。

## 单元边界
- `getRecentBars`:纯查询,易测、不触网。
- `market-context.ts`:`detectStockCode`(纯逻辑,依赖 `getCachedName`/`searchStocks`)、`buildMarketContext`(纯格式化)——都可单测。
- `chat/service.postMessage`:仅在 `extraContext` 组装处增补两个分支,其余不动。

## 测试
- `getRecentBars`:塞入若干 `quote_daily` 行 → 返回最近 N 行、按 date 升序;未知 code 返回 `[]`;N 大于现有行数时返回全部。
- `detectStockCode`:含 6 位已知代码 → 命中;含精确股票名(先 `cacheName` 注入)→ 命中;模糊/无 → `null`。
- `buildMarketContext`:含快照头(现价/MA)、含 `日期`/`收` 列、含范围说明句;空 bars+空 snap → `''`。
- `postMessage` 集成(注入假 aiCall 捕获 prompt):
  - 个股会话(已 cache 该股 bars)→ prompt 含行情块(某日 close 数值出现)。
  - 普通聊天且消息含已知代码 → prompt 含行情块。
  - 普通聊天无代码 → prompt **不含**行情块。
- 全量 `cd backend && npm test` 绿;`cd frontend && npx vue-tsc --noEmit` 不受影响(本期无前端改动)。

## 非目标(本期不做,留后续)
- 工具调用 / function calling(让 agent 主动按需查任意股票/任意日期/横向对比)——单独一期。
- 分钟级/盘中实时历史。
- core_principle / 早晚会 / 选股 场景的数据注入。
