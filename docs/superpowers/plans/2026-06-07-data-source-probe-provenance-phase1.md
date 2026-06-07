# 数据源探测择优 + 溯源 + 占比（第一期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 sidecar 各上游做成「可传顺序 + 带溯源」的 provider，Node 拉取前探测择优、逐条记录真实来源、算来源占比；顺带根治行情 0 成功。

**Architecture:** sidecar 每个数据端点接受 `order=` 候选顺序，按序尝试，返回 `{source, rows|data}`；新增 `GET /probe?kind=`。Node `sidecar.ts` 暴露 `probe()`，各 `fetch*` 返回 `{source,...}`；`service.ts` 拉取前探测得到顺序、`cacheQuotes` 存真实来源、统计占比写入 `sync_status`。前端数据页展示候选源探测状态与本次占比。

**Tech Stack:** Python FastAPI + AkShare（sidecar，无 pytest → 一次性验证脚本）；Node/Express + TS + better-sqlite3（jest，tmp `DATA_DIR` + `require`，`fetch` mock）；Vue3（无单测，vue-tsc + 冒烟）。

**接口契约（全计划统一，后续任务按此实现）：**
- `GET /probe?kind=quote|fundamentals|sentiment|news` → `[{ "key","label","reachable":bool,"latency_ms":int|null,"error":str|null }]`
- `GET /quote/{code}?days=120&order=tx,sina,em,baostock` → `{ "source":"tx"|null, "rows":[{date,open,high,low,close,volume}] }`
- `GET /fundamentals/{code}?order=baostock,em` → `{ "source":str|null, "data":{...} }`
- `GET /market/sentiment?order=em` → `{ "source":str|null, "data":{...} }`
- `GET /news?order=em,cjzc,cls&limit=20` → `{ "source":str|null, "rows":[{title,summary,published_at}] }`
- Node：`probe(base, kind): Promise<ProbeResult[]>`，`ProbeResult = { key:string; label:string; reachable:boolean; latencyMs:number|null; error:string|null }`
- Node：`orderedProviders(base, kind): Promise<string[]>` = reachable，按 latency 升序的 key 列表
- Node：`fetchQuotes(base, code, days?, order?): Promise<{ source:string|null; rows:QuoteRow[] } | null>`（其余 fetch* 同理带 source）

---

## Task 1: sidecar — provider 注册表 + `/probe`

**Files:**
- Modify: `sidecar/main.py`（在现有 quote/fundamentals/news/sentiment 辅助函数之后、相关路由之前插入 provider 注册表与 `/probe`）

- [ ] **Step 1: 写 provider 注册表与 probe 帮助函数**

在 `sidecar/main.py` 中（紧接 `_ak_quote` 定义之后）加入：

```python
import time

# 每类数据的候选上游 provider。fetch(code/None, days) 返回标准化结果或 None。
def _quote_em(code, days):   return _ak_quote(code, days)            # 东方财富 stock_zh_a_hist
def _quote_tx(code, days):
    df = ak.stock_zh_a_hist_tx(symbol=_mkt_prefix(code)).tail(days)
    return [{"date": str(r.get("date")), "open": _f(r.get("open")), "high": _f(r.get("high")), "low": _f(r.get("low")), "close": _f(r.get("close")), "volume": _f(r.get("amount"))} for _, r in df.iterrows()]
def _quote_sina(code, days):
    df = ak.stock_zh_a_daily(symbol=_mkt_prefix(code), adjust="qfq").tail(days)
    return [{"date": str(r.get("date")), "open": _f(r.get("open")), "high": _f(r.get("high")), "low": _f(r.get("low")), "close": _f(r.get("close")), "volume": _f(r.get("volume"))} for _, r in df.iterrows()]
def _quote_baostock(code, days): return _bs_quote(code, days)

QUOTE_PROVIDERS = [
    {"key": "tx",       "label": "腾讯",     "fn": _quote_tx},
    {"key": "sina",     "label": "新浪",     "fn": _quote_sina},
    {"key": "em",       "label": "东方财富", "fn": _quote_em},
    {"key": "baostock", "label": "BaoStock", "fn": _quote_baostock},
]

PROVIDERS = {"quote": QUOTE_PROVIDERS}  # fundamentals/sentiment/news 在 Task 3 加入

def _order_providers(kind, order):
    regs = PROVIDERS.get(kind, [])
    if not order:
        return regs
    want = [k for k in order.split(",") if k]
    by_key = {r["key"]: r for r in regs}
    picked = [by_key[k] for k in want if k in by_key]
    return picked or regs

def _probe_one(reg, kind):
    t0 = time.time()
    try:
        if kind in ("quote", "fundamentals"):
            data = _timed(lambda: reg["fn"]("600519", 5), 8)
        else:
            data = _timed(lambda: reg["fn"](None, 5), 8)
        ok = bool(data)
        return {"key": reg["key"], "label": reg["label"], "reachable": ok, "latency_ms": int((time.time() - t0) * 1000) if ok else None, "error": None if ok else "空/超时"}
    except Exception as e:
        return {"key": reg["key"], "label": reg["label"], "reachable": False, "latency_ms": None, "error": str(e)[:120]}
```

