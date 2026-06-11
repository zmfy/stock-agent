# 小作手 1.0 · 阶段④ F：实时数据(盘口五档) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每 5 分钟、仅交易时段，用 TDX 拉「已缓存股票」的实时行情(含盘口五档)写入新表 `realtime_quote`；个股快照优先读该表(新鲜则用、否则 live 兜底)，admin 数据快照页可看五档。

**Architecture:** sidecar `/realtime` 扩展返回盘口五档(TDX `c.quotes()` 本含 bid/ask 5 档；sina 兜底亦补)。后端新表 `realtime_quote`(按 code upsert，只留最新) + `cacheRealtime`/`getRealtime`/`ingestRealtime`(交易时段闸门，遍历 `listCachedCodes`)。新 cron `realtime`(`*/5 * * * *`)走 admin 数据源用户跑 `ingestRealtime`。`getStockSnapshot` 优先读 `realtime_quote`(<2min 视为新鲜)，否则 live `fetchRealtime`。前端 `DataView` 实时现价下展示五档。

**Tech Stack:** Python FastAPI sidecar(mootdx/TDX) + Express/TS + jest + Vue 3。

参照 spec：`docs/superpowers/specs/2026-06-10-xiaozuoshou-1.0-design.md` F 节。

**关键风险/约定：**
- **TDX 列名**：mootdx `client.quotes()` 的五档列名(预期 `bid1..bid5`/`ask1..ask5`/`bid_vol1..bid_vol5`/`ask_vol1..ask_vol5`)需在容器内**实测确认**后再定稿(见 Task 1 Step 2)。
- 统一对外字段名：`bid{1..5}` / `bid{1..5}_vol` / `ask{1..5}` / `ask{1..5}_vol`(sidecar 返回、DB 列、snapshot 字段三处一致)。
- 交易时段闸门：北京时间 `isTradingDay` 且 09:30–11:30 或 13:00–15:00；`now` 可注入便于测试。
- cron 周期 `*/5 * * * *` 非「每日 HH:MM」，`CronsView` 已对 `time===null` 显示「自定义（expr）」并隐藏时间编辑器 → 无需改前端定时任务页(启停/立即跑可用)。

---

## 文件结构

- Modify `sidecar/tdx.py` — `realtime()` 加五档(F-sidecar)
- Modify `sidecar/main.py` — `/realtime` 的 sina 兜底也补五档
- Modify `backend/src/db.ts` — 新表 `realtime_quote`
- Modify `backend/src/data/service.ts` — `cacheRealtime`/`getRealtime`/`ingestRealtime`/`inTradingSession`/`toRealtimeView` + `getStockSnapshot` 优先读实时表；`isTradingDay` import
- Modify `backend/src/data/service.test.ts` — cacheRealtime/getRealtime/ingestRealtime/snapshot 测试
- Modify `backend/src/cron/shared-data.ts` — `runRealtime`
- Modify `backend/src/cron/registry.ts` — 注册 `realtime` cron
- Modify `backend/src/routes/cron.test.ts` — 断言 listCronJobs 含 realtime
- Modify `frontend/src/api/data.ts` — `StockSnapshot.realtime` 类型加五档
- Modify `frontend/src/views/DataView.vue` — 现价下展示五档

---

## Task 1: sidecar — `/realtime` 返回盘口五档

**Files:** Modify `sidecar/tdx.py`、`sidecar/main.py`

- [ ] **Step 1: 改 `tdx.py` `realtime()`(约 line 280–293)**

把 `return { ... "time": str(...) }` 的 dict 扩展为含五档。改为：
```python
def realtime(code):
    def fn(c):
        q = c.quotes(symbol=code)
        if q is None or len(q) == 0:
            return None
        r = q.iloc[0]
        out = {
            "price": _f(r.get("price")), "open": _f(r.get("open")),
            "high": _f(r.get("high")), "low": _f(r.get("low")),
            "prev_close": _f(r.get("last_close")),
            "volume": _f(r.get("vol")), "name": None,
            "time": str(r.get("servertime") or ""),
        }
        # 盘口五档（mootdx quotes 含 bid1..bid5 / ask1..ask5 + *_vol*；列名以容器实测为准）
        for i in range(1, 6):
            out[f"bid{i}"] = _f(r.get(f"bid{i}"))
            out[f"bid{i}_vol"] = _f(r.get(f"bid_vol{i}"))
            out[f"ask{i}"] = _f(r.get(f"ask{i}"))
            out[f"ask{i}_vol"] = _f(r.get(f"ask_vol{i}"))
        return out
    return _call(fn)
```

