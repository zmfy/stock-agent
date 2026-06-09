import { getDb } from '../db';
import { QuoteRow, StockSnapshot } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { resolveSidecarBase, fetchFundamentals, fetchQuotes, fetchMarket, fetchName, fetchNews, fetchAllStocks, orderedProviders, fetchRealtime, fetchIndexBars } from './sidecar';
import { recordCollected } from './news-log';

// ---- hot news ----
export function listNews(limit = 30): Array<{ title: string; summary: string; published_at: string; fetched_at: string }> {
  return getDb()
    .prepare('SELECT title, summary, published_at, fetched_at FROM news ORDER BY fetched_at DESC, published_at DESC LIMIT ?')
    .all(limit) as any[];
}

export async function refreshNews(userId: string, limit = 20): Promise<number> {
  const base = resolveSidecarBase(userId);
  if (!base) return 0;
  const order = await safeOrder(base, 'news');
  const result = await fetchNews(base, limit, order);
  if (!result || !result.rows.length) return 0;
  const { source: fetchSource, rows } = result;
  const srcVal = fetchSource ?? 'akshare';
  recordCollected(rows.map((n: any) => ({ title: n.title, content: n.content, source: srcVal, published_at: n.published_at })));
  return rows.length;
}

// ---- background jobs: status helpers (keyed by job name) ----

function todayCN(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

export interface JobStatus {
  job: string; state: string; total: number; done: number; message: string; updated_at: string;
  started_at: string | null; finished_at: string | null; last_success_at: string | null;
  started_by: string | null; error: string | null; cancel_requested: number;
  source_breakdown: Record<string, number> | null;
}

function setProgress(job: string, total: number, done: number, message: string): void {
  getDb().prepare(`UPDATE sync_status SET total=?, done=?, message=?, updated_at=CURRENT_TIMESTAMP WHERE job=?`).run(total, done, message, job);
}

export function beginJob(job: string, startedBy: string, total: number): void {
  getDb().prepare(
    `INSERT INTO sync_status (job, state, total, done, message, started_at, finished_at, error, cancel_requested, updated_at)
     VALUES (?, 'running', ?, 0, '开始…', CURRENT_TIMESTAMP, NULL, NULL, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(job) DO UPDATE SET state='running', total=excluded.total, done=0, message='开始…',
       started_at=CURRENT_TIMESTAMP, finished_at=NULL, error=NULL, cancel_requested=0, updated_at=CURRENT_TIMESTAMP`
  ).run(job, total);
  getDb().prepare(`UPDATE sync_status SET started_by=? WHERE job=?`).run(startedBy, job);
  jobLog(job, 'info', `开始（${startedBy}），共 ${total}`);
}

export function finishJob(job: string, state: 'done' | 'error' | 'idle', message: string, breakdown?: Record<string, number> | null, error?: string): void {
  const successAt = state === 'done' ? 'CURRENT_TIMESTAMP' : 'last_success_at';
  const bdJson = breakdown ? JSON.stringify(breakdown) : null;
  const errVal = error ?? null;
  const db = getDb();
  // Upsert: create the row if it doesn't exist yet (e.g. direct error before beginJob)
  db.prepare(
    `INSERT INTO sync_status (job, state, message, finished_at, error, cancel_requested, source_breakdown, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 0, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(job) DO UPDATE SET state=excluded.state, message=excluded.message,
       finished_at=CURRENT_TIMESTAMP, last_success_at=${successAt},
       error=excluded.error, cancel_requested=0, source_breakdown=excluded.source_breakdown,
       updated_at=CURRENT_TIMESTAMP`
  ).run(job, state, message, errVal, bdJson);
  jobLog(job, state === 'error' ? 'error' : 'info', error ? `${message}：${error}` : message);
}

export function jobLog(job: string, level: string, message: string): void {
  const db = getDb();
  db.prepare('INSERT INTO sync_log (job, level, message) VALUES (?, ?, ?)').run(job, level, message);
  db.prepare(`DELETE FROM sync_log WHERE job=? AND id NOT IN (SELECT id FROM sync_log WHERE job=? ORDER BY id DESC LIMIT 200)`).run(job, job);
}

export function getJobLog(job: string, limit = 200): Array<{ ts: string; level: string; message: string }> {
  return getDb().prepare('SELECT ts, level, message FROM sync_log WHERE job=? ORDER BY id DESC LIMIT ?').all(job, limit) as any[];
}

export function requestCancel(job: string): void {
  getDb().prepare(`UPDATE sync_status SET cancel_requested=1, updated_at=CURRENT_TIMESTAMP WHERE job=? AND state='running'`).run(job);
  jobLog(job, 'warn', '收到取消请求');
}

// 管理员强制中止：无视是否有活线程，把状态打回 idle（清进度条+解锁重跑），
// 并置 cancel_requested=1，让万一还存活的循环下一轮检查时自行退出。
export function forceStopJob(job: string): void {
  getDb()
    .prepare(
      `UPDATE sync_status SET state='idle', message='已被管理员强制中止',
         cancel_requested=1, finished_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE job=?`
    )
    .run(job);
}

export function isCancelRequested(job: string): boolean {
  const r = getDb().prepare('SELECT cancel_requested FROM sync_status WHERE job=?').get(job) as any;
  return !!(r && r.cancel_requested);
}

export function getSyncStatus(job = 'stock_universe'): JobStatus | null {
  const row = getDb().prepare('SELECT * FROM sync_status WHERE job=?').get(job) as any;
  if (!row) return null;
  let source_breakdown: Record<string, number> | null = null;
  if (row.source_breakdown) { try { source_breakdown = JSON.parse(row.source_breakdown); } catch { /* ignore */ } }
  return { ...row, cancel_requested: row.cancel_requested ?? 0, source_breakdown };
}

export function canStartJob(job: string): boolean {
  const st = getSyncStatus(job);
  if (!st) return true;
  if (st.state === 'running') return false;
  if (st.last_success_at) {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(st.last_success_at.replace(' ', 'T') + 'Z'));
    if (d === todayCN()) return false;
  }
  return true;
}

