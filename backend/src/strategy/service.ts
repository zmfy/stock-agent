import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';

export type StrategyPhase = 'prejudge' | 'intraday' | 'review' | 'holiday';
const SINGLETON: StrategyPhase[] = ['prejudge', 'review', 'holiday'];

export interface ScheduleConfig {
  prejudgeTime: string;
  intradayInterval: number;
  reviewTime: string;
  holidayBriefTime: string;
}
const DEFAULT_SCHEDULE: ScheduleConfig = { prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const INTERVALS = [0, 30, 60, 120];

export function getScheduleConfig(userId: string): ScheduleConfig {
  const r = getDb().prepare('SELECT * FROM daily_strategy_config WHERE user_id = ?').get(userId) as any;
  if (!r) return { ...DEFAULT_SCHEDULE };
  return { prejudgeTime: r.prejudge_time, intradayInterval: r.intraday_interval, reviewTime: r.review_time, holidayBriefTime: r.holiday_brief_time };
}

export function setScheduleConfig(userId: string, input: Partial<ScheduleConfig>): ScheduleConfig {
  const merged: ScheduleConfig = { ...getScheduleConfig(userId), ...input };
  if (!HHMM.test(merged.prejudgeTime) || !HHMM.test(merged.reviewTime) || !HHMM.test(merged.holidayBriefTime)) throw new Error('INVALID_SCHEDULE');
  if (!INTERVALS.includes(merged.intradayInterval)) throw new Error('INVALID_SCHEDULE');
  getDb()
    .prepare(
      `INSERT INTO daily_strategy_config (user_id, prejudge_time, intraday_interval, review_time, holiday_brief_time)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET prejudge_time=excluded.prejudge_time, intraday_interval=excluded.intraday_interval,
         review_time=excluded.review_time, holiday_brief_time=excluded.holiday_brief_time`,
    )
    .run(userId, merged.prejudgeTime, merged.intradayInterval, merged.reviewTime, merged.holidayBriefTime);
  return merged;
}

export function beijingDate(nowMs: number = Date.now()): string {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function dailyPhase(nowMs: number, isTradingToday: boolean): StrategyPhase {
  if (!isTradingToday) return 'holiday';
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  if (mins < 9 * 60) return 'prejudge';
  if (mins < 15 * 60) return 'intraday';
  return 'review';
}

export function recordStrategy(userId: string, phase: StrategyPhase, content: string, data: unknown, date: string = beijingDate()): void {
  const db = getDb();
  const dataJson = JSON.stringify(data ?? {});
  if (SINGLETON.includes(phase)) {
    const existing = db.prepare('SELECT id FROM daily_strategy WHERE user_id=? AND date=? AND phase=?').get(userId, date, phase) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE daily_strategy SET content=?, data=?, created_at=CURRENT_TIMESTAMP WHERE id=?').run(content, dataJson, existing.id);
      return;
    }
  }
  db.prepare('INSERT INTO daily_strategy (id, user_id, date, phase, content, data) VALUES (?, ?, ?, ?, ?, ?)').run(uuidv4(), userId, date, phase, content, dataJson);
}

export function getStrategy(userId: string, date: string, phase: StrategyPhase): any | null {
  return (getDb().prepare('SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase=? ORDER BY created_at DESC LIMIT 1').get(userId, date, phase) as any) ?? null;
}
export function getIntradayTimeline(userId: string, date: string): any[] {
  return getDb().prepare("SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase='intraday' ORDER BY created_at, rowid").all(userId, date) as any[];
}
export function getLatestIntraday(userId: string, date: string): any | null {
  return (getDb().prepare("SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase='intraday' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(userId, date) as any) ?? null;
}
export function hasStrategy(userId: string, date: string, phase: StrategyPhase): boolean {
  return !!getDb().prepare('SELECT 1 FROM daily_strategy WHERE user_id=? AND date=? AND phase=? LIMIT 1').get(userId, date, phase);
}