- [ ] **Step 2: 容器内实测列名，校正映射**

Run（容器名以 `docker ps` 为准，通常 `stock-agent-akshare-mcp-1`）：
```bash
docker exec stock-agent-akshare-mcp-1 python -c "import tdx; c=tdx._get_client(); q=c.quotes(symbol='600519'); print(list(q.columns))"
```
查看实际列名。若五档列不是 `bid1/bid_vol1/ask1/ask_vol1` 这套(例如是 `bid_vol1` vs `bid1_vol` 或大小写不同)，把 Step 1 里 `r.get(...)` 的列名改成实测名。**以实测为准**——这是本任务唯一的不确定点。确认 `tdx.realtime('600519')` 返回里 `bid1`/`ask1` 等有值(交易时段非空，休市可能为 0/None，但键必须在)。

- [ ] **Step 3: 改 `main.py` 的 sina 兜底(约 line 480–490)也补五档**

在 sina 兜底 `_fn()` 的 return dict 里(`"time": ...` 之后)合并五档(easyquotation sina 键为 `bid1`/`bid1_volume`/`ask1`/`ask1_volume`)：
```python
        base = {
            "price": _f(row.get("now")), "open": _f(row.get("open")),
            "high": _f(row.get("high")), "low": _f(row.get("low")),
            "prev_close": _f(row.get("close")),
            "volume": _f(row.get("volume") or row.get("turnover")),
            "name": row.get("name"),
            "time": (str(row.get("date", "")) + " " + str(row.get("time", ""))).strip(),
        }
        for i in range(1, 6):
            base[f"bid{i}"] = _f(row.get(f"bid{i}"))
            base[f"bid{i}_vol"] = _f(row.get(f"bid{i}_volume"))
            base[f"ask{i}"] = _f(row.get(f"ask{i}"))
            base[f"ask{i}_vol"] = _f(row.get(f"ask{i}_volume"))
        return base
```
(把原来的 `return { ... }` 整块替换为先构造 `base` 再补五档后 `return base`。)

- [ ] **Step 4: 重建 + 冒烟**

Run:
```bash
cd ~/projects/stock-agent && docker compose up -d --build
docker exec stock-agent-akshare-mcp-1 sh -c "curl -s localhost:8000/realtime/600519"
```
Expected: JSON 的 `data` 里含 `bid1..bid5`/`ask1..ask5`/`*_vol` 键(交易时段有值；休市可能为 0/null，但键存在)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add sidecar/tdx.py sidecar/main.py
git commit -m "feat(sidecar): /realtime 返回盘口五档(TDX 主源 + sina 兜底)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端新表 `realtime_quote`

**Files:** Modify `backend/src/db.ts`