- [ ] **Step 2: 加 `/probe` 路由**

在 `sidecar/main.py` 的 `/quote/{code}` 路由附近加入：

```python
@app.get("/probe")
def probe(kind: str = "quote"):
    return [_probe_one(reg, kind) for reg in PROVIDERS.get(kind, [])]
```

- [ ] **Step 3: 重建并验证（无 pytest，用一次性脚本）**

Run:
```bash
docker compose up -d --build akshare-mcp   # 本地 dev：服务名 akshare-mcp
docker exec stock-agent-akshare-mcp-1 python -c "import urllib.request,json; print(urllib.request.urlopen('http://localhost:8000/probe?kind=quote').read().decode()[:500])"
```
Expected: 看到 4 个 provider，其中 `tx`/`sina` `reachable=true` 且有 `latency_ms`，`em`/`baostock` `reachable=false` 且带 `error`。

- [ ] **Step 4: Commit**

```bash
git add sidecar/main.py
git commit -m "feat(sidecar): provider 注册表 + /probe（探测各行情上游可达性/延迟）"
```

---

## Task 2: sidecar — `/quote/{code}` 带 order + 溯源

**Files:**
- Modify: `sidecar/main.py:255-261`（替换 `quote()` 路由）

- [ ] **Step 1: 替换 `/quote/{code}` 为按 order 尝试 + 返回 {source, rows}**

```python
@app.get("/quote/{code}")
def quote(code: str, days: int = 120, order: str = ""):
    code = code[-6:]
    for reg in _order_providers("quote", order):
        rows = _timed(lambda: reg["fn"](code, days), 10)
        if rows:
            return {"source": reg["key"], "rows": rows}
    return {"source": None, "rows": []}
```

- [ ] **Step 2: 重建并验证**

Run:
```bash
docker compose up -d --build akshare-mcp
docker exec stock-agent-akshare-mcp-1 python -c "import urllib.request,json; d=json.load(urllib.request.urlopen('http://localhost:8000/quote/600519?days=5&order=tx,sina,em,baostock')); print('source=',d['source'],'rows=',len(d['rows']))"
```
Expected: `source= tx rows= 5`（腾讯优先且可达）。

- [ ] **Step 3: Commit**

```bash
git add sidecar/main.py
git commit -m "feat(sidecar): /quote 按 order 逐源尝试并返回 {source, rows} 溯源"
```

---

## Task 3: sidecar — fundamentals / sentiment / news 同样支持 order + 溯源

**Files:**
- Modify: `sidecar/main.py`（fundamentals/news/market_sentiment 路由 + PROVIDERS 注册）

- [ ] **Step 1: 注册 fundamentals/sentiment/news provider**

在 `PROVIDERS` 定义处替换为：

