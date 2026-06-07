import { getDb } from '../db';
import { resolveSidecarBase, fetchTradeDates } from './sidecar';

// 从 sidecar 拉全量 A 股交易日，覆盖写入 trade_calendar 表。返回写入条数（0=拉取失败/无源）。
export async function syncTradeCalendar(userId: string): Promise<number> {
  const base = resolveSidecarBase(userId);
  if (!base) return 0;
  const dates = await fetchTradeDates(base);
  if (!dates.length) return 0;
  const db = getDb();
  const ins = db.prepare('INSERT OR IGNORE INTO trade_calendar (date) VALUES (?)');
  const tx = db.transaction((ds: string[]) => ds.forEach((d) => ins.run(d)));
  tx(dates);
  return dates.length;
}

function hasCalendar(): boolean {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM trade_calendar').get() as { n: number }).n > 0;
}

// 周末判定。把 'YYYY-MM-DD' 当 UTC 零点取星期几，避免时区偏移到前一天。0=周日,6=周六。
function isWeekend(date: string): boolean {
  const wd = new Date(date + 'T00:00:00Z').getUTCDay();
  return wd === 0 || wd === 6;
}

// 是否交易日：有日历用日历；无日历兜底「非周末=交易」。
export function isTradingDay(date: string): boolean {
  if (hasCalendar()) {
    return !!getDb().prepare('SELECT 1 FROM trade_calendar WHERE date = ?').get(date);
  }
  return !isWeekend(date);
}

// 某月每天 {date, trading}（month: 1-12）。
export function monthCalendar(year: number, month: number): Array<{ date: string; trading: boolean }> {
  const out: Array<{ date: string; trading: boolean }> = [];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push({ date, trading: isTradingDay(date) });
  }
  return out;
}

// 严格早于 date 的最近交易日；无日历兜底往前找最近的非周末。
export function lastTradingDayBefore(date: string): string {
  const db = getDb();
  if (hasCalendar()) {
    const row = db
      .prepare('SELECT date FROM trade_calendar WHERE date < ? ORDER BY date DESC LIMIT 1')
      .get(date) as { date: string } | undefined;
    if (row) return row.date;
  }
  const d = new Date(date + 'T00:00:00Z');
  for (let i = 1; i <= 10; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const s = d.toISOString().slice(0, 10);
    if (!isWeekend(s)) return s;
  }
  return date;
}
