import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-tradecal-'));

const { getDb } = require('../db');
const cal = require('./trade-calendar');

describe('trade-calendar', () => {
  it('falls back to weekday=trading when the calendar table is empty', () => {
    // 空日历兜底：周末休市、工作日交易
    expect(cal.isTradingDay('2026-06-06')).toBe(false); // 周六
    expect(cal.isTradingDay('2026-06-07')).toBe(false); // 周日
    expect(cal.isTradingDay('2026-06-05')).toBe(true); // 周五
  });

  it('uses the calendar table once populated', () => {
    const ins = getDb().prepare('INSERT OR IGNORE INTO trade_calendar (date) VALUES (?)');
    // 注入：6/8 6/9 6/10 为交易日；6/5 故意不入（视为休市，验证以日历为准）
    ['2026-06-08', '2026-06-09', '2026-06-10'].forEach((d) => ins.run(d));

    expect(cal.isTradingDay('2026-06-08')).toBe(true);
    expect(cal.isTradingDay('2026-06-05')).toBe(false); // 不在日历 → 休市（即便是工作日）
    expect(cal.isTradingDay('2026-06-06')).toBe(false);
  });

  it('lastTradingDayBefore returns the nearest earlier trading day from the calendar', () => {
    expect(cal.lastTradingDayBefore('2026-06-10')).toBe('2026-06-09');
    expect(cal.lastTradingDayBefore('2026-06-09')).toBe('2026-06-08');
  });

  it('monthCalendar marks each day trading/closed', () => {
    const days = cal.monthCalendar(2026, 6);
    const byDate = Object.fromEntries(days.map((d: any) => [d.date, d.trading]));
    expect(byDate['2026-06-08']).toBe(true);
    expect(byDate['2026-06-05']).toBe(false);
    expect(days.length).toBe(30); // 6 月 30 天
  });
});