```python
def _fund_baostock(code, days): return _bs_fund(code)
def _fund_em(code, days):       return _ak_fund(code)
def _sentiment_em(_code, _days):
    return _market_sentiment_em()   # 见 Step 2：抽出现有 /market/sentiment 主体
def _news_provider(fn_name):
    def _f(_code, limit):
        f = getattr(ak, fn_name, None)
        if not f: return None
        df = f()
        rows = []
        for _, r in df.head(limit or 20).iterrows():
            title = r.get("标题") or r.get("内容") or r.get("summary")
            ts = r.get("发布时间") or r.get("时间") or r.get("datetime") or r.get("publish_time") or ""
            summary = r.get("摘要") or r.get("内容") or ""
            if title:
                rows.append({"title": str(title), "summary": str(summary)[:200], "published_at": str(ts)})
        return rows or None
    return _f

PROVIDERS = {
    "quote": QUOTE_PROVIDERS,
    "fundamentals": [
        {"key": "baostock", "label": "BaoStock", "fn": _fund_baostock},
        {"key": "em",       "label": "东方财富", "fn": _fund_em},
    ],
    "sentiment": [
        {"key": "em", "label": "东方财富", "fn": _sentiment_em},
    ],
    "news": [
        {"key": "em",   "label": "东方财富", "fn": _news_provider("stock_info_global_em")},
        {"key": "cjzc", "label": "财经早餐", "fn": _news_provider("stock_info_cjzc_em")},
        {"key": "cls",  "label": "财联社",   "fn": _news_provider("stock_info_global_cls")},
    ],
}
```

- [ ] **Step 2: 抽出 sentiment 主体并改 fundamentals/sentiment/news 路由返回 {source,...}**

把现有 `/market/sentiment` 计算逻辑抽成 `_market_sentiment_em()` 返回 dict，然后路由改为：

```python
@app.get("/fundamentals/{code}")
def fundamentals(code: str, order: str = ""):
    code = code[-6:]
    for reg in _order_providers("fundamentals", order):
        data = _timed(lambda: reg["fn"](code, 0), 10)
        if data:
            return {"source": reg["key"], "data": data}
    return {"source": None, "data": {}}

@app.get("/market/sentiment")
def market_sentiment(order: str = ""):
    for reg in _order_providers("sentiment", order):
        data = _timed(lambda: reg["fn"](None, 0), 10)
        if data:
            return {"source": reg["key"], "data": data}
    return {"source": None, "data": {}}

@app.get("/news")
def news(limit: int = 20, order: str = ""):
    for reg in _order_providers("news", order):
        rows = _timed(lambda: reg["fn"](None, limit), 10)
        if rows:
            return {"source": reg["key"], "rows": rows}
    return {"source": None, "rows": []}
```

- [ ] **Step 3: 重建并验证三类端点**

Run:
```bash
docker compose up -d --build akshare-mcp
docker exec stock-agent-akshare-mcp-1 python -c "import urllib.request,json; print('news', json.load(urllib.request.urlopen('http://localhost:8000/news?limit=3'))['source']); print('probe-fund', urllib.request.urlopen('http://localhost:8000/probe?kind=fundamentals').read().decode()[:200])"
```
Expected: news 有 `source`（如 `em`）；fundamentals probe 返回 2 个 provider 状态。

- [ ] **Step 4: Commit**

```bash
git add sidecar/main.py
git commit -m "feat(sidecar): fundamentals/sentiment/news 支持 order + {source,...} 溯源"
```

---

## Task 4: Node — `probe()` + 各 fetch\* 带 source（TDD）

**Files:**
- Modify: `backend/src/data/sidecar.ts`
- Test: `backend/src/data/sidecar.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/data/sidecar.test.ts` 顶部 require 处加入 `probe`，新增用例：

```ts
const { fetchFundamentals, fetchQuotes, fetchMarket, pingHealth, probe } = require('./sidecar');

it('probe 返回各 provider 状态数组', async () => {
  (global as any).fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: async () => [
      { key: 'tx', label: '腾讯', reachable: true, latency_ms: 120, error: null },
      { key: 'em', label: '东方财富', reachable: false, latency_ms: null, error: 'reset' },
    ] })
  );
  const r = await probe('http://x', 'quote');
  expect(r.map((p: any) => p.key)).toEqual(['tx', 'em']);
  expect(r[0].reachable).toBe(true);
  expect(r[0].latencyMs).toBe(120);
});

it('fetchQuotes 解析 {source, rows} 并带 source', async () => {
  (global as any).fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({ source: 'tx', rows: [{ date: '2026-06-01', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }] }) })
  );
  const q = await fetchQuotes('http://x', '600519', 5, ['tx', 'sina']);
  expect(q.source).toBe('tx');
  expect(q.rows[0].close).toBe(10.5);
  expect(q.rows[0].code).toBe('600519');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data/sidecar.test.ts -t "probe|source" -i`