// ---- EOD batch ingestion: pull daily quotes for the whole local universe into the cache ----
export async function ingestEod(userId: string, opts: { days?: number; codes?: string[]; startedBy?: string } = {}): Promise<void> {
  if (getSyncStatus('eod')?.state === 'running') return;
  const base = resolveSidecarBase(userId);
  if (!base) { beginJob('eod', opts.startedBy ?? 'system', 0); finishJob('eod', 'error', '没有可用的数据源', null, 'NO_SOURCE'); return; }
  const codes = opts.codes?.length ? opts.codes : (getDb().prepare('SELECT code FROM stock_names').all() as { code: string }[]).map((r) => r.code);
  if (!codes.length) { beginJob('eod', opts.startedBy ?? 'system', 0); finishJob('eod', 'error', '本地股票库为空，请先同步股票库', null, 'EMPTY_UNIVERSE'); return; }
  const days = opts.days ?? 10;
  beginJob('eod', opts.startedBy ?? 'system', codes.length);
  const order = await orderedProviders(base, 'quote');
  const bySource: Record<string, number> = {};
  let ok = 0, fail = 0;
  for (let i = 0; i < codes.length; i++) {
    if (isCancelRequested('eod')) { finishJob('eod', 'idle', `已取消：已处理 ${i}/${codes.length}（成功 ${ok}）`); return; }
    try {
      const res = await fetchQuotes(base, codes[i], days, order);
      if (res && res.rows.length) { const src = res.source ?? 'unknown'; cacheQuotes(res.rows, src); bySource[src] = (bySource[src] ?? 0) + 1; ok++; }
      else fail++;
    } catch { fail++; }
    if (i % 20 === 0 || i === codes.length - 1) setProgress('eod', codes.length, i + 1, `已处理 ${i + 1}/${codes.length}，成功 ${ok}、失败 ${fail}`);
    await new Promise((r) => setImmediate(r));
  }
  const denom = ok || 1; const breakdown: Record<string, number> = {};
  for (const k of Object.keys(bySource)) breakdown[k] = Math.round((bySource[k] / denom) * 100);
  finishJob('eod', 'done', `完成：成功 ${ok}、失败 ${fail}`, breakdown);
}

export function countStocks(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM stock_names').get() as { n: number }).n;
}

