import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-strat-disp-'));

const { getDb } = require('../db');
const svc = require('./service');
const disp = require('./dispatcher');

const U = 'u1';
const DEF = { prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' };
const WED = (hUTC: number, m = 0) => Date.UTC(2026, 5, 10, hUTC, m, 0); // 2026-06-10 周三(交易日)
const SUN = (hUTC: number) => Date.UTC(2026, 5, 7, hUTC, 0, 0);         // 2026-06-07 周日(休市)

beforeEach(() => {
  getDb().exec('DELETE FROM daily_strategy; DELETE FROM daily_strategy_config;');
});

describe('dueJobs(纯函数)', () => {
  const empty = { hasPrejudge: false, hasReview: false, hasHoliday: false, lastIntradayMs: null };
  it('休市日：到快报时间且未生成→[holiday]；已生成→[]', () => {
    expect(disp.dueJobs(DEF, SUN(2), false, false, empty)).toEqual(['holiday']);
    expect(disp.dueJobs(DEF, SUN(2), false, false, { ...empty, hasHoliday: true })).toEqual([]);
    expect(disp.dueJobs(DEF, SUN(0), false, false, empty)).toEqual([]);
  });
  it('交易日预判：到预判时间且未生成才 due', () => {
    expect(disp.dueJobs(DEF, WED(1), true, false, empty)).toContain('prejudge');
    expect(disp.dueJobs(DEF, WED(0), true, false, empty)).not.toContain('prejudge');
    expect(disp.dueJobs(DEF, WED(1), true, false, { ...empty, hasPrejudge: true })).not.toContain('prejudge');
  });
  it('交易日盘中：在盘中时段按间隔，间隔=无不生成', () => {
    const t = WED(2);
    expect(disp.dueJobs(DEF, t, true, true, empty)).toContain('intraday');
    expect(disp.dueJobs(DEF, t, true, true, { ...empty, lastIntradayMs: t - 30 * 60000 })).not.toContain('intraday');
    expect(disp.dueJobs(DEF, t, true, true, { ...empty, lastIntradayMs: t - 90 * 60000 })).toContain('intraday');
    expect(disp.dueJobs(DEF, t, true, true, { ...empty, lastIntradayMs: t - 60 * 60000 })).toContain('intraday');
    expect(disp.dueJobs(DEF, t, true, false, empty)).not.toContain('intraday');
    expect(disp.dueJobs({ ...DEF, intradayInterval: 0 }, t, true, true, empty)).not.toContain('intraday');
  });
  it('交易日复盘：到复盘时间且未生成才 due', () => {
    expect(disp.dueJobs(DEF, WED(8), true, false, empty)).toContain('review');
    expect(disp.dueJobs(DEF, WED(2), true, false, empty)).not.toContain('review');
  });
});

describe('runStrategyTick(注入生成器，不触 AI)', () => {
  function stubGens() {
    const calls: string[] = [];
    const mk = (name: string) => async (_uid: string) => { calls.push(name); };
    return { calls, generators: { prejudge: mk('prejudge'), intraday: mk('intraday'), review: mk('review'), holiday: mk('holiday') } };
  }
  it('交易日盘中：无历史→prejudge+intraday，不含 review', async () => {
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: WED(2), eligibleUserIds: () => [U], generators });
    expect(calls.sort()).toEqual(['intraday', 'prejudge']);
  });
  it('已生成预判则不重复', async () => {
    svc.recordStrategy(U, 'prejudge', 'x', {}, svc.beijingDate(WED(2)));
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: WED(2), eligibleUserIds: () => [U], generators });
    expect(calls).not.toContain('prejudge');
    expect(calls).toContain('intraday');
  });
  it('休市日只 holiday', async () => {
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: SUN(2), eligibleUserIds: () => [U], generators });
    expect(calls).toEqual(['holiday']);
  });
  it('无合格用户→无操作', async () => {
    const { calls, generators } = stubGens();
    await disp.runStrategyTick({ now: WED(2), eligibleUserIds: () => [], generators });
    expect(calls).toEqual([]);
  });
  it('某用户生成抛错不影响其它用户', async () => {
    const calls: string[] = [];
    const generators = {
      prejudge: async (uid: string) => { if (uid === 'bad') throw new Error('boom'); calls.push('prejudge:' + uid); },
      intraday: async (uid: string) => { calls.push('intraday:' + uid); },
      review: async (_uid: string) => {},
      holiday: async (_uid: string) => {},
    };
    await disp.runStrategyTick({ now: WED(2), eligibleUserIds: () => ['bad', U], generators });
    // bad 的 prejudge 抛错被吞，但 bad 的 intraday 仍跑、u1 全跑
    expect(calls).toContain('intraday:bad');
    expect(calls).toContain('prejudge:u1');
    expect(calls).toContain('intraday:u1');
  });
});