- [ ] **Step 1: 在主 schema `db.exec` 块内、`trade_calendar` 表(约 line 335)之后、闭合的反引号 `` ` `` 之前，加新表**

```sql
    CREATE TABLE IF NOT EXISTS realtime_quote (
      code TEXT PRIMARY KEY,
      price REAL, open REAL, high REAL, low REAL, prev_close REAL, volume REAL,
      bid1 REAL, bid1_vol REAL, bid2 REAL, bid2_vol REAL, bid3 REAL, bid3_vol REAL,
      bid4 REAL, bid4_vol REAL, bid5 REAL, bid5_vol REAL,
      ask1 REAL, ask1_vol REAL, ask2 REAL, ask2_vol REAL, ask3 REAL, ask3_vol REAL,
      ask4 REAL, ask4_vol REAL, ask5 REAL, ask5_vol REAL,
      time TEXT, source TEXT, fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
```
> 新建表用 `CREATE TABLE IF NOT EXISTS`，放主 init 块即可(不需 migrate)。先 Read line 335 附近确认插入点(在同一个 `db.exec(\`...\`)` 模板字符串内)。

- [ ] **Step 2: 编译检查**

Run: `cd ~/projects/stock-agent/backend && npx tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/db.ts
git commit -m "feat(db): 新增 realtime_quote 表(实时行情 + 盘口五档，按 code upsert)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端 `cacheRealtime` / `getRealtime`（TDD）

**Files:** Modify `backend/src/data/service.ts`、`backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `service.test.ts` 末尾）

```ts
describe('realtime_quote', () => {
  const svc = require('./service');
  it('cacheRealtime/getRealtime 往返(含五档) + upsert 重置未给字段', () => {
    svc.cacheRealtime('600519', { price: 1700, open: 1690, bid1: 1699, bid1_vol: 50, ask1: 1701, ask1_vol: 60, bid5: 1695, ask5: 1705, time: '15:00:00' }, 'tdx-rt');
    const r = svc.getRealtime('600519');
    expect(r).toMatchObject({ code: '600519', price: 1700, bid1: 1699, bid1_vol: 50, ask1: 1701, ask5: 1705, source: 'tdx-rt' });
    // upsert：只给 price，其余列被重置为 null
    svc.cacheRealtime('600519', { price: 1710 }, 'sina-rt');
    const r2 = svc.getRealtime('600519');
    expect(r2.price).toBe(1710);
    expect(r2.source).toBe('sina-rt');
    expect(r2.bid1).toBeNull();
  });
  it('getRealtime 未知 code → null', () => {
    expect(svc.getRealtime('000001')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest data/service -i -t "realtime_quote"`。Expected: FAIL（`cacheRealtime is not a function`）。

- [ ] **Step 3: 实现**（加在 `service.ts` 中，靠近其它 cache 写入函数处）

```ts
// 实时行情(含盘口五档)列；fetched_at/source/code 单独处理
const RT_COLS = [
  'price', 'open', 'high', 'low', 'prev_close', 'volume',
  'bid1', 'bid1_vol', 'bid2', 'bid2_vol', 'bid3', 'bid3_vol', 'bid4', 'bid4_vol', 'bid5', 'bid5_vol',
  'ask1', 'ask1_vol', 'ask2', 'ask2_vol', 'ask3', 'ask3_vol', 'ask4', 'ask4_vol', 'ask5', 'ask5_vol',
  'time',
];

export function cacheRealtime(code: string, d: Record<string, any>, source: string): void {
  const vals = RT_COLS.map((c) => (d[c] === undefined || d[c] === null ? null : d[c]));
  getDb()
    .prepare(
      `INSERT INTO realtime_quote (code, ${RT_COLS.join(',')}, source, fetched_at)
       VALUES (?, ${RT_COLS.map(() => '?').join(',')}, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(code) DO UPDATE SET ${RT_COLS.map((c) => `${c}=excluded.${c}`).join(', ')}, source=excluded.source, fetched_at=CURRENT_TIMESTAMP`,
    )
    .run(code, ...vals, source);
}

export function getRealtime(code: string): Record<string, any> | null {
  return (getDb().prepare('SELECT * FROM realtime_quote WHERE code=?').get(code) as Record<string, any>) ?? null;
}
```

- [ ] **Step 4: 运行确认通过** — 同 Step 2。Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): cacheRealtime/getRealtime(realtime_quote 按 code upsert，含五档)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 后端 `ingestRealtime` + 交易时段闸门（TDD）

**Files:** Modify `backend/src/data/service.ts`、`backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `service.test.ts` 末尾）

```ts
describe('ingestRealtime', () => {
  const svc = require('./service');
  const sidecar = require('./sidecar');
  afterEach(() => jest.restoreAllMocks());

  it('非交易时段直接跳过、不写表', async () => {
    const sun = Date.UTC(2026, 5, 7, 2, 0, 0); // 周日 北京 10:00
    const r = await svc.ingestRealtime('uid', { now: sun });
    expect(r.skipped).toBe(true);
    expect(r.count).toBe(0);
  });

  it('交易时段遍历已缓存股票、写实时表', async () => {
    getDb().prepare("INSERT OR IGNORE INTO quote_daily (code, date, close) VALUES ('600000','2026-06-09',10)").run();
    jest.spyOn(sidecar, 'resolveSidecarBase').mockReturnValue('http://x');
    jest.spyOn(sidecar, 'fetchRealtime').mockResolvedValue({ source: 'tdx-rt', data: { price: 9.99, bid1: 9.98, bid1_vol: 10, time: '10:00:00' } });
    const wed = Date.UTC(2026, 5, 10, 2, 0, 0); // 周三 北京 10:00
    const r = await svc.ingestRealtime('uid', { now: wed });
    expect(r.skipped).toBe(false);
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(svc.getRealtime('600000')).toMatchObject({ price: 9.99, bid1: 9.98 });
  });
});
```
> 先确认 `listCachedCodes()`(service.ts:483)从哪张表取 code(预期 `quote_daily`)；若不同，把 Step 1 的 seed 改到对应表，使 `listCachedCodes()` 能返回 `600000`。

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest data/service -i -t "ingestRealtime"`。Expected: FAIL（`ingestRealtime is not a function`）。

- [ ] **Step 3: 实现**（在 `service.ts`：① 顶部 `import { lastTradingDayBefore } from './trade-calendar';` 改为 `import { lastTradingDayBefore, isTradingDay } from './trade-calendar';`；② 加下列函数，靠近 `cacheRealtime`）

```ts
// 北京时间是否在交易时段(09:30–11:30 / 13:00–15:00)的交易日内
export function inTradingSession(nowMs: number = Date.now()): boolean {
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  const dateStr = bj.toISOString().slice(0, 10);
  if (!isTradingDay(dateStr)) return false;
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return (mins >= 9 * 60 + 30 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins <= 15 * 60);
}

export async function ingestRealtime(userId: string, opts: { now?: number } = {}): Promise<{ skipped: boolean; count: number }> {
  const now = opts.now ?? Date.now();
  if (!inTradingSession(now)) {
    console.log('[realtime] 非交易时段，跳过');
    return { skipped: true, count: 0 };
  }
  const base = resolveSidecarBase(userId);
  if (!base) return { skipped: true, count: 0 };
  const codes = listCachedCodes();
  let count = 0;
  for (const code of codes) {
    try {
      const rt = await fetchRealtime(base, code);
      if (rt && rt.data && (rt.data as any).price != null) {
        cacheRealtime(code, rt.data as Record<string, any>, rt.source ?? 'tdx-rt');
        count++;
      }
    } catch {
      /* 单只失败跳过，不中断整轮 */
    }
  }
  console.log(`[realtime] 写入 ${count}/${codes.length} 只`);
  return { skipped: false, count };
}
```

- [ ] **Step 4: 运行确认通过** — 同 Step 2。Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): ingestRealtime 交易时段闸门 + 遍历已缓存股票写实时表

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: cron `realtime` 注册

