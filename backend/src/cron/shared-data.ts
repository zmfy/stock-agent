import { getDb } from '../db';
import { syncStockUniverse, ingestEod, getSyncStatus } from '../data/service';
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

