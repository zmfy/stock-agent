import { getDb } from '../db';
import { syncStockUniverse, ingestEod, getSyncStatus, ingestRealtime, refreshNews, refreshMarket, syncAllIndexBars } from '../data/service';
import { ensureSeedGlobal } from '../data/sources-service';

// 决定 EOD 本次拉取天数：无历史→365；有历史→从最新日期到今天的窗口(至少 2，封顶 365)
export function eodDaysForRun(): number {
  const row = getDb().prepare('SELECT MAX(date) AS d FROM quote_daily').get() as { d: string | null };
  if (!row || !row.d) return 365;
  const last = new Date(String(row.d).slice(0, 10) + 'T00:00:00Z').getTime();
  if (!isFinite(last)) return 365;
  const days = Math.ceil((Date.now() - last) / 86400000) + 1;
  return Math.min(365, Math.max(2, days));
}

export async function runStockUniverse(): Promise<void> {
  ensureSeedGlobal();
  if (getSyncStatus('stock_universe')?.state === 'running') return;
  await syncStockUniverse('', 'cron');
}

export async function runEod(): Promise<void> {
  ensureSeedGlobal();
  if (getSyncStatus('eod')?.state === 'running') return;
  await ingestEod('', { days: eodDaysForRun(), startedBy: 'cron' });
}

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

// 新闻 + 大盘情绪 + 全部指数日线：全局抓取并入库共享给所有用户（用 admin 的数据源）。
export async function runNewsSentiment(): Promise<void> {
  const userId = pickRealtimeUserId();
  if (!userId) return;
  try { await refreshNews(userId); } catch { /* ignore */ }
  try { await refreshMarket(userId); } catch { /* ignore */ }
  try { await syncAllIndexBars(userId); } catch { /* ignore */ }
}

