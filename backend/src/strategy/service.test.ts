import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-strat-'));

const { getDb } = require('../db');
const svc = require('./service');

const U = 'u1';
beforeEach(() => {
  getDb().exec('DELETE FROM daily_strategy; DELETE FROM daily_strategy_config;');
});

describe('schedule config', () => {
  it('无行时返回默认', () => {
    expect(svc.getScheduleConfig(U)).toEqual({ prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' });
  });
  it('set 合法值并 round-trip(部分字段)', () => {
    const out = svc.setScheduleConfig(U, { intradayInterval: 30, reviewTime: '15:45' });
    expect(out).toEqual({ prejudgeTime: '08:30', intradayInterval: 30, reviewTime: '15:45', holidayBriefTime: '09:00' });
    expect(svc.getScheduleConfig(U).intradayInterval).toBe(30);
  });
  it('间隔=0(无盘中)合法', () => {
    expect(svc.setScheduleConfig(U, { intradayInterval: 0 }).intradayInterval).toBe(0);
  });
  it('非法时间 / 非法间隔抛 INVALID_SCHEDULE', () => {
    expect(() => svc.setScheduleConfig(U, { prejudgeTime: '25:00' })).toThrow('INVALID_SCHEDULE');
    expect(() => svc.setScheduleConfig(U, { intradayInterval: 45 })).toThrow('INVALID_SCHEDULE');
  });
});

describe('dailyPhase', () => {
  const at = (hUTC: number) => Date.UTC(2026, 5, 10, hUTC, 0, 0);
  it('交易日按时段', () => {
    expect(svc.dailyPhase(at(0), true)).toBe('prejudge');
    expect(svc.dailyPhase(at(2), true)).toBe('intraday');
    expect(svc.dailyPhase(at(8), true)).toBe('review');
  });
  it('边界 9:00→intraday, 15:00→review', () => {
    expect(svc.dailyPhase(Date.UTC(2026, 5, 10, 1, 0, 0), true)).toBe('intraday');
    expect(svc.dailyPhase(Date.UTC(2026, 5, 10, 7, 0, 0), true)).toBe('review');
  });
  it('休市日恒为 holiday', () => {
    expect(svc.dailyPhase(at(2), false)).toBe('holiday');
  });
});

describe('daily_strategy 行读写', () => {
  const D = '2026-06-10';
  it('singleton(prejudge) upsert：重复写只 1 行、内容更新', () => {
    svc.recordStrategy(U, 'prejudge', '预判v1', { a: 1 }, D);
    svc.recordStrategy(U, 'prejudge', '预判v2', { a: 2 }, D);
    const all = getDb().prepare("SELECT * FROM daily_strategy WHERE user_id=? AND date=? AND phase='prejudge'").all(U, D);
    expect(all).toHaveLength(1);
    expect(svc.getStrategy(U, D, 'prejudge').content).toBe('预判v2');
  });
  it('intraday 累积成时间线(多行,asc)', () => {
    svc.recordStrategy(U, 'intraday', '盘中1', {}, D);
    svc.recordStrategy(U, 'intraday', '盘中2', {}, D);
    const tl = svc.getIntradayTimeline(U, D);
    expect(tl.map((r: any) => r.content)).toEqual(['盘中1', '盘中2']);
    expect(svc.getLatestIntraday(U, D).content).toBe('盘中2');
  });
  it('hasStrategy / getStrategy 未生成→false/null', () => {
    expect(svc.hasStrategy(U, D, 'review')).toBe(false);
    expect(svc.getStrategy(U, D, 'review')).toBeNull();
  });
});