Expected: FAIL（`probe` 未定义 / `fetchQuotes` 返回结构不符）。

- [ ] **Step 3: 改 `sidecar.ts`**

新增 `probe` 与 `orderedProviders`，并改写 `fetchQuotes`（其余 fetch* 同步改返回 source；保留旧的纯数组兼容）：

```ts
export interface ProbeResult { key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null }

export async function probe(base: string, kind: string): Promise<ProbeResult[]> {
  const data = await getJson(`${base}/probe?kind=${encodeURIComponent(kind)}`);
  if (!Array.isArray(data)) return [];
  return data.map((p: any) => ({
    key: String(p.key), label: String(p.label ?? p.key),
    reachable: !!p.reachable, latencyMs: p.latency_ms == null ? null : Number(p.latency_ms),
    error: p.error == null ? null : String(p.error),
  }));
}

export async function orderedProviders(base: string, kind: string): Promise<string[]> {
  const res = await probe(base, kind);
  return res.filter((p) => p.reachable).sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9)).map((p) => p.key);
}

function qs(order?: string[]): string {
  return order && order.length ? `&order=${order.join(',')}` : '';
}

export async function fetchQuotes(base: string, code: string, days = 120, order?: string[]): Promise<{ source: string | null; rows: QuoteRow[] } | null> {
  const data = await getJson(`${base}/quote/${code}?days=${days}${qs(order)}`);
  // 兼容旧裸数组；新结构 {source, rows}
  const arr = Array.isArray(data) ? data : data?.rows;
  if (!Array.isArray(arr)) return null;
  const source = Array.isArray(data) ? null : (data?.source ?? null);
  return {
    source,
    rows: arr.map((r: any) => ({ code, date: String(r.date), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume) })),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx jest src/data/sidecar.test.ts -i`