**Files:** Modify `backend/src/cron/shared-data.ts`、`backend/src/cron/registry.ts`、`backend/src/routes/cron.test.ts`

- [ ] **Step 1: 在 `shared-data.ts` 加 `runRealtime`**

`shared-data.ts` 顶部 import 改：把 `import { syncStockUniverse, ingestEod, getSyncStatus } from '../data/service';` 增补为含 `ingestRealtime`：
```ts
import { syncStockUniverse, ingestEod, getSyncStatus, ingestRealtime } from '../data/service';
import { getDb } from '../db';
```
(`getDb` 行已存在于文件首，勿重复。)然后加：
```ts
// 实时行情：用 admin(数据源用户)身份，仅交易时段拉已缓存股票盘口
function pickRealtimeUserId(): string | null {
  const row = getDb().prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

export async function runRealtime(): Promise<void> {
  const userId = pickRealtimeUserId();
  if (!userId) return;
  await ingestRealtime(userId);
}
```

- [ ] **Step 2: 在 `registry.ts` 注册**

2a. 顶部 import 改：`import { runStockUniverse, runEod } from './shared-data';` → `import { runStockUniverse, runEod, runRealtime } from './shared-data';`

2b. `CRON_JOBS` 数组末尾(`eod` 项之后)加：
```ts
  { key: 'realtime', label: '实时行情(交易时段)', description: 'TDX 拉已缓存股票实时盘口五档，每5分钟、仅交易时段', defaultExpr: '*/5 * * * *', run: () => runRealtime() },
```

