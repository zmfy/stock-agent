# 个股信息右侧面板 设计

**Goal:** 个股分析房间右侧加一块信息面板（与选股历史面板同布局），展示个股基本信息、实时交易信息、公司资料/财务，以及相关热点新闻。

**Architecture:** 新增后端只读接口 `GET /api/data/stock-detail/:code` 组装 `StockDetail`；前端在 `kind==='stock'` 房间的 `.chat-row` 内加右侧 `<aside class="chat-side">`。数据三块、来源/刷新策略不同：实时块被动读后端缓存（交易日 5min cron 写入、非交易日上一交易日收盘），资料块走 TDX F10（缓存进表），新闻块纯读已入库新闻。**不依赖东方财富实时接口**（本网络对其 push2 长期 RST）。

**Tech Stack:** 后端 Express/TS + better-sqlite3；sidecar FastAPI + mootdx(TDX)；前端 Vue 3。

---

## 数据可行性（已实测）

- TDX `c.F10(symbol, name="公司概况")` → 8.6k 字符，含【基本资料】（公司名称/证券简称/所属行业等）；`name="经营分析"` → 含【1.主营业务】（主营产品一句话）【2.主营构成分析】。**F10 走 TDX（TCP），经现有 socks5 代理可用**，无需直连子进程。首次调用 ~7s（选服务器），之后快。
- 东方财富个股/spot 接口（push2.eastmoney.com）在本网络 **RST 不可用** → 故**不做同板块成分**，块③改为相关新闻。
- `realtime_quote` 表由 `runRealtime`（每5min、仅交易时段）写入；`getRealtime(code)` 读缓存。`quote_daily` 存日线。`news_title_log` 由 news_sentiment（直连）写入。

## 数据形状

```ts
export interface StockDetail {
  code: string;
  name: string | null;
  // ① 实时块（被动读缓存）
  live: {
    basis: '实时' | '收盘';          // 交易日且当天缓存=实时，否则=收盘
    price: number | null;
    prevClose: number | null;
    changePct: number | null;        // (price-prevClose)/prevClose*100
    limitUp: number | null;          // 昨收×(1+涨跌幅限制)
    limitDown: number | null;
    turnoverRate: number | null;     // 换手率%（snapshot）
    volumeRatio: number | null;      // 量比（约），算不出=null
    asOf: string | null;             // 数据时间（realtime fetched_at 或日线日期）
  };
  // ② 资料块（F10 + snapshot，缓存）
  profile: {
    industry: string | null;         // 所属行业
    summary: string | null;          // 公司概述（基本资料/主营范围浓缩）
    products: string | null;         // 主营业务/产品
    roeTtm: number | null; pe: number | null; pb: number | null; ps: number | null; netProfit: number | null;
    updatedAt: string | null;
  } | null;
  // ③ 相关热点新闻
  news: Array<{ contentId: string; title: string; collectedAt: string; related: boolean }>;
}
```

## ① 实时块

读 `getRealtime(code)`（realtime_quote 缓存）与 `quote_daily`。规则：
- 交易时段且缓存 `fetched_at` 为今天（北京日）→ `basis='实时'`，price/prevClose/volume 取缓存。
- 否则 → `basis='收盘'`，price=最近一根 `quote_daily.close`，prevClose=前一根 close。
- `changePct = prevClose ? (price-prevClose)/prevClose*100 : null`。
- **涨停/跌停**：按代码/名称定限制比例 `pct`，`limitUp=round(prevClose*(1+pct),2)`、`limitDown=round(prevClose*(1-pct),2)`；prevClose 为空则 null。
  - ST/\*ST（name 含 "ST"）：主板 5%。
  - 创业板(`30`)、科创板(`688`)：20%。
  - 北交所(`8`/`4`/`920`)：30%。
  - 其余主板(`60`/`00`)：10%。
- **换手率**：取 snapshot.turnover_rate（已有，F10/流通股本算）。
- **量比（约）**：`量比 = (vol_today / elapsedMin) / (avg5Vol / 240)`，其中 vol_today=缓存 volume、elapsedMin=当日已交易分钟(9:30–11:30、13:00–15:00 累计，封顶 240)、avg5Vol=最近5根 `quote_daily.volume` 均值。任一缺失或单位不确定 → null（前端不显示）。前端标注「约」。

