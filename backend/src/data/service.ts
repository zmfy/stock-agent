import { getDb } from '../db';
import { QuoteRow, StockSnapshot, RealtimeQuoteView } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { resolveSidecarBase, fetchFundamentals, fetchQuotes, fetchMarket, fetchName, fetchNews, fetchAllStocks, orderedProviders, fetchRealtime, fetchIndexBars, fetchIndexRealtime } from './sidecar';
import { recordCollected } from './news-log';
import { lastTradingDayBefore, isTradingDay } from './trade-calendar';

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

// 仅「正在运行」时禁止再次启动。今日已成功也允许再次手动更新——首次全量、之后增量
// （股票库=拉一次名单+diff；行情=近10天×全量股票），负担可控，admin 可随时重取。
export function canStartJob(job: string): boolean {
  return getSyncStatus(job)?.state !== 'running';
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
  // 同步标记 running（在任何 await 之前），堵住快速二次触发的竞态——否则第二次 POST 在
  // fetchAllStocks 期间会看到非 running 而被放行、双跑。其余分支会以真实 total 重新 beginJob。
  beginJob('stock_universe', startedBy, 0);
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

export const MARKET_INDICES: Array<{ key: string; name: string }> = [
  { key: 'sh000001', name: '上证综指' },
  { key: 'sz399001', name: '深证成指' },
  { key: 'sz399006', name: '创业板指' },
  { key: 'sh000688', name: '科创50' },
  { key: 'bj899050', name: '北证50' },
];

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

// 把 sidecar live 返回的 data 规范化为 snapshot.realtime 视图(含五档)
export function toRealtimeView(d: Record<string, any> | null | undefined, source: string | null): RealtimeQuoteView | null {
  if (!d || d.price == null) return null;
  const v: RealtimeQuoteView = { price: Number(d.price), time: String(d.time ?? ''), source };
  for (const k of ['open', 'high', 'low', 'prev_close', 'volume']) if (d[k] != null) (v as any)[k] = Number(d[k]);
  for (let i = 1; i <= 5; i++) {
    for (const s of ['bid', 'ask']) {
      if (d[`${s}${i}`] != null) (v as any)[`${s}${i}`] = Number(d[`${s}${i}`]);
      if (d[`${s}${i}_vol`] != null) (v as any)[`${s}${i}_vol`] = Number(d[`${s}${i}_vol`]);
    }
  }
  return v;
}

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
  let idxCount = 0;
  for (const idx of MARKET_INDICES) {
    try {
      const rt = await fetchIndexRealtime(base, idx.key);
      if (rt && rt.data && (rt.data as any).price != null) {
        cacheRealtime(idx.key, rt.data as Record<string, any>, rt.source ?? 'tdx-idx');
        idxCount++;
      }
    } catch {
      /* 单个指数失败跳过 */
    }
  }
  console.log(`[realtime] 写入股票 ${count}/${codes.length}，指数 ${idxCount}/${MARKET_INDICES.length}`);
  return { skipped: false, count };
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

// 上证20日线斜率 = MA20(今) - MA20(昨)。bars 升序，需 ≥21 根收盘。取不到返回 null。
export function ma20Slope(bars: Bar[]): number | null {
  const closes = bars.map((b) => b.close).filter((c): c is number => c !== null && c !== undefined);
  if (closes.length < 21) return null;
  const maToday = mean(closes.slice(-20));
  const maPrev = mean(closes.slice(-21, -1));
  if (maToday === null || maPrev === null) return null;
  return Math.round((maToday - maPrev) * 10000) / 10000;
}

export async function refreshMarket(userId: string, order?: string[]): Promise<boolean> {
  const base = resolveSidecarBase(userId);
  if (!base) return false;
  const ord = order ?? (await safeOrder(base, 'sentiment'));
  const m = await fetchMarket(base, ord); // 涨停/跌停/斜率（仅东方财富源，常因网络取空 → null）
  // 斜率兜底：东方财富取不到时，用本地通达信指数自算上证20日线斜率（不依赖东方财富）。
  // 先确保本地上证指数刷新到最近交易日，再自算。
  let slope = m?.data.sse_ma20_slope ?? null;
  let source = m?.source ?? null;
  if (slope === null) {
    try {
      const bars = await ensureIndexBars(userId, '000001', 25, { freshThrough: lastTradingDayBefore(todayCN()) });
      const local = ma20Slope(bars);
      if (local !== null) {
        slope = local;
        source = source ?? 'tdx-local';
      }
    } catch {
      /* 安静降级 */
    }
  }
  const data = {
    limit_up_count: m?.data.limit_up_count ?? null,
    limit_down_count: m?.data.limit_down_count ?? null,
    sse_ma20_slope: slope,
  };
  // 三项全空才算彻底失败（不写库）；任一有值就写当天行（部分数据也比无强）。
  if (data.limit_up_count === null && data.limit_down_count === null && data.sse_ma20_slope === null) return false;
  cacheMarket(today(), data, source ?? 'mixed');
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
    const rtRow = getRealtime(code);
    const fresh = rtRow?.fetched_at && Date.now() - Date.parse(String(rtRow.fetched_at).replace(' ', 'T') + 'Z') < 120000;
    if (fresh) {
      snap.realtime = toRealtimeView(rtRow, rtRow.source ?? null);
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

// ---- 定时任务配置覆盖 + 运行状态 ----
export interface CronOverride { expr?: string; enabled?: boolean }
export type CronConfig = Record<string, CronOverride>;

export function getCronConfig(): CronConfig {
  const r = getDb().prepare("SELECT value FROM settings WHERE key='cron_config'").get() as { value: string } | undefined;
  if (!r?.value) return {};
  try { return JSON.parse(r.value) as CronConfig; } catch { return {}; }
}
export function setCronConfig(cfg: CronConfig): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('cron_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(cfg));
}

export interface CronStatusRow { key: string; last_run_at: string | null; last_status: string | null; last_duration_ms: number | null; last_error: string | null; run_count: number }

export function recordCronStart(key: string): void {
  getDb()
    .prepare(`INSERT INTO cron_status (key, last_run_at, last_status, run_count, updated_at)
              VALUES (?, CURRENT_TIMESTAMP, 'running', 0, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET last_run_at=CURRENT_TIMESTAMP, last_status='running', last_error=NULL, updated_at=CURRENT_TIMESTAMP`)
    .run(key);
}
export function recordCronFinish(key: string, status: 'ok' | 'error', durationMs: number, error: string | null): void {
  getDb()
    .prepare(`UPDATE cron_status SET last_status=?, last_duration_ms=?, last_error=?, run_count=run_count+1, updated_at=CURRENT_TIMESTAMP WHERE key=?`)
    .run(status, durationMs, error, key);
}
export function getCronStatus(key: string): CronStatusRow | null {
  return (getDb().prepare('SELECT key,last_run_at,last_status,last_duration_ms,last_error,run_count FROM cron_status WHERE key=?').get(key) as CronStatusRow) ?? null;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof n === 'number' && isFinite(n) ? n : null;
}
function round2(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

// 个股字典（code+name 全量），供前端聊天泡泡本地匹配个股做链接用。
export function getStockDict(): { version: string; items: [string, string][] } {
  const db = getDb();
  const rows = db
    .prepare("SELECT code, name FROM stock_names WHERE name IS NOT NULL AND name <> '' ORDER BY code")
    .all() as { code: string; name: string }[];
  const agg = db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS m FROM stock_names').get() as { n: number; m: string | null };
  return { version: `${agg.n}:${agg.m ?? ''}`, items: rows.map((r) => [r.code, r.name]) };
}
