# 个股信息右侧面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 个股房间右侧加信息面板：实时块(读5min缓存/非交易日收盘)、资料块(TDX F10 行业/概述/产品 + 财务)、相关热点新闻块。

**Architecture:** 后端只读接口 `GET /api/data/stock-detail/:code` 组装 `StockDetail`；实时数字来自 `realtime_quote`/`quote_daily` 缓存(被动)，资料来自 TDX F10(缓存进 `stock_profile` 表)，新闻来自 `news_title_log`。前端 `kind==='stock'` 房间 `.chat-row` 内加 `<aside class="chat-side">`。

**Tech Stack:** 后端 Express/TS + better-sqlite3 + jest；sidecar FastAPI + mootdx；前端 Vue 3。

Spec：`docs/superpowers/specs/2026-06-14-stock-detail-panel-design.md`（已提交 d12b785）。

测试命令：后端 `cd backend && npm test`；前端 `cd frontend && npm run build`（**用 build，不只 vue-tsc**——本会话曾出现 vue-tsc 漏掉的 rollup import 报错）。

## 关键文件

- `sidecar/tdx.py`：+`stock_profile(code)`（F10 解析）、`_f10_cell` 辅助
- `sidecar/main.py`：+`GET /profile/{code}`
- `backend/src/db.ts`：+`stock_profile` 建表
- `backend/src/data/sidecar.ts`：+`fetchProfile`
- `backend/src/data/service.ts`：+纯函数(`limitPctFor`/`computeLimitPrices`/`elapsedTradingMinutes`/`computeVolumeRatio`)、+`getCachedFundamentals`、+`getStockProfile`、+`relatedNews`、+`getStockDetail`
- `backend/src/data/stock-detail.test.ts`（新）、`backend/src/routes/data.test.ts`（追加）
- `backend/src/routes/data.ts`：+`GET /stock-detail/:code`
- `frontend/src/api/data.ts`：+`StockDetail` 类型、+`stockDetail()`
- `frontend/src/views/HomeView.vue`：个股房间右 `<aside>` 面板 + 5min 轮询 + 手动刷新 + 新闻内联展开

`StockDetail` 形状（贯穿前后端，务必一致）：
```ts
interface StockDetail {
  code: string; name: string | null;
  live: { basis: '实时' | '收盘'; price: number | null; prevClose: number | null; changePct: number | null;
          limitUp: number | null; limitDown: number | null; turnoverRate: number | null; volumeRatio: number | null; asOf: string | null };
  profile: { industry: string | null; summary: string | null; products: string | null;
             roeTtm: number | null; pe: number | null; pb: number | null; ps: number | null; netProfit: number | null; updatedAt: string | null };
  news: Array<{ contentId: string; title: string; collectedAt: string; related: boolean }>;
}
```

---

## Task 1: sidecar F10 个股资料解析 + 端点

**Files:** Modify `sidecar/tdx.py`、`sidecar/main.py`

- [ ] **Step 1: 在 `sidecar/tdx.py` 加解析（放在 `parse_f10_indicators` 之后）**
```python
def _f10_cell(lines, label):
    """在 F10 ｜全角竖线表里找 label 紧邻右侧单元格值。"""
    for ln in lines:
        cells = [x.strip() for x in ln.split("｜")]
        for i, cel in enumerate(cells):
            if cel.startswith(label) and i + 1 < len(cells):
                v = cells[i + 1].strip()
                if v:
                    return v
    return None


def stock_profile(code):
    """F10 公司概况(行业/概述) + 经营分析(主营产品)。返回 {industry, summary, products}，缺失为 None。"""
    out = {"industry": None, "summary": None, "products": None}
    try:
        gk = _call(lambda c: c.F10(symbol=code, name="公司概况"))
        if isinstance(gk, str) and gk:
            lines = gk.split("\n")
            out["industry"] = _f10_cell(lines, "所属行业") or _f10_cell(lines, "行业")
            comp = _f10_cell(lines, "公司名称")
            scope = _f10_cell(lines, "经营范围") or _f10_cell(lines, "主营业务")
            parts = [x for x in [comp, scope] if x]
            if parts:
                out["summary"] = ("；".join(parts))[:200]
    except Exception:
        pass
    try:
        jy = _call(lambda c: c.F10(symbol=code, name="经营分析"))
        if isinstance(jy, str) and jy:
            m = re.search(r"【1\.主营业务】(.+?)【", jy, re.S)
            if m:
                txt = re.sub(r"[┌┐└┘├┤┬┴┼─｜\s]", "", m.group(1)).strip()
                if txt:
                    out["products"] = txt[:200]
    except Exception:
        pass
    return out
```
> `re` 已在 tdx.py import（`parse_f10_indicators` 用了）。`_call` 是带锁的 TDX 客户端调用器（已存在）。