- [ ] **Step 3: cron.test.ts 断言 realtime 已注册**

在 `backend/src/routes/cron.test.ts` 中，找到拉取定时任务列表(`GET /api/cron` 或类似)的测试，在其后追加(若已有列表变量复用之；否则新增一例)：
```ts
  it('定时任务列表含 realtime(自定义周期，非每日 time)', async () => {
    const res = await request(app).get('/api/cron').set(adminHeader());
    expect(res.status).toBe(200);
    const rt = res.body.data.jobs.find((j: any) => j.key === 'realtime');
    expect(rt).toBeTruthy();
    expect(rt.time).toBeNull();        // */5 非每日 → time 为 null
    expect(rt.expr).toBe('*/5 * * * *');
  });
```
> 先读 `cron.test.ts` 顶部，复用其已有的 app、admin 鉴权 header 辅助(名字可能是 `h()`/`adminHeader()`/`tok`，按文件实际改)与列表路径(确认是 `/api/cron` 还是别的；`res.body.data.jobs` 结构按 listCronJobs 返回)。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `cd ~/projects/stock-agent/backend && npx jest cron -i` 然后 `npm test`
Expected: 全绿(含新 realtime 断言)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/cron/shared-data.ts backend/src/cron/registry.ts backend/src/routes/cron.test.ts
git commit -m "feat(cron): 注册 realtime 实时行情任务(*/5，交易时段，拉已缓存股票)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `getStockSnapshot` 优先读 `realtime_quote`（TDD）

