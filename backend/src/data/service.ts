import { getDb } from '../db';
import { QuoteRow, StockSnapshot } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { resolveSidecarBase, fetchFundamentals, fetchQuotes, fetchMarket, fetchName, fetchNews, fetchAllStocks, orderedProviders } from './sidecar';

// ---- hot news ----
export function listNews(limit = 30): Array<{ title: string; summary: string; published_at: string; fetched_at: string }> {
  return getDb()
    .prepare('SELECT title, summary, published_at, fetched_at FROM news ORDER BY fetched_at DESC, published_at DESC LIMIT ?')
    .all(limit) as any[];
}

export async function refreshNews(userId: string, limit = 20): Promise<number> {
  const base = resolveSidecarBase(userId);
  if (!base) return 0;
  const result = await fetchNews(base, limit);
  if (!result || !result.rows.length) return 0;
  const { source: fetchSource, rows } = result;
  const srcVal = fetchSource ?? 'akshare';
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO news (id, title, summary, published_at, source, fetched_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(title, published_at) DO UPDATE SET summary=excluded.summary, source=excluded.source, fetched_at=CURRENT_TIMESTAMP`
  );
  const tx = db.transaction((items: typeof rows) => {
    for (const n of items) stmt.run(uuidv4(), n.title, n.summary, n.published_at, srcVal);
  });
  tx(rows);
  return rows.length;
}

// ---- background jobs: status helpers (keyed by job name) ----
function setSync(job: string, state: string, total: number, done: number, message: string, breakdown?: Record<string, number>): void {
  const msg = breakdown ? `${message} __SRC__${JSON.stringify(breakdown)}` : message;
  getDb()
    .prepare(
      `INSERT INTO sync_status (job, state, total, done, message, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(job) DO UPDATE SET state=excluded.state, total=excluded.total, done=excluded.done, message=excluded.message, updated_at=CURRENT_TIMESTAMP`
    )
    .run(job, state, total, done, msg);
}

export function getSyncStatus(job = 'stock_universe'): any | null {
  const row = getDb().prepare('SELECT state, total, done, message, updated_at FROM sync_status WHERE job = ?').get(job) as any;
  if (!row) return null;
  let source_breakdown: Record<string, number> | null = null;
  const m = /__SRC__(\{.*\})\s*$/.exec(row.message || '');
  if (m) { try { source_breakdown = JSON.parse(m[1]); } catch { /* ignore */ } row.message = row.message.replace(/__SRC__\{.*\}\s*$/, '').trim(); }
  return { ...row, source_breakdown };
}

// ---- EOD batch ingestion: pull daily quotes for the whole local universe into the cache ----
export async function ingestEod(userId: string, opts: { days?: number; codes?: string[] } = {}): Promise<void> {
  if (getSyncStatus('eod')?.state === 'running') return;
  const base = resolveSidecarBase(userId);
  if (!base) {
    setSync('eod', 'error', 0, 0, '没有可用的数据源');
    return;
  }
  const days = opts.days ?? 10;
  const codes = opts.codes?.length
    ? opts.codes
    : (getDb().prepare('SELECT code FROM stock_names').all() as { code: string }[]).map((r) => r.code);
  if (!codes.length) {
    setSync('eod', 'error', 0, 0, '本地股票库为空，请先在「股票库」同步');
    return;
  }
  setSync('eod', 'running', codes.length, 0, `开始拉取 ${codes.length} 只股票近 ${days} 天行情…`);
  const order = await orderedProviders(base, 'quote');
  const bySource: Record<string, number> = {};
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < codes.length; i++) {
    try {
      const res = await fetchQuotes(base, codes[i], days, order);
      if (res && res.rows.length) {
        const src = res.source ?? 'unknown';
        cacheQuotes(res.rows, src);
        bySource[src] = (bySource[src] ?? 0) + 1;
        ok++;
      } else fail++;
    } catch {
      fail++;
    }
    if (i % 20 === 0 || i === codes.length - 1) {
      setSync('eod', 'running', codes.length, i + 1, `已处理 ${i + 1}/${codes.length}，成功 ${ok}、失败 ${fail}`);
    }
    await new Promise((res) => setImmediate(res));
  }
  const denom = ok || 1;
  const breakdown: Record<string, number> = {};
  for (const k of Object.keys(bySource)) breakdown[k] = Math.round((bySource[k] / denom) * 100);
  setSync('eod', 'done', codes.length, codes.length, `完成：成功 ${ok}、失败 ${fail}`, breakdown);
}

export function countStocks(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM stock_names').get() as { n: number }).n;
}

// Fire-and-forget incremental sync: add new, update changed, delete delisted. Never throws.
export async function syncStockUniverse(userId: string): Promise<void> {
  const cur = getSyncStatus();
  if (cur?.state === 'running') return; // already in progress
  setSync('stock_universe', 'running', 0, 0, '正在获取全量股票列表…');
  try {
    const base = resolveSidecarBase(userId);
    if (!base) {
      setSync('stock_universe', 'error', 0, 0, '没有可用的数据源');
      return;
    }
    const remote = await fetchAllStocks(base);
    if (!remote || remote.length < 1000) {
      setSync('stock_universe', 'error', remote?.length ?? 0, 0, '数据源返回异常（数量过少），已跳过以免误删');
      return;
    }
    const db = getDb();
    const localRows = db.prepare('SELECT code, name, py FROM stock_names').all() as { code: string; name: string; py: string }[];
    const local = new Map(localRows.map((r) => [r.code, r]));
    const remoteCodes = new Set(remote.map((r) => r.code));

    let added = 0;
    let updated = 0;
    let deleted = 0;
    const upsert = db.prepare(
      `INSERT INTO stock_names (code, name, py, source, fetched_at) VALUES (?, ?, ?, 'akshare', CURRENT_TIMESTAMP)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, py=excluded.py, fetched_at=CURRENT_TIMESTAMP`
    );
    setSync('stock_universe', 'running', remote.length, 0, '正在比对并写入本地…');

    // batch with yields so the event loop isn't blocked and progress is visible
    for (let i = 0; i < remote.length; i += 500) {
      const batch = remote.slice(i, i + 500);
      const tx = db.transaction(() => {
        for (const r of batch) {
          const ex = local.get(r.code);
          if (!ex) added++;
          else if (ex.name !== r.name || ex.py !== r.py) updated++;
          upsert.run(r.code, r.name, r.py);
        }
      });
      tx();
      setSync('stock_universe', 'running', remote.length, Math.min(i + 500, remote.length), '正在比对并写入本地…');
      await new Promise((res) => setImmediate(res));
    }
    // delete delisted (codes locally but not in remote)
    const delTx = db.transaction(() => {
      for (const code of local.keys()) {
        if (!remoteCodes.has(code)) {
          db.prepare('DELETE FROM stock_names WHERE code = ?').run(code);
          deleted++;
        }
      }
    });
    delTx();
    setSync('stock_universe', 'done', remote.length, remote.length, `完成：新增 ${added}、更新 ${updated}、删除 ${deleted}，共 ${remote.length} 只`);
  } catch (e) {
    setSync('stock_universe', 'error', 0, 0, `同步失败：${(e as Error).message}`);
  }
}

export function searchStocks(q: string, limit = 20): Array<{ code: string; name: string }> {
  const s = q.trim();
  if (!s) return [];
  const like = `%${s}%`;
  const lower = s.toLowerCase();
  // py 现在可能是空格分隔的多个候选(多音字)，如 "zlkj clkj"。
  // 匹配「首候选前缀」(lower%) 或「后续候选前缀」(% lower%)，两者都支持前缀输入。
  return getDb()
    .prepare(
      `SELECT code, name FROM stock_names
       WHERE code LIKE ? OR name LIKE ? OR py LIKE ? OR py LIKE ?
       ORDER BY (CASE
                   WHEN code = ? THEN 0
                   WHEN py = ? OR py LIKE ? THEN 1
                   WHEN code LIKE ? THEN 2
                   ELSE 3 END), code
       LIMIT ?`
    )
    .all(`${s}%`, like, `${lower}%`, `% ${lower}%`, s, lower, `% ${lower} %`, `${s}%`, limit) as Array<{ code: string; name: string }>;
}

export function getCachedName(code: string): string | null {
  const row = getDb().prepare('SELECT name FROM stock_names WHERE code = ?').get(code) as { name: string } | undefined;
  return row?.name ?? null;
}

export function cacheName(code: string, name: string, source = 'akshare'): void {
  getDb()
    .prepare('INSERT INTO stock_names (code, name, source, fetched_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(code) DO UPDATE SET name=excluded.name, source=excluded.source, fetched_at=CURRENT_TIMESTAMP')
    .run(code, name, source);
}

// Resolve a stock's name independently of the (flaky) fundamentals fetch. Cached.
export async function getStockName(userId: string, code: string): Promise<string | null> {
  const cached = getCachedName(code);
  if (cached) return cached;
  const base = resolveSidecarBase(userId);
  if (!base) return null;
  const name = await fetchName(base, code);
  if (name) cacheName(code, name);
  return name;
}

function latestQuoteRow(code: string): { source: string; date: string; fetched_at: string } | null {
  return (getDb()
    .prepare('SELECT source, date, fetched_at FROM quote_daily WHERE code = ? ORDER BY date DESC LIMIT 1')
    .get(code) as any) ?? null;
}
function latestFundRow(code: string): { source: string; date: string; fetched_at: string } | null {
  return (getDb()
    .prepare('SELECT source, date, fetched_at FROM fundamentals WHERE code = ? ORDER BY date DESC LIMIT 1')
    .get(code) as any) ?? null;
}
function latestMarketRow(): { source: string; date: string; fetched_at: string } | null {
  return (getDb()
    .prepare('SELECT source, date, fetched_at FROM market_sentiment ORDER BY date DESC LIMIT 1')
    .get() as any) ?? null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- cache writers ----

export function cacheQuotes(rows: QuoteRow[], source: string): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO quote_daily (code, date, open, high, low, close, volume, source, fetched_at)
     VALUES (@code, @date, @open, @high, @low, @close, @volume, @source, CURRENT_TIMESTAMP)
     ON CONFLICT(code, date) DO UPDATE SET
       open=@open, high=@high, low=@low, close=@close, volume=@volume, source=@source, fetched_at=CURRENT_TIMESTAMP`
  );
  const tx = db.transaction((items: QuoteRow[]) => {
    for (const r of items) stmt.run({ ...r, source });
  });
  tx(rows);
  return rows.length;
}

export function cacheFundamentals(code: string, date: string, data: Record<string, unknown>, source: string): void {
  getDb()
    .prepare(
      `INSERT INTO fundamentals (code, date, data, source, fetched_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(code, date) DO UPDATE SET data=excluded.data, source=excluded.source, fetched_at=CURRENT_TIMESTAMP`
    )
    .run(code, date, JSON.stringify(data), source);
}

export function cacheMarket(
  date: string,
  m: { limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null },
  source: string
): void {
  getDb()
    .prepare(
      `INSERT INTO market_sentiment (date, limit_up_count, limit_down_count, sse_ma20_slope, data, source, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(date) DO UPDATE SET limit_up_count=excluded.limit_up_count, limit_down_count=excluded.limit_down_count,
         sse_ma20_slope=excluded.sse_ma20_slope, data=excluded.data, source=excluded.source, fetched_at=CURRENT_TIMESTAMP`
    )
    .run(date, m.limit_up_count, m.limit_down_count, m.sse_ma20_slope, JSON.stringify(m), source);
}

// ---- cache readers ----

function latestFundamentals(code: string): Record<string, any> | null {
  const row = getDb()
    .prepare('SELECT data FROM fundamentals WHERE code = ? ORDER BY date DESC LIMIT 1')
    .get(code) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function recentCloses(code: string, n: number): number[] {
  const rows = getDb()
    .prepare('SELECT close FROM quote_daily WHERE code = ? AND close IS NOT NULL ORDER BY date DESC LIMIT ?')
    .all(code, n) as { close: number }[];
  return rows.map((r) => r.close);
}

function latestMarket(): { limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null } | null {
  return getDb()
    .prepare('SELECT limit_up_count, limit_down_count, sse_ma20_slope FROM market_sentiment ORDER BY date DESC LIMIT 1')
    .get() as any;
}

function mean(arr: number[]): number | null {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

export function getLatestMarket(): { date: string; limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null } | null {
  return getDb()
    .prepare('SELECT date, limit_up_count, limit_down_count, sse_ma20_slope FROM market_sentiment ORDER BY date DESC LIMIT 1')
    .get() as any;
}

export function listCachedCodes(): string[] {
  return (getDb().prepare('SELECT DISTINCT code FROM quote_daily').all() as { code: string }[]).map((r) => r.code);
}

// ---- refresh from sidecar (graceful) ----

export async function refreshStock(userId: string, code: string): Promise<void> {
  const base = resolveSidecarBase(userId);
  if (!base) return;
  const [f, q] = await Promise.all([fetchFundamentals(base, code), fetchQuotes(base, code, 120)]);
  if (f) cacheFundamentals(code, today(), f.data, f.source ?? 'akshare');
  if (q && q.rows.length) cacheQuotes(q.rows, q.source ?? 'akshare');
}

export async function refreshMarket(userId: string): Promise<boolean> {
  const base = resolveSidecarBase(userId);
  if (!base) return false;
  const m = await fetchMarket(base);
  if (!m) return false;
  cacheMarket(today(), m.data, m.source ?? 'akshare');
  return true;
}

// ---- snapshot assembly ----

export async function getStockSnapshot(userId: string, code: string): Promise<StockSnapshot> {
  // If we have no quotes/fundamentals cached for this code, try a refresh (best-effort).
  const haveQuotes = recentCloses(code, 1).length > 0;
  const haveFund = !!latestFundamentals(code);
  if (!haveQuotes || !haveFund) {
    await refreshStock(userId, code).catch(() => {});
  }
  if (!latestMarket()) {
    await refreshMarket(userId).catch(() => {});
  }

  const f = latestFundamentals(code) || {};
  const c5 = recentCloses(code, 5);
  const c10 = recentCloses(code, 10);
  const c20 = recentCloses(code, 20);
  const c60 = recentCloses(code, 60);
  const c250 = recentCloses(code, 250);
  const market = latestMarket();

  const snap: StockSnapshot = {
    code,
    name: (f.name as string) ?? getCachedName(code),
    date: today(),
    roe_ttm: numOrNull(f.roe_ttm),
    pe: numOrNull(f.pe),
    pb: numOrNull(f.pb),
    ps: numOrNull(f.ps),
    net_profit: numOrNull(f.net_profit),
    turnover_rate: numOrNull(f.turnover_rate),
    ma5: c5.length >= 1 ? round2(mean(c5)) : null,
    ma10: c10.length >= 1 ? round2(mean(c10)) : null,
    ma20: c20.length >= 1 ? round2(mean(c20)) : null,
    ma60: c60.length >= 1 ? round2(mean(c60)) : null,
    year_high: c250.length ? Math.max(...c250) : null,
    close: c20[0] ?? null,
    limit_up_count: market?.limit_up_count ?? null,
    limit_down_count: market?.limit_down_count ?? null,
    sse_ma20_slope: market?.sse_ma20_slope ?? null,
    _missing: [],
  };

  for (const k of ['roe_ttm', 'pe', 'pb', 'ps', 'net_profit', 'turnover_rate', 'ma20', 'ma60', 'limit_up_count', 'limit_down_count', 'sse_ma20_slope'] as const) {
    if (snap[k] === null || snap[k] === undefined) snap._missing.push(k);
  }
  snap.sources = {
    quote: latestQuoteRow(code),
    fundamentals: latestFundRow(code),
    market: latestMarketRow(),
    sidecarBase: resolveSidecarBase(userId),
  };
  return snap;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof n === 'number' && isFinite(n) ? n : null;
}
function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}