- [ ] **Step 2: 在 `sidecar/main.py` 加端点（放在 `/fundamentals/{code}` 端点附近）**
```python
@app.get("/profile/{code}")
def profile(code: str):
    code = code[-6:]
    try:
        return tdx.stock_profile(code)
    except Exception as e:
        return {"industry": None, "summary": None, "products": None, "error": str(e)[:120]}
```
> `import tdx` 已在 main.py 顶部。F10 是 TDX(TCP)，经现有 socks5 代理可用，**不走直连子进程**。

- [ ] **Step 3: 重建 sidecar 并冒烟**

Run:
```bash
docker compose -f /home/zhangjq/projects/stock-agent/docker-compose.yml up -d --build akshare-mcp
docker exec stock-agent-akshare-mcp-1 python3 -c "import tdx,json; print(json.dumps(tdx.stock_profile('600519'),ensure_ascii=False))"
```
Expected: 打印 JSON，`products` 非空（如「茅台酒及系列酒的生产与销售。」），`industry`/`summary` 尽力而为（可能 null，可接受）。

- [ ] **Step 4: 提交**
```bash
git add sidecar/tdx.py sidecar/main.py
git commit -m "feat(sidecar): /profile F10 个股资料(行业/概述/主营产品)"
```

---

## Task 2: backend stock_profile 表 + 缓存读取/抓取

**Files:** Modify `backend/src/db.ts`、`backend/src/data/sidecar.ts`、`backend/src/data/service.ts`

- [ ] **Step 1: `db.ts` 加表**（在 `realtime_quote` 建表语句之后、同一个 `db.exec` 模板串内）
```sql
    CREATE TABLE IF NOT EXISTS stock_profile (
      code TEXT PRIMARY KEY,
      industry TEXT, summary TEXT, products TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 2: `sidecar.ts` 加 `fetchProfile`**（放在 `fetchFundamentals` 附近）
```ts
export async function fetchProfile(base: string, code: string): Promise<{ industry: string | null; summary: string | null; products: string | null } | null> {
  const d = await getJson(`${base}/profile/${code}`, 12000);
  if (!d || typeof d !== 'object') return null;
  return {
    industry: d.industry ?? null,
    summary: d.summary ?? null,
    products: d.products ?? null,
  };
}
```

- [ ] **Step 3: `service.ts` 加 `getCachedFundamentals` + `getStockProfile`**（放在 `getRealtime` 之后；并在文件顶部 import 处确认已有 `fetchProfile`——在 `import { ... } from './sidecar'` 解构里加 `fetchProfile`）
```ts
export function getCachedFundamentals(code: string): Record<string, any> {
  const r = getDb().prepare('SELECT data FROM fundamentals WHERE code = ? ORDER BY date DESC LIMIT 1').get(code) as { data: string } | undefined;
  if (!r?.data) return {};
  try { return JSON.parse(r.data); } catch { return {}; }
}

export interface StockProfileRow { industry: string | null; summary: string | null; products: string | null; updatedAt: string | null; }