**Files:** Modify `backend/src/data/service.ts`、`backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `service.test.ts` 末尾）

```ts
describe('getStockSnapshot 优先实时表', () => {
  const svc = require('./service');
  const sidecar = require('./sidecar');
  afterEach(() => jest.restoreAllMocks());

  it('实时表新鲜(<2min)时用表数据(含五档)、不调 live', async () => {
    svc.cacheRealtime('600000', { price: 12.3, bid1: 12.29, bid1_vol: 100, ask1: 12.31, time: '10:00:00' }, 'tdx-rt');
    const spy = jest.spyOn(sidecar, 'fetchRealtime').mockResolvedValue(null);
    const snap = await svc.getStockSnapshot('uid', '600000');
    expect(snap.realtime).toMatchObject({ price: 12.3, bid1: 12.29, bid1_vol: 100, ask1: 12.31 });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest data/service -i -t "优先实时表"`。Expected: FAIL（当前总是调 live，spy 被调用 / 无五档）。

- [ ] **Step 3: 实现**

3a. 加规范化辅助(靠近 `getRealtime`)：
```ts
// 把 sidecar live 返回的 data 规范化为 snapshot.realtime 视图(含五档)
export function toRealtimeView(d: Record<string, any> | null | undefined, source: string | null): Record<string, any> | null {
  if (!d || d.price == null) return null;
  const v: Record<string, any> = { price: Number(d.price), time: String(d.time ?? ''), source };
  for (const k of ['open', 'high', 'low', 'prev_close', 'volume']) if (d[k] != null) v[k] = Number(d[k]);
  for (let i = 1; i <= 5; i++) {
    for (const s of ['bid', 'ask']) {
      if (d[`${s}${i}`] != null) v[`${s}${i}`] = Number(d[`${s}${i}`]);
      if (d[`${s}${i}_vol`] != null) v[`${s}${i}_vol`] = Number(d[`${s}${i}_vol`]);
    }
  }
  return v;
}
```

3b. 替换 `getStockSnapshot` 里的 realtime 块(现 service.ts:604–612)：
```ts
  snap.realtime = null;
  try {
    const rtRow = getRealtime(code);
    const fresh = rtRow?.fetched_at && Date.now() - Date.parse(String(rtRow.fetched_at).replace(' ', 'T') + 'Z') < 120000;
    if (fresh) {
      snap.realtime = rtRow;
    } else {
      const base = resolveSidecarBase(userId);
      if (base) {
        const rt = await fetchRealtime(base, code);
        snap.realtime = toRealtimeView(rt?.data, rt?.source ?? null);
      }
    }
  } catch {
    /* ignore */
  }
```

- [ ] **Step 4: 运行确认通过 + 全量回归** — `cd ~/projects/stock-agent/backend && npx jest data/service -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): getStockSnapshot 优先读 realtime_quote(<2min 新鲜)，live 兜底，含五档

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 前端 — 快照展示盘口五档

**Files:** Modify `frontend/src/api/data.ts`、`frontend/src/views/DataView.vue`

- [ ] **Step 1: 扩展 `StockSnapshot.realtime` 类型(api/data.ts:29)**

把：
```ts
  realtime?: { price: number; time: string; source: string | null } | null;
```
改为：
```ts
  realtime?: ({
    price: number; time: string; source: string | null;
    open?: number; high?: number; low?: number; prev_close?: number; volume?: number;
  } & Partial<Record<`bid${1 | 2 | 3 | 4 | 5}` | `bid${1 | 2 | 3 | 4 | 5}_vol` | `ask${1 | 2 | 3 | 4 | 5}` | `ask${1 | 2 | 3 | 4 | 5}_vol`, number>>) | null;
```

- [ ] **Step 2: 类型检查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 在 `DataView.vue` 实时现价块(约 line 253–256)下方加五档表**

把：
```vue
      <div v-if="snap?.realtime" class="rt">
          实时现价：<b>{{ snap.realtime.price }}</b>
          <span class="muted" v-if="snap.realtime.time"> @ {{ snap.realtime.time }}（{{ snap.realtime.source }}）</span>
      </div>
```
改为(在原内容后追加五档表，仅当有 bid1/ask1 时显示)：
```vue
      <div v-if="snap?.realtime" class="rt">
          实时现价：<b>{{ snap.realtime.price }}</b>
          <span class="muted" v-if="snap.realtime.time"> @ {{ snap.realtime.time }}（{{ snap.realtime.source }}）</span>
          <table v-if="(snap.realtime as any).bid1 != null || (snap.realtime as any).ask1 != null" class="orderbook">
            <tbody>
              <tr v-for="i in 5" :key="'a' + i" class="ask">
                <td>卖{{ 6 - i }}</td>
                <td>{{ (snap.realtime as any)['ask' + (6 - i)] ?? '—' }}</td>
                <td class="muted">{{ (snap.realtime as any)['ask' + (6 - i) + '_vol'] ?? '—' }}</td>
              </tr>
              <tr v-for="i in 5" :key="'b' + i" class="bid">
                <td>买{{ i }}</td>
                <td>{{ (snap.realtime as any)['bid' + i] ?? '—' }}</td>
                <td class="muted">{{ (snap.realtime as any)['bid' + i + '_vol'] ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
      </div>
```

- [ ] **Step 4: 五档样式**（`<style scoped>` 末尾）

```css
.orderbook { margin-top: 8px; border-collapse: collapse; font-size: 13px; }
.orderbook td { padding: 2px 12px 2px 0; }
.orderbook tr.ask td:nth-child(2) { color: #d33; }
.orderbook tr.bid td:nth-child(2) { color: #2a8a2a; }
```

- [ ] **Step 5: 类型检查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/data.ts frontend/src/views/DataView.vue
git commit -m "feat(data-ui): 个股快照展示盘口五档(卖5→卖1 / 买1→买5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收(全部 Task 完成后)

1. `cd ~/projects/stock-agent/backend && npm test` → 全绿(原 291 + 实时相关新例)。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(交易时段最佳)：`docker compose up -d --build`——
   - `docker exec stock-agent-akshare-mcp-1 sh -c "curl -s localhost:8000/realtime/600519"` → data 含五档键。
   - admin → 定时任务页见「实时行情(交易时段)」(自定义周期 */5，可启停/立即跑)；点「立即运行一次」(交易时段写表、非交易时段日志跳过)。
   - admin → 数据管理 → 查个股快照(如 600519)：实时现价下出现五档表(卖5→卖1/买1→买5)。
   - 非交易时段「立即运行」→ 日志「非交易时段，跳过」，不写表。