## ② 资料块（F10 + 缓存）

新建表 `stock_profile(code TEXT PRIMARY KEY, industry TEXT, summary TEXT, products TEXT, raw TEXT, updated_at DATETIME)`。

- sidecar 新增 `GET /profile/{code}`：TDX 进程内调 F10「公司概况」「经营分析」，解析返回 `{industry, summary, products}`：
  - `industry`：从「公司概况/基本资料」表里找「所属行业」「行业」字段（｜全角竖线表，复用 F10 解析风格）。
  - `summary`：基本资料里「公司名称/主营业务/经营范围」浓缩为 1–2 句（截断 ~200 字）。
  - `products`：经营分析「【1.主营业务】」首段文字（截断 ~200 字）。
  - 解析不到的字段返回 null；整体失败返回 `{industry:null,summary:null,products:null}`。
- backend `getStockProfile(uid, code, {refresh})`：表里有且非强制刷新→直接返回；否则调 sidecar `/profile/{code}` 写表再返回。财务 roe/pe/pb/ps/netProfit 取 snapshot（已有缓存逻辑）。

## ③ 相关热点新闻（纯读 DB）

`relatedNews(code, name, industry, limit=8)`：
- 取 `news_title_log` 最近 ~100 条（按 collected_at desc，content_id 去重）。
- `related=true` 若标题含 `name`（去掉「股份/集团/科技」等通用后缀后的主名）或 `industry` 关键词。
- 先放 related，再用最近的非 related 补足到 limit。每条 `{contentId, title, collectedAt, related}`。
- 前端点击标题 → 调 `dataApi.newsContent(contentId)` 取正文，在面板内**内联展开**（参考 DataView 的 `openNews` 模式，不弹新窗）。

## 组件边界

- **sidecar** `main.py`：新增 `@app.get("/profile/{code}")`（TDX F10 解析，进程内；解析辅助放 `tdx.py` 或 main 内）。不经直连子进程（TDX 走代理 OK）。
- **backend**：
  - `data/service.ts`：`getRealtime` 已有；新增 `getStockProfile`、量比/涨跌停纯函数、`relatedNews`、`stock_profile` 表建表（db.ts schema）。
  - `data/sidecar.ts`：`fetchProfile(base, code)`。
  - `routes/data.ts`：`GET /stock-detail/:code`（authMiddleware）组装 StockDetail；`?refresh=1` 强制刷新 profile。
- **frontend**：
  - `api/data.ts`：`StockDetail` 类型 + `stockDetail(code, refresh?)`。
  - `views/HomeView.vue`：`kind==='stock'` 时 `.chat-row` 内右侧 `<aside class="chat-side">` 渲染面板；实时块交易日每 5min 轮询 `stockDetail`（接口只读缓存，快），资料/新闻进房载入、🔄 手动刷新（`refresh=1`）。点新闻看正文、点新闻无个股跳转。

## 错误处理

- 个股无任何缓存/日线（新股未分析）：live 各字段 null，前端显示「暂无行情数据（先在本房间分析一次）」。
- F10 失败：profile 三字段 null，前端资料块显示「资料暂不可用」，财务仍按 snapshot 显示。
- 新闻为空：块③显示「暂无相关新闻」。
- 接口整体异常：前端面板显示错误行，不影响聊天主区。

## 测试

- backend 纯函数单测：涨停跌停（各板块/ST）、量比计算（正常/缺失→null）、relatedNews（命中名称/行业、不足补最近）。
- backend route 单测：`/stock-detail/:code` 鉴权、组装（mock sidecar fetchProfile、塞 realtime_quote/quote_daily/news_title_log 行）。
- sidecar：F10 解析对茅台实测（industry/summary/products 非空）——手动冒烟。
- 前端 `npm run build`（vue-tsc + vite）通过。

## 不做（YAGNI / 受限）

- **同板块成分股**：东方财富 push2 本网络 RST，砍掉，改块③相关新闻。
- 不在面板里做实时自抓；实时数字一律来自 5min cron 缓存。
- 量比为近似值（标「约」），不追求交易所口径。