export async function getStockProfile(userId: string, code: string, refresh = false): Promise<StockProfileRow> {
  const db = getDb();
  const existing = db.prepare('SELECT industry, summary, products, updated_at AS updatedAt FROM stock_profile WHERE code = ?').get(code) as StockProfileRow | undefined;
  if (existing && !refresh) return existing;
  const base = resolveSidecarBase(userId);
  const fetched = base ? await fetchProfile(base, code) : null;
  if (fetched && (fetched.industry || fetched.summary || fetched.products)) {
    db.prepare(
      `INSERT INTO stock_profile (code, industry, summary, products, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(code) DO UPDATE SET industry=excluded.industry, summary=excluded.summary, products=excluded.products, updated_at=CURRENT_TIMESTAMP`
    ).run(code, fetched.industry, fetched.summary, fetched.products);
    return db.prepare('SELECT industry, summary, products, updated_at AS updatedAt FROM stock_profile WHERE code = ?').get(code) as StockProfileRow;
  }
  return existing ?? { industry: null, summary: null, products: null, updatedAt: null };
}
```
> 注：抓取失败（base 空/sidecar 挂/F10 全空）不写库——避免把 null 永久缓存、下次进房可重试。

- [ ] **Step 4: 编译检查**

Run: `cd backend && npx tsc --noEmit`
Expected: exit 0。

- [ ] **Step 5: 提交**
```bash
git add backend/src/db.ts backend/src/data/sidecar.ts backend/src/data/service.ts
git commit -m "feat(data): stock_profile 表 + getStockProfile/fetchProfile + getCachedFundamentals"
```

---

## Task 3: backend 纯函数（涨停跌停 / 已开盘分钟 / 量比）+ 单测

**Files:** Modify `backend/src/data/service.ts`；Create `backend/src/data/stock-detail.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/data/stock-detail.test.ts`**
```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sd-'));
const svc = require('./service');

describe('涨停跌停限制', () => {
  it('主板 10%、ST 5%、创业/科创 20%、北交所 30%', () => {
    expect(svc.limitPctFor('600519', '贵州茅台')).toBeCloseTo(0.10);
    expect(svc.limitPctFor('000001', '平安银行')).toBeCloseTo(0.10);
    expect(svc.limitPctFor('600519', 'ST茅台')).toBeCloseTo(0.05);
    expect(svc.limitPctFor('300750', '宁德时代')).toBeCloseTo(0.20);
    expect(svc.limitPctFor('688981', '中芯国际')).toBeCloseTo(0.20);
    expect(svc.limitPctFor('830799', '某北交所')).toBeCloseTo(0.30);
  });
  it('computeLimitPrices 四舍五入到分；prevClose 为空→null', () => {
    expect(svc.computeLimitPrices(100, '600000', '浦发银行')).toEqual({ up: 110, down: 90 });
    expect(svc.computeLimitPrices(null, '600000', 'x')).toEqual({ up: null, down: null });
  });
});