// Fire-and-forget incremental sync: add new, update changed, delete delisted. Never throws.
export async function syncStockUniverse(userId: string, startedBy = 'system'): Promise<void> {
  const cur = getSyncStatus();
  if (cur?.state === 'running') return; // already in progress
  try {
    const base = resolveSidecarBase(userId);
    if (!base) {
      beginJob('stock_universe', startedBy, 0);
      finishJob('stock_universe', 'error', '没有可用的数据源', null, 'NO_SOURCE');
      return;
    }
    const remote = await fetchAllStocks(base);
    if (!remote || remote.length < 1000) {
      beginJob('stock_universe', startedBy, remote?.length ?? 0);
      finishJob('stock_universe', 'error', '数据源返回异常（数量过少），已跳过以免误删', null, 'INSUFFICIENT_DATA');
      return;
    }
    const total = remote.length;
    beginJob('stock_universe', startedBy, total);
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
    setProgress('stock_universe', total, 0, '正在比对并写入本地…');

    // batch with yields so the event loop isn't blocked and progress is visible
    for (let i = 0; i < remote.length; i += 500) {
      if (isCancelRequested('stock_universe')) {
        finishJob('stock_universe', 'idle', `已取消：已处理 ${i}/${total}`);
        return;
      }
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
      setProgress('stock_universe', total, Math.min(i + 500, total), '正在比对并写入本地…');
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
    finishJob('stock_universe', 'done', `完成：新增 ${added}、更新 ${updated}、删除 ${deleted}，共 ${total} 只`);
  } catch (err) {
    finishJob('stock_universe', 'error', '同步失败', null, String(err));
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

export function findStockCodeInText(message: string): string | null {
  const row = getDb()
    .prepare("SELECT code FROM stock_names WHERE INSTR(?, name) > 0 ORDER BY LENGTH(name) DESC LIMIT 1")
    .get(message) as { code: string } | undefined;
  return row?.code ?? null;
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

// 本地行情深度不足 60 根 → 需要深取（保证 ma60/year_high 准）。
export function shouldDeepFetch(code: string): boolean {
  return recentCloses(code, 60).length < 60;
}

// 缓存的基本面缺估值字段(pe) → 视为不完整,需要重取。否则只有 net_profit/roe 的旧缓存会让
// 校验门槛因「缺 pe/pb/ps」硬拦截分析。
export function fundamentalsIncomplete(code: string): boolean {
  const f = latestFundamentals(code);
  return !f || f.pe === null || f.pe === undefined;
}

export function getMarketSentimentSeries(n: number): Array<{ date: string; limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null }> {
  const rows = getDb()
    .prepare('SELECT date, limit_up_count, limit_down_count, sse_ma20_slope FROM market_sentiment ORDER BY date DESC LIMIT ?')
    .all(n) as any[];
  return rows.reverse();
}

export interface Bar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export function getRecentBars(code: string, n: number): Bar[] {
  const rows = getDb()
    .prepare('SELECT date, open, high, low, close, volume FROM quote_daily WHERE code = ? ORDER BY date DESC LIMIT ?')
    .all(code, n) as Bar[];
  return rows.reverse(); // DESC 取最近 n 条后反转为升序
}

// 默认抓取器：走 sidecar 取 n 日线并缓存。
async function defaultBarFetcher(userId: string, code: string, n: number): Promise<Bar[]> {
  const base = resolveSidecarBase(userId);
  if (!base) return [];
  const res = await fetchQuotes(base, code, n);
  if (res && res.rows.length) cacheQuotes(res.rows, res.source ?? 'tdx');
  return res?.rows.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })) ?? [];
}

// 本地够(≥n)就用本地；不足则用 fetcher 抓取并缓存后再读本地。fetcher 可注入(测试)。
export async function ensureStockBars(
  userId: string,
  code: string,
  n: number,
  opts: { fetcher?: (code: string, n: number) => Promise<Bar[] | QuoteRow[]> } = {}
): Promise<Bar[]> {
  const local = getRecentBars(code, n);
  if (local.length >= n) return local;
  try {
    if (opts.fetcher) {
      const rows = await opts.fetcher(code, n);
      const qrows: QuoteRow[] = (rows as any[]).map((r) => ({ code, date: String(r.date), open: r.open ?? null, high: r.high ?? null, low: r.low ?? null, close: r.close ?? null, volume: r.volume ?? null }));
      if (qrows.length) cacheQuotes(qrows, 'test');
    } else {
      await defaultBarFetcher(userId, code, n);
    }
  } catch {
    /* 安静降级 */
  }
  return getRecentBars(code, n);
}

export function cacheIndexBars(rows: QuoteRow[], source: string): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO index_daily (code,date,open,high,low,close,volume,source) VALUES (@code,@date,@open,@high,@low,@close,@volume,@source)
     ON CONFLICT(code,date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,source=excluded.source`
  );
  const tx = db.transaction((items: QuoteRow[]) => { for (const r of items) stmt.run({ ...r, source }); });
  tx(rows);
  return rows.length;
}

export function getRecentIndexBars(code: string, n: number): Bar[] {
  const rows = getDb()
    .prepare('SELECT date, open, high, low, close, volume FROM index_daily WHERE code = ? ORDER BY date DESC LIMIT ?')
    .all(code, n) as Bar[];
  return rows.reverse();
}

async function defaultIndexFetcher(userId: string, code: string, n: number): Promise<Bar[]> {
  const base = resolveSidecarBase(userId);
  if (!base) return [];
  const res = await fetchIndexBars(base, code, n);
  if (res && res.rows.length) cacheIndexBars(res.rows, res.source ?? 'tdx');
  return res?.rows.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })) ?? [];
}

export async function ensureIndexBars(
  userId: string, code: string, n: number,
  opts: { fetcher?: (code: string, n: number) => Promise<QuoteRow[] | Bar[]>; freshThrough?: string } = {}
): Promise<Bar[]> {
  const local = getRecentIndexBars(code, n);
  // Have enough rows AND they're fresh enough (latest >= freshThrough) → use cache.
  // 关键修复：原来只看行数(local.length>=n)，导致即便本地是旧日期(如缺了最近交易日)也不再联网，
  // 大盘点位永远停在旧数据。现在还要求最新一根 >= 预期的最近交易日，否则触发取数。
  const fresh = !opts.freshThrough || (local.length > 0 && local[local.length - 1].date >= opts.freshThrough);
  if (local.length >= n && fresh) return local;
  try {
    if (opts.fetcher) {
      const rows = await opts.fetcher(code, n);
      const qrows: QuoteRow[] = (rows as any[]).map((r) => ({ code, date: String(r.date), open: r.open ?? null, high: r.high ?? null, low: r.low ?? null, close: r.close ?? null, volume: r.volume ?? null }));
      if (qrows.length) cacheIndexBars(qrows, 'test');
    } else {
      await defaultIndexFetcher(userId, code, n);
    }
  } catch { /* 安静降级 */ }
  return getRecentIndexBars(code, n);
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

/** Probe-ordered list with a tight timeout so a slow probe never blocks a refresh. */
async function safeOrder(base: string, kind: string, ms = 2000): Promise<string[]> {
  try {
    return await Promise.race([
      orderedProviders(base, kind),
      new Promise<string[]>((res) => setTimeout(() => res([]), ms)),
    ]);
  } catch {
    return [];
  }
}

export async function refreshStock(userId: string, code: string, order?: string[]): Promise<void> {
  const base = resolveSidecarBase(userId);
  if (!base) return;
  const ord = order ?? (await safeOrder(base, 'fundamentals'));
  const [f, q] = await Promise.all([fetchFundamentals(base, code, ord), fetchQuotes(base, code, 250)]);
  if (f) cacheFundamentals(code, today(), f.data, f.source ?? 'akshare');
  if (q && q.rows.length) cacheQuotes(q.rows, q.source ?? 'akshare');
}

export async function refreshMarket(userId: string, order?: string[]): Promise<boolean> {
  const base = resolveSidecarBase(userId);
  if (!base) return false;
  const ord = order ?? (await safeOrder(base, 'sentiment'));
  const m = await fetchMarket(base, ord);
  if (!m) return false;
  cacheMarket(today(), m.data, m.source ?? 'akshare');
  return true;
}

// ---- snapshot assembly ----

export async function getStockSnapshot(userId: string, code: string): Promise<StockSnapshot> {
  // If we have no quotes, shallow quotes, or INCOMPLETE fundamentals cached for this code, try a refresh.
  // 不只看「有没有」，还看「全不全」：旧缓存可能只有 net_profit/roe（缺 pe/pb/ps，会被校验门槛硬拦），
  // 此时也要重取，避免被不完整的旧缓存卡住。Pass explicit empty order to skip the probe round-trip.
  if (shouldDeepFetch(code) || fundamentalsIncomplete(code)) {
    await refreshStock(userId, code, []).catch(() => {});
  }
  if (!latestMarket()) {
    await refreshMarket(userId, []).catch(() => {});
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
  snap.realtime = null;
  try {
    const base = resolveSidecarBase(userId);
    if (base) {
      const rt = await fetchRealtime(base, code);
      const price = rt?.data?.price;
      if (rt && price != null) snap.realtime = { price: Number(price), time: String(rt.data.time ?? ''), source: rt.source };
    }
  } catch { /* ignore */ }
  return snap;
}

// 通达信选定服务器（持久化于 settings；"" = 自动 bestip）
export function getTdxServerSetting(): string {
  const r = getDb().prepare("SELECT value FROM settings WHERE key='tdx_server'").get() as { value: string } | undefined;
  return r?.value || '';
}
export function setTdxServerSetting(val: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('tdx_server', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(val);
}

// 出站代理配置（持久化于 settings 单行 JSON；仅 admin 可设/可见，口令明文存）
export interface ProxyConfig {
  enabled: boolean;
  scheme: 'http' | 'socks5';
  host: string;
  port: number;
  username: string;
  password: string;
}

const DEFAULT_PROXY: ProxyConfig = { enabled: false, scheme: 'http', host: '', port: 0, username: '', password: '' };

export function getProxyConfig(): ProxyConfig {
  const r = getDb().prepare("SELECT value FROM settings WHERE key='proxy_config'").get() as { value: string } | undefined;
  if (!r?.value) return { ...DEFAULT_PROXY };
  try {
    return { ...DEFAULT_PROXY, ...JSON.parse(r.value) };
  } catch {
    return { ...DEFAULT_PROXY };
  }
}

export function setProxyConfig(cfg: ProxyConfig): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('proxy_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(cfg));
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof n === 'number' && isFinite(n) ? n : null;
}
function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}
