import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cron-'));
const reg = require('./registry');

describe('timeToExpr / exprToTime', () => {
  it('converts HH:MM <-> daily cron', () => {
    expect(reg.timeToExpr('23:05')).toBe('5 23 * * *');
    expect(reg.timeToExpr('08:00')).toBe('0 8 * * *');
    expect(reg.exprToTime('5 23 * * *')).toBe('23:05');
    expect(reg.exprToTime('0 8 * * *')).toBe('08:00');
    expect(reg.exprToTime('*/5 * * * *')).toBeNull();
  });
  it('rejects bad time', () => {
    expect(() => reg.timeToExpr('25:00')).toThrow('BAD_TIME');
    expect(() => reg.timeToExpr('8:5')).toThrow('BAD_TIME');
    expect(() => reg.timeToExpr('abc')).toThrow('BAD_TIME');
  });
});

describe('nextRunAt (Asia/Shanghai daily)', () => {
  it('today if target still ahead, else tomorrow', () => {
    const now = Date.UTC(2026, 5, 10, 2, 0, 0); // 2026-06-10 10:00 Beijing
    expect(reg.nextRunAt('0 23 * * *', now)).toBe('2026-06-10T15:00:00.000Z'); // 23:00 北京 = 15:00Z 当天
    expect(reg.nextRunAt('0 8 * * *', now)).toBe('2026-06-11T00:00:00.000Z'); // 08:00 已过 → 次日 00:00Z
    expect(reg.nextRunAt('*/5 * * * *', now)).toBeNull();
  });
});

describe('tracked wrapper', () => {
  it('records ok with duration', async () => {
    await reg.tracked('nightly', async () => { /* ok */ });
    const s = require('../data/service').getCronStatus('nightly');
    expect(s.last_status).toBe('ok');
    expect(s.run_count).toBeGreaterThanOrEqual(1);
  });
  it('swallows error and records it (does not throw)', async () => {
    await expect(reg.tracked('eod', async () => { throw new Error('kaboom'); })).resolves.toBeUndefined();
    const s = require('../data/service').getCronStatus('eod');
    expect(s.last_status).toBe('error');
    expect(s.last_error).toContain('kaboom');
  });
});

describe('listCronJobs + applyCronChange', () => {
  it('lists 5 jobs with defaults and cronEnabled flag', () => {
    const { cronEnabled, jobs } = reg.listCronJobs();
    expect(typeof cronEnabled).toBe('boolean');
    expect(jobs.length).toBe(5);
    expect(jobs.find((j: any) => j.key === 'strategy_tick')).toBeTruthy();
    expect(jobs.find((j: any) => j.key === 'meeting_morning')).toBeFalsy();
    expect(jobs.find((j: any) => j.key === 'nightly').time).toBe('23:00');
  });
  it('applyCronChange persists time + enabled and reflects in list', () => {
    reg.applyCronChange('nightly', { time: '23:30', enabled: false });
    const n = reg.listCronJobs().jobs.find((j: any) => j.key === 'nightly');
    expect(n.time).toBe('23:30');
    expect(n.enabled).toBe(false);
    expect(n.nextRunAt).toBeNull(); // disabled
  });
  it('rejects bad time / unknown job', () => {
    expect(() => reg.applyCronChange('nightly', { time: '99:99' })).toThrow('BAD_TIME');
    expect(() => reg.applyCronChange('nope', { enabled: true })).toThrow('UNKNOWN_JOB');
  });
});