describe('量比 / 已开盘分钟', () => {
  it('elapsedTradingMinutes：10:00→30、12:00→120、收盘后→240', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 5, 12, h - 8, m); // 北京 h:m → UTC
    expect(svc.elapsedTradingMinutes(at(10, 0))).toBe(30);
    expect(svc.elapsedTradingMinutes(at(12, 0))).toBe(120);
    expect(svc.elapsedTradingMinutes(at(15, 30))).toBe(240);
    expect(svc.elapsedTradingMinutes(at(9, 0))).toBe(0);
  });
  it('computeVolumeRatio：正常算、缺失→null', () => {
    // 当日30分钟成交=均速 → 与5日均速持平 → 量比≈1
    expect(svc.computeVolumeRatio(1000, 30, 8000)).toBeCloseTo(1.0, 1);
    expect(svc.computeVolumeRatio(null, 30, 8000)).toBeNull();
    expect(svc.computeVolumeRatio(1000, 0, 8000)).toBeNull();
    expect(svc.computeVolumeRatio(1000, 30, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && npx jest data/stock-detail -i`
Expected: FAIL（`limitPctFor is not a function`）。

- [ ] **Step 3: 实现（追加到 `service.ts`）**
```ts
export function limitPctFor(code: string, name: string | null): number {
  const c = code.replace(/^(sh|sz|bj)/i, '');
  const isST = !!name && /ST/i.test(name);
  if (c.startsWith('30') || c.startsWith('688')) return 0.20; // 创业板/科创板（ST 也 20%）
  if (c.startsWith('8') || c.startsWith('4') || c.startsWith('920')) return 0.30; // 北交所
  if (isST) return 0.05; // 主板 ST
  return 0.10; // 主板
}

export function computeLimitPrices(prevClose: number | null, code: string, name: string | null): { up: number | null; down: number | null } {
  if (prevClose == null) return { up: null, down: null };
  const pct = limitPctFor(code, name);
  return { up: Math.round(prevClose * (1 + pct) * 100) / 100, down: Math.round(prevClose * (1 - pct) * 100) / 100 };
}

// 当日已交易分钟（北京时段 09:30–11:30 + 13:00–15:00，封顶 240）
export function elapsedTradingMinutes(nowMs: number = Date.now()): number {
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const o1 = 9 * 60 + 30, c1 = 11 * 60 + 30, o2 = 13 * 60, c2 = 15 * 60;
  let m = 0;
  if (mins >= o1) m += Math.min(mins, c1) - o1;
  if (mins >= o2) m += Math.min(mins, c2) - o2;
  return Math.max(0, Math.min(240, m));
}

// 量比 ≈ (当日量/已开盘分钟) / (5日均量/240)。任一缺失/非正 → null
export function computeVolumeRatio(todayVol: number | null, elapsedMin: number, avg5Vol: number | null): number | null {
  if (todayVol == null || avg5Vol == null || avg5Vol <= 0 || elapsedMin <= 0) return null;
  const ratio = (todayVol / elapsedMin) / (avg5Vol / 240);
  if (!isFinite(ratio) || ratio <= 0) return null;
  return Math.round(ratio * 100) / 100;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && npx jest data/stock-detail -i`
Expected: PASS（前两个 describe）。

- [ ] **Step 5: 提交**
```bash
git add backend/src/data/service.ts backend/src/data/stock-detail.test.ts
git commit -m "feat(data): 涨停跌停/已开盘分钟/量比 纯函数 + 单测"
```

---

## Task 4: backend relatedNews + 单测

**Files:** Modify `backend/src/data/service.ts`；Modify `backend/src/data/stock-detail.test.ts`

- [ ] **Step 1: 追加失败测试**（加到 `stock-detail.test.ts` 末尾）
```ts
describe('relatedNews', () => {
  const { recordCollected } = require('./news-log');
  it('命中股名/行业优先，不足补最近', () => {
    recordCollected([
      { title: '贵州茅台发布年度分红方案', source: 't' },
      { title: '某科技公司财报', source: 't' },
      { title: '白酒板块今日走强', source: 't' },
      { title: '大盘震荡收跌', source: 't' },
    ]);
    const out = svc.relatedNews('600519', '贵州茅台', '白酒', 3);
    expect(out.length).toBe(3);
    expect(out[0].related).toBe(true); // 含「贵州茅台」或「白酒」的排前
    expect(out.some((n: any) => n.title.includes('茅台') || n.title.includes('白酒'))).toBe(true);
    expect(out.every((n: any) => typeof n.contentId === 'string' && n.title)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && npx jest data/stock-detail -i -t relatedNews`
Expected: FAIL（`relatedNews is not a function`）。

- [ ] **Step 3: 实现**（追加到 `service.ts`；顶部确认 `import { listTitleLog } from './news-log'`——若没有则加）
```ts
export function relatedNews(
  code: string, name: string | null, industry: string | null, limit = 8
): Array<{ contentId: string; title: string; collectedAt: string; related: boolean }> {
  const rows = listTitleLog(100); // {content_id, title, collected_at, ...} 已按 collected_at desc
  const seen = new Set<string>();
  const uniq = rows.filter((r) => (seen.has(r.content_id) ? false : (seen.add(r.content_id), true)));
  const baseName = (name || '').replace(/(股份|集团|科技|控股|实业|有限公司|公司)$/g, '').trim();
  const kw = [baseName, industry || ''].filter((k) => k && k.length >= 2);
  const isRel = (t: string) => kw.some((k) => t.includes(k));
  const related = uniq.filter((r) => isRel(r.title));
  const rest = uniq.filter((r) => !isRel(r.title));
  return [...related, ...rest].slice(0, limit).map((r) => ({
    contentId: r.content_id, title: r.title, collectedAt: r.collected_at, related: isRel(r.title),
  }));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && npx jest data/stock-detail -i -t relatedNews`
Expected: PASS。

- [ ] **Step 5: 提交**
```bash
git add backend/src/data/service.ts backend/src/data/stock-detail.test.ts
git commit -m "feat(data): relatedNews(标题命中股名/行业优先,补最近)+单测"
```

---

## Task 5: backend getStockDetail 组装 + 路由 + 单测

**Files:** Modify `backend/src/data/service.ts`、`backend/src/routes/data.ts`、`backend/src/routes/data.test.ts`

- [ ] **Step 1: 实现 `getStockDetail`（追加到 `service.ts`）**
```ts
export interface StockDetail {
  code: string; name: string | null;
  live: { basis: '实时' | '收盘'; price: number | null; prevClose: number | null; changePct: number | null;
          limitUp: number | null; limitDown: number | null; turnoverRate: number | null; volumeRatio: number | null; asOf: string | null };
  profile: { industry: string | null; summary: string | null; products: string | null;
             roeTtm: number | null; pe: number | null; pb: number | null; ps: number | null; netProfit: number | null; updatedAt: string | null };
  news: Array<{ contentId: string; title: string; collectedAt: string; related: boolean }>;
}

// fetched_at(UTC 'YYYY-MM-DD HH:MM:SS') → 北京日 'YYYY-MM-DD'
function cnDateOf(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return String(ts).slice(0, 10);
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const n2 = (v: any): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export async function getStockDetail(userId: string, code: string, refresh = false): Promise<StockDetail> {
  const c = code.replace(/^(sh|sz|bj)/i, '');
  const name = getCachedName(c);
  const now = Date.now();
  const rt = getRealtime(c);
  const bars = getRecentBars(c, 6); // 升序，最多6根
  const session = inTradingSession(now);
  const today = beijingDate(now);

  let basis: '实时' | '收盘' = '收盘';
  let price: number | null = null, prevClose: number | null = null, vol: number | null = null, asOf: string | null = null;
  if (session && rt && rt.price != null && cnDateOf(rt.fetched_at) === today) {
    basis = '实时'; price = n2(rt.price); prevClose = n2(rt.prev_close); vol = n2(rt.volume); asOf = rt.fetched_at ?? null;
  } else if (bars.length) {
    const last = bars[bars.length - 1];
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    price = n2(last.close); prevClose = prev ? n2(prev.close) : null; vol = n2(last.volume); asOf = last.date;
  }
  const changePct = price != null && prevClose ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null;
  const { up: limitUp, down: limitDown } = computeLimitPrices(prevClose, c, name);

  const f = getCachedFundamentals(c);
  // 5日均量：用日线里早于当日的最近5根（bars 升序，去掉最后一根=当日）
  const priorVols = bars.slice(0, Math.max(0, bars.length - 1)).slice(-5).map((b) => n2(b.volume)).filter((x): x is number => x != null);
  const avg5 = priorVols.length ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length : null;
  const volumeRatio = basis === '实时' ? computeVolumeRatio(vol, elapsedTradingMinutes(now), avg5) : null;

  const profile = await getStockProfile(userId, c, refresh);
  const news = relatedNews(c, name, profile.industry, 8);

  return {
    code: c, name,
    live: { basis, price, prevClose, changePct, limitUp, limitDown, turnoverRate: n2(f.turnover_rate), volumeRatio, asOf },
    profile: { industry: profile.industry, summary: profile.summary, products: profile.products,
               roeTtm: n2(f.roe_ttm), pe: n2(f.pe), pb: n2(f.pb), ps: n2(f.ps), netProfit: n2(f.net_profit), updatedAt: profile.updatedAt },
    news,
  };
}
```
> `beijingDate`、`getCachedName`、`getRecentBars`、`getRealtime`、`inTradingSession` 均已在 service.ts 存在/导出。

- [ ] **Step 2: 加路由**（`routes/data.ts`，放在 `/snapshot/:code` 路由附近）
```ts
router.get('/stock-detail/:code', async (req: Request, res: Response) => {
  try {
    const detail = await svc.getStockDetail(req.user!.userId, req.params.code, req.query.refresh === '1');
    successResponse(res, detail);
  } catch (e: any) {
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `获取个股信息失败：${e?.message || ''}`);
  }
});
```
> `routes/data.ts` 顶部已 `import * as svc from '../data/service'`，且 `router.use(authMiddleware)` 已挂（确认；snapshot 路由同款鉴权）。

- [ ] **Step 3: 加 route 单测**（追加到 `backend/src/routes/data.test.ts` 内的 describe 中；参照该文件已有的登录取 token 写法 `h()`）
```ts
  it('GET /stock-detail/:code 组装实时/资料/新闻', async () => {
    const svc = require('../data/service');
    // 塞日线两根（昨收100、今收110）
    const db = require('../db').getDb();
    db.prepare("INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES ('600519','2026-06-11',100,100,100,100,1000,'t')").run();
    db.prepare("INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES ('600519','2026-06-12',100,112,99,110,1200,'t')").run();
    jest.spyOn(require('../data/sidecar'), 'fetchProfile').mockResolvedValue({ industry: '白酒', summary: '贵州茅台酒股份有限公司', products: '茅台酒及系列酒' });
    const r = await request(app).get('/api/data/stock-detail/600519').set(h());
    expect(r.status).toBe(200);
    expect(r.body.data.code).toBe('600519');
    expect(r.body.data.live.price).toBe(110);
    expect(r.body.data.live.limitUp).toBe(110); // 收盘基准:昨收100×1.1
    expect(r.body.data.profile.products).toContain('茅台');
    expect(Array.isArray(r.body.data.news)).toBe(true);
  });
```
> `h()` / `app` 见该测试文件顶部既有写法（admin token）。非交易时段跑测试 → `basis='收盘'`，用日线两根：今收110、昨收100 → limitUp=110。

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `cd backend && npx jest routes/data data/stock-detail -i` 然后 `npm test`
Expected: 全绿（含新例）。

- [ ] **Step 5: 提交**
```bash
git add backend/src/data/service.ts backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(api): GET /data/stock-detail/:code 组装个股面板数据"
```

---

## Task 6: frontend api 类型 + 方法

**Files:** Modify `frontend/src/api/data.ts`

- [ ] **Step 1: 加类型 + 方法**（类型区加 `StockDetail`；`dataApi` 对象内 `snapshot` 旁加 `stockDetail`）
```ts
export interface StockDetail {
  code: string; name: string | null;
  live: { basis: '实时' | '收盘'; price: number | null; prevClose: number | null; changePct: number | null;
          limitUp: number | null; limitDown: number | null; turnoverRate: number | null; volumeRatio: number | null; asOf: string | null };
  profile: { industry: string | null; summary: string | null; products: string | null;
             roeTtm: number | null; pe: number | null; pb: number | null; ps: number | null; netProfit: number | null; updatedAt: string | null };
  news: Array<{ contentId: string; title: string; collectedAt: string; related: boolean }>;
}
```
`dataApi` 内：
```ts
  stockDetail: (code: string, refresh = false) =>
    api.get(`/data/stock-detail/${code}${refresh ? '?refresh=1' : ''}`).then((r) => r.data.data as StockDetail),
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3: 提交**
```bash
git add frontend/src/api/data.ts
git commit -m "feat(api): dataApi.stockDetail + StockDetail 类型"
```

---

## Task 7: frontend 个股房间右侧面板

**Files:** Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 模板——在 `.chat-main` 关闭后、`.chat-row` 关闭前，加个股面板（与选股历史面板 `<aside class="chat-side">` 同级；选股面板的 `v-if` 是 `active?.kind === 'screen' && screen`，这里新增一个 `v-else-if` 或并列 `v-if`）**

在现有选股历史 `</aside>` 之后插入：
```vue
          <aside v-if="active?.kind === 'stock'" class="chat-side">
            <div class="side-head">📊 个股信息
              <button class="mini sd-refresh" :disabled="sdLoading" @click="loadStockDetail(true)">{{ sdLoading ? '…' : '🔄' }}</button>
            </div>
            <div class="side-body" v-if="stockDetail">
              <!-- ① 实时 -->
              <div class="sd-sec">
                <div class="sd-row"><b class="sd-price" :class="pctCls(stockDetail.live.changePct)">{{ fmtNum(stockDetail.live.price) }}</b>
                  <span v-if="stockDetail.live.changePct != null" :class="pctCls(stockDetail.live.changePct)">{{ stockDetail.live.changePct >= 0 ? '+' : '' }}{{ stockDetail.live.changePct.toFixed(2) }}%</span>
                  <span class="tag">{{ stockDetail.live.basis }}</span>
                </div>
                <div class="sd-grid">
                  <span>涨停 <b class="up">{{ fmtNum(stockDetail.live.limitUp) }}</b></span>
                  <span>跌停 <b class="down">{{ fmtNum(stockDetail.live.limitDown) }}</b></span>
                  <span>换手 {{ stockDetail.live.turnoverRate != null ? stockDetail.live.turnoverRate.toFixed(2) + '%' : '—' }}</span>
                  <span v-if="stockDetail.live.volumeRatio != null">量比约 {{ stockDetail.live.volumeRatio }}</span>
                </div>
                <div class="muted sd-asof" v-if="stockDetail.live.asOf">数据 {{ stockDetail.live.asOf }}</div>
              </div>
              <!-- ② 资料 -->
              <div class="sd-sec">
                <div class="sd-sub">公司资料</div>
                <div v-if="stockDetail.profile.industry" class="sd-line">行业：{{ stockDetail.profile.industry }}</div>
                <div v-if="stockDetail.profile.summary" class="sd-line">{{ stockDetail.profile.summary }}</div>
                <div v-if="stockDetail.profile.products" class="sd-line">主营：{{ stockDetail.profile.products }}</div>
                <div class="sd-grid">
                  <span>ROE {{ fmtPct(stockDetail.profile.roeTtm) }}</span>
                  <span>PE {{ fmtNum(stockDetail.profile.pe) }}</span>
                  <span>PB {{ fmtNum(stockDetail.profile.pb) }}</span>
                  <span>PS {{ fmtNum(stockDetail.profile.ps) }}</span>
                </div>
                <div v-if="!stockDetail.profile.industry && !stockDetail.profile.summary && !stockDetail.profile.products" class="muted">资料暂不可用</div>
              </div>
              <!-- ③ 相关新闻 -->
              <div class="sd-sec">
                <div class="sd-sub">相关热点新闻</div>
                <div v-for="nws in stockDetail.news" :key="nws.contentId" class="sd-news">
                  <a href="#" @click.prevent="toggleNews(nws.contentId)">{{ nws.related ? '🔵 ' : '' }}{{ nws.title }}</a>
                  <div class="muted">{{ fmtCN(nws.collectedAt) }}</div>
                  <p v-if="openNewsId === nws.contentId && openNewsBody" class="sd-newsbody">{{ openNewsBody }}</p>
                </div>
                <div v-if="!stockDetail.news.length" class="muted">暂无相关新闻。</div>
              </div>
            </div>
            <div class="side-body" v-else><span class="muted">{{ sdLoading ? '加载中…' : (sdErr || '暂无行情数据（先在本房间分析一次）') }}</span></div>
          </aside>
```

- [ ] **Step 2: script——state + 方法 + 轮询**（在 `<script setup>` 内，screen 历史相关 state 附近加）
```ts
import { type StockDetail } from '../api/data';   // 若 data api 已整体 import，则只补 StockDetail 类型
const stockDetail = ref<StockDetail | null>(null);
const sdLoading = ref(false);
const sdErr = ref('');
const openNewsId = ref<string | null>(null);
const openNewsBody = ref('');
let sdTimer: ReturnType<typeof setInterval> | null = null;

function pctCls(p: number | null) { return p == null ? '' : p >= 0 ? 'up' : 'down'; }
function fmtNum(v: number | null) { return v == null ? '—' : (Math.round(v * 100) / 100).toString(); }
function fmtPct(v: number | null) { return v == null ? '—' : v.toFixed(2) + '%'; }

async function loadStockDetail(refresh = false) {
  if (active.value?.kind !== 'stock' || !active.value.ref_id) return;
  sdLoading.value = true; sdErr.value = '';
  try { stockDetail.value = await dataApi.stockDetail(active.value.ref_id, refresh); }
  catch (e: any) { sdErr.value = e.response?.data?.message || '获取失败'; }
  finally { sdLoading.value = false; }
}
async function toggleNews(id: string) {
  if (openNewsId.value === id) { openNewsId.value = null; return; }
  openNewsId.value = id; openNewsBody.value = '';
  try { openNewsBody.value = (await dataApi.newsContent(id)).content || '（无正文）'; } catch { openNewsBody.value = '（正文加载失败）'; }
}
```

- [ ] **Step 3: 在 `open(s)` 里，进入 stock 房间时加载面板；并起/停轮询**

在 `open()` 函数的 `s.kind === 'stock'` 分支（已有 `doAnalyze` 那块）末尾加：
```ts
    stockDetail.value = null; openNewsId.value = null;
    await loadStockDetail();
    if (sdTimer) clearInterval(sdTimer);
    sdTimer = setInterval(() => { if (active.value?.kind === 'stock') loadStockDetail(); }, 5 * 60 * 1000);
```
并在 `open()` 顶部（切换会话时）清理：找到现有切会话清理处加 `if (sdTimer && s.kind !== 'stock') { clearInterval(sdTimer); sdTimer = null; }`。
在 `onBeforeUnmount`（若组件有；HomeView 用 onUnmounted？查现有）补 `if (sdTimer) clearInterval(sdTimer);`——若没有 onUnmounted 就加一个：
```ts
import { onUnmounted } from 'vue'; // 若未引入
onUnmounted(() => { if (sdTimer) clearInterval(sdTimer); });
```

- [ ] **Step 4: 样式**（`<style scoped>` 末尾；`.chat-side`/`.side-head`/`.side-body` 已存在，复用）
```css
.sd-refresh { float: right; padding: 0 6px; font-size: 12px; }
.sd-sec { padding: 8px 0; border-bottom: 1px solid #eef2fa; }
.sd-sec:last-child { border-bottom: none; }
.sd-sub { font-size: 12px; font-weight: 600; color: #2563a8; margin-bottom: 4px; }
.sd-price { font-size: 18px; }
.sd-row { display: flex; align-items: baseline; gap: 8px; }
.sd-grid { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: #555; margin-top: 4px; }
.sd-line { font-size: 12px; color: #444; line-height: 1.6; margin: 2px 0; }
.sd-asof { font-size: 11px; margin-top: 4px; }
.sd-news { font-size: 12px; padding: 4px 0; border-top: 1px solid #f0f4fa; }
.sd-news a { color: #34699a; text-decoration: none; }
.sd-newsbody { color: #555; margin: 4px 0 0; white-space: pre-wrap; }
.up { color: #d33; }
.down { color: #2a8a2a; }
```
> `.up`/`.down` 可能已存在（MarketStatusBar/此文件）——若重复定义冲突，删本处保留既有。

- [ ] **Step 5: 构建验证**

Run: `cd frontend && npm run build`
Expected: `✓ built`，无 rollup/类型错误。

- [ ] **Step 6: 重建容器 + 冒烟**

Run:
```bash
docker compose -f /home/zhangjq/projects/stock-agent/docker-compose.yml up -d --build app
```
浏览器开一个个股房间 → 右侧出现「📊 个股信息」面板：价格/涨停跌停/换手（交易时段还有量比约）、公司资料（行业/概述/主营 + ROE/PE/PB/PS）、相关新闻（点开看正文）。非交易日显示上一交易日收盘。

- [ ] **Step 7: 提交**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(stock-ui): 个股房间右侧信息面板(实时/资料/相关新闻)"
```

---

## 端到端验证（完成后）

1. `cd backend && npm test` → 全绿。
2. `cd frontend && npm run build` → `✓ built`。
3. `docker compose up -d --build`（app + akshare-mcp）。
4. 开个股房间：右侧面板三块齐全；点 🔄 刷新资料；点新闻展开正文；切到别的房间面板消失、定时器清理。
5. 非交易日：实时块 basis=收盘、显示上一交易日数据；交易时段：basis=实时、有量比约、5min 自动刷新。

## 风险 / 注意
- F10「公司概况」里**行业字段名不确定**（实测基本资料表未必有「所属行业」）→ industry 可能为 null，仅影响新闻关键词匹配（退化为只按股名），可接受。
- 量比单位依赖 realtime.volume 与 quote_daily.volume 同口径；不一致会偏大/偏小——标「约」，且仅交易时段显示。
- stock_profile 抓取失败不写库，下次进房重试；F10 首次 ~7s，已缓存后秒开。
- 个股未分析过（无 quote_daily/realtime）→ 实时块空，提示先分析一次。