Expected: PASS（注意旧的「maps quote rows」用例也要改成读 `.rows`/`.source` —— 在本步同时更新该用例为 `const q = await fetchQuotes(...); expect(q.rows[0].close).toBe(10.5);`）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/data/sidecar.ts backend/src/data/sidecar.test.ts
git commit -m "feat(data): sidecar 客户端 probe() + fetchQuotes 带 source 溯源"
```

---

## Task 5: Node — `ingestEod` 探测择优 + 逐条溯源 + 占比（TDD）

**Files:**
- Modify: `backend/src/data/service.ts`（`ingestEod`、`cacheQuotes` 调用处、`setSync` 增加占比写入）
- Test: `backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/data/service.test.ts` 新增：

```ts
it('ingestEod 探测择优、按真实来源缓存并写占比', async () => {
  const svc = require('./service');
  const db = require('../db').getDb();
  db.prepare("INSERT OR IGNORE INTO stock_names (code, name) VALUES ('600519','贵州茅台'),('000001','平安银行')").run();
  // 注入数据源
  require('./sources-service').ensureSeed?.('u1');
  // mock fetch：/probe 返回 tx 可达；/quote 返回 source=tx
  (global as any).fetch = jest.fn((url: string) => {
    if (url.includes('/probe')) return Promise.resolve({ ok: true, json: async () => [{ key: 'tx', label: '腾讯', reachable: true, latency_ms: 100, error: null }] });
    return Promise.resolve({ ok: true, json: async () => ({ source: 'tx', rows: [{ date: '2026-06-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }) });
  });
  await svc.ingestEod('u1', { days: 5 });
  const st = svc.getSyncStatus('eod');
  expect(st.state).toBe('done');
  const row = db.prepare("SELECT source FROM quote_daily WHERE code='600519' LIMIT 1").get();
  expect(row.source).toBe('tx');                       // 真实来源，不再是 'eod'
  expect(st.source_breakdown).toContain('tx');         // 占比里有 tx
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data/service.test.ts -t "探测择优" -i`
Expected: FAIL（`source` 仍是 `'eod'`，无 `source_breakdown`）。

- [ ] **Step 3: 改 `ingestEod` 与 `setSync`**

`setSync` 增加可选占比参数并落到 `sync_status.message`（第一期不改表结构，占比塞进 message 的 JSON 段；第二期再独立列）：

```ts
function setSync(job: string, state: string, total: number, done: number, message: string, breakdown?: Record<string, number>): void {
  const msg = breakdown ? `${message} __SRC__${JSON.stringify(breakdown)}` : message;
  getDb().prepare(
    `INSERT INTO sync_status (job, state, total, done, message, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(job) DO UPDATE SET state=excluded.state, total=excluded.total, done=excluded.done, message=excluded.message, updated_at=CURRENT_TIMESTAMP`
  ).run(job, state, total, done, msg);
}
```

`getSyncStatus` 解析出 `source_breakdown`：

```ts
export function getSyncStatus(job = 'stock_universe'): any | null {
  const row = getDb().prepare('SELECT state, total, done, message, updated_at FROM sync_status WHERE job = ?').get(job) as any;
  if (!row) return null;
  let source_breakdown: Record<string, number> | null = null;
  const m = /__SRC__(\{.*\})\s*$/.exec(row.message || '');
  if (m) { try { source_breakdown = JSON.parse(m[1]); } catch { /* ignore */ } row.message = row.message.replace(/__SRC__\{.*\}\s*$/, '').trim(); }
  return { ...row, source_breakdown };
}
```

`ingestEod`：拉前探测拿顺序，逐条带 order，按真实 source 缓存并计数：

```ts
import { resolveSidecarBase, fetchQuotes, orderedProviders /* ...其余保持 */ } from './sidecar';

// 在取 codes 之后、循环之前：
const order = await orderedProviders(base, 'quote');     // 探测一次、整轮复用
const bySource: Record<string, number> = {};
// 循环体内：
const res = await fetchQuotes(base, codes[i], days, order);
if (res && res.rows.length) {
  cacheQuotes(res.rows, res.source ?? 'unknown');        // 真实来源
  bySource[res.source ?? 'unknown'] = (bySource[res.source ?? 'unknown'] ?? 0) + 1;
  ok++;
} else fail++;
// 结束 setSync：
const total = ok || 1;
const breakdown: Record<string, number> = {};
for (const k of Object.keys(bySource)) breakdown[k] = Math.round((bySource[k] / total) * 100);
setSync('eod', 'done', codes.length, codes.length, `完成：成功 ${ok}、失败 ${fail}`, breakdown);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx jest src/data/service.test.ts -i`
Expected: PASS（`quote_daily.source='tx'`，`source_breakdown` 含 `tx`）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): ingestEod 探测择优 + 逐条真实来源缓存 + 来源占比"
```

---

## Task 6: Node — refreshMarket/refreshNews/refreshStock(基本面) 溯源（TDD）

**Files:**
- Modify: `backend/src/data/service.ts`（`refreshNews`、market/fundamentals 刷新与 `getStockSnapshot` 的 fetch 调用）、`backend/src/data/sidecar.ts`（`fetchMarket`/`fetchNews`/`fetchFundamentals` 返回 `{source,...}`）
- Test: `backend/src/data/sidecar.test.ts`、`backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试（sidecar fetchMarket/fetchNews/fetchFundamentals 带 source）**

```ts
it('fetchMarket/fetchNews/fetchFundamentals 解析 {source, data/rows}', async () => {
  (global as any).fetch = jest.fn((u: string) => Promise.resolve({ ok: true, json: async () =>
    u.includes('/news') ? { source: 'em', rows: [{ title: 'x', summary: '', published_at: '' }] }
    : u.includes('/market') ? { source: 'em', data: { limit_up_count: 5, limit_down_count: 1, sse_ma20_slope: 0.1 } }
    : { source: 'baostock', data: { roe_ttm: 12 } } }));
  expect((await require('./sidecar').fetchMarket('http://x')).source).toBe('em');
  expect((await require('./sidecar').fetchNews('http://x', 3)).source).toBe('em');
  expect((await require('./sidecar').fetchFundamentals('http://x', '600519')).source).toBe('baostock');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data/sidecar.test.ts -t "fetchMarket/fetchNews" -i`
Expected: FAIL。

- [ ] **Step 3: 改三个 fetch\* 返回 `{source, ...}` 并更新调用方**

`sidecar.ts`：

```ts
export async function fetchMarket(base: string, order?: string[]): Promise<{ source: string | null; data: { limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null } } | null> {
  const d = await getJson(`${base}/market/sentiment${order && order.length ? `?order=${order.join(',')}` : ''}`);
  const data = d?.data ?? (d && !('source' in d) ? d : null);   // 兼容旧裸对象
  if (!data) return null;
  return { source: d?.source ?? null, data: { limit_up_count: num(data.limit_up_count), limit_down_count: num(data.limit_down_count), sse_ma20_slope: num(data.sse_ma20_slope) } };
}

export async function fetchNews(base: string, limit = 20, order?: string[]): Promise<{ source: string | null; rows: Array<{ title: string; summary: string; published_at: string }> } | null> {
  const d = await getJson(`${base}/news?limit=${limit}${order && order.length ? `&order=${order.join(',')}` : ''}`);
  const arr = Array.isArray(d) ? d : d?.rows;
  if (!Array.isArray(arr)) return null;
  return { source: Array.isArray(d) ? null : (d?.source ?? null), rows: arr.map((n: any) => ({ title: String(n.title ?? ''), summary: String(n.summary ?? ''), published_at: String(n.published_at ?? '') })).filter((n) => n.title) };
}

export async function fetchFundamentals(base: string, code: string, order?: string[]): Promise<{ source: string | null; data: Record<string, unknown> } | null> {
  const d = await getJson(`${base}/fundamentals/${code}${order && order.length ? `?order=${order.join(',')}` : ''}`);
  const data = d?.data ?? (d && !('source' in d) ? d : null);
  if (!data) return null;
  return { source: d?.source ?? null, data };
}
```

更新 `service.ts` 调用方：`refreshNews` 用 `(await fetchNews(...))?.rows`、news 表 `source` 存实际来源；market 刷新存 `market_sentiment.source`；`getStockSnapshot`/`refreshStock` 读 `(await fetchFundamentals(...))?.data`、`fundamentals.source` 存实际来源。

- [ ] **Step 4: 跑全量测试确认通过**

Run: `cd backend && npx jest -i`
Expected: PASS（全套绿；snapshot/分析相关用例若 mock 了 fetch 返回裸对象，靠上面的「兼容旧裸对象」分支仍通过）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/data/sidecar.ts backend/src/data/service.ts backend/src/data/*.test.ts
git commit -m "feat(data): market/news/fundamentals 全程溯源（存实际来源）"
```

---

## Task 7: route — `GET /api/data/probe`（TDD）

**Files:**
- Modify: `backend/src/routes/data.ts`
- Test: `backend/src/routes/data.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('GET /api/data/probe 返回各 provider 状态', async () => {
  (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [{ key: 'tx', label: '腾讯', reachable: true, latency_ms: 90, error: null }] }));
  const res = await request(app).get('/api/data/probe?kind=quote').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data[0].key).toBe('tx');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/routes/data.test.ts -t "probe" -i`
Expected: FAIL（404）。

- [ ] **Step 3: 加路由**

在 `backend/src/routes/data.ts`（仿现有 `GET /source`）加入：

```ts
router.get('/probe', async (req, res) => {
  const base = svc_sidecar.resolveSidecarBase((req as any).user.id);
  if (!base) return successResponse(res, []);
  const kind = String(req.query.kind || 'quote');
  successResponse(res, await svc_sidecar.probe(base, kind));
});
```
（`svc_sidecar` = 顶部已 import 的 `../data/sidecar`；若未引入则 `import * as svc_sidecar from '../data/sidecar'`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx jest src/routes/data.test.ts -i`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(api): GET /api/data/probe 探测各上游"
```

---

## Task 8: 前端 — 数据页展示候选源探测状态 + 本次来源占比

**Files:**
- Modify: `frontend/src/api/data.ts`、`frontend/src/views/DataView.vue`
- 验证：`npx vue-tsc --noEmit` + 容器冒烟（无前端单测，遵循现有约定）

- [ ] **Step 1: api 客户端加 probe**

在 `frontend/src/api/data.ts` 加：

```ts
probe(kind = 'quote') { return http.get(`/data/probe?kind=${kind}`).then((r) => r.data.data as Array<{ key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null }>); },
```

- [ ] **Step 2: DataView「数据源」区展示探测状态 + 占比**

在 `frontend/src/views/DataView.vue`「数据源管理」区上方加一块「行情上游」：调用 `dataApi.probe('quote')`，渲染每个 provider 的 `label`、可达徽标（✅/❌）、`latencyMs` ms、`error`；加「探测」按钮重新拉。行情库区读 `eodStatus()` 返回的 `source_breakdown`，渲染「本次来源：腾讯 92%、新浪 8%」。

```vue
<!-- 行情上游探测 -->
<section class="card">
  <h3>行情上游（探测择优）</h3>
  <button @click="runProbe">探测</button>
  <ul>
    <li v-for="p in providers" :key="p.key">
      {{ p.label }}：<span :class="p.reachable ? 'ok' : 'bad'">{{ p.reachable ? '可达' : '不可达' }}</span>
      <span v-if="p.latencyMs != null"> · {{ p.latencyMs }}ms</span>
      <span v-if="p.error" class="bad"> · {{ p.error }}</span>
    </li>
  </ul>
  <p v-if="eodBreakdown" class="muted">本次来源：{{ eodBreakdown }}</p>
</section>
```

```ts
const providers = ref<any[]>([]);
async function runProbe() { providers.value = await dataApi.probe('quote'); }
const eodBreakdown = computed(() => {
  const b = eodStatus.value?.source_breakdown; if (!b) return '';
  return Object.entries(b).map(([k, v]) => `${k} ${v}%`).join('、');
});
onMounted(runProbe);
```
（`eodStatus` 为现有轮询状态对象；确保 `eodStatus()` 透传后端的 `source_breakdown` 字段。）

- [ ] **Step 3: 验证类型 + 冒烟**

Run:
```bash
cd frontend && npx vue-tsc --noEmit
```
Expected: 0 errors。随后容器冒烟：打开数据页，「行情上游」显示腾讯/新浪「可达」，东方财富/BaoStock「不可达」；点行情库「更新」后显示来源占比。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/data.ts frontend/src/views/DataView.vue
git commit -m "feat(ui): 数据页展示行情上游探测状态 + 本次来源占比"
```

---

## Task 9: 端到端验证（本地容器）+ 部署提醒

- [ ] **Step 1: 重建全栈并实测 EOD 不再 0 成功**

Run:
```bash
docker compose up -d --build
# 触发一次 EOD（少量股票即可），观察成功数 > 0、来源为 tx/sina
docker exec stock-agent-app-1 node -e "fetch('http://akshare-mcp:8000/quote/600519?days=5&order=tx,sina,em,baostock').then(r=>r.json()).then(d=>console.log(d.source, d.rows.length))"
```
Expected: `tx 5`（或 `sina`），不再全失败。

- [ ] **Step 2: 全量后端测试绿**

Run: `cd backend && npx jest`
Expected: 全绿。

- [ ] **Step 3: 部署提醒（不在本计划自动执行）**

把改动 push 后，在 oracle：`cd ~/aTest/server_oracle_1/stock-agent && bash deploy.sh && bash start.sh`（重建含新 sidecar）。

---

## Self-Review

- **Spec 覆盖（第一期）**：provider 注册表+探测(Task1)、quote 溯源(Task2)、其余上游溯源(Task3)、Node probe+fetch 带 source(Task4/6)、ingest 择优+占比(Task5)、probe 路由(Task7)、数据页展示(Task8)、根治 0 成功(Task2/9) —— 均有任务。第二期（锁/cron/admin/data_sources 全局化）不在本计划，另起计划。
- **Placeholder**：无 TBD；每改代码步均给出真实代码。
- **类型一致**：`{source, rows}`（quote/news）、`{source, data}`（fundamentals/sentiment）、`ProbeResult.latencyMs`、`orderedProviders` 返回 `string[]`、`source_breakdown` 字段贯穿后端与前端，一致。
