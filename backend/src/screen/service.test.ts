import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-screen-'));

const svc = require('./service');
const rb = require('../rulebook/service');
const data = require('../data/service');
const USER = 'u-screen';

function seedStock(code: string, fund: any) {
  data.cacheFundamentals(code, '2026-06-05', { name: code, ...fund }, 'test');
  // 60 rising closes so ma20>ma60 (trend gate passes)
  data.cacheQuotes(
    Array.from({ length: 60 }, (_, i) => ({ code, date: `2026-03-${String(60 - i).padStart(2, '0')}`, open: 10 + (60 - i) * 0.05, high: 0, low: 0, close: 10 + (60 - i) * 0.05, volume: 1 })),
    'test'
  );
}

beforeAll(() => {
  rb.instantiateBaseline(USER); // V3.0
  data.cacheMarket('2026-06-05', { limit_up_count: 60, limit_down_count: 5, sse_ma20_slope: 0.1 }, 'test');
  // GOOD: passes all A veto gates (roe>=10, 0<pe<60, pb<5, ps<8, net_profit>0, ma20>ma60)
  seedStock('600001', { roe_ttm: 18, pe: 25, pb: 2, ps: 3, net_profit: 1e8, turnover_rate: 5 });
  // BAD: roe fails
  seedStock('600002', { roe_ttm: 1.2, pe: 90, pb: 2, ps: 3, net_profit: 1e6, turnover_rate: 5 });
});

describe('screen service', () => {
  it('screenCode: good stock aPass=true, bad stock aPass=false', async () => {
    const good = await svc.screenCode(USER, '600001');
    const bad = await svc.screenCode(USER, '600002');
    expect(good.aPass).toBe(true);
    expect(bad.aPass).toBe(false);
    expect(bad.failed).toEqual(expect.arrayContaining(['roe_ttm', 'pe']));
  });

  it('screenCodes sorts qualifying first', async () => {
    const res = await svc.screenCodes(USER, ['600002', '600001']);
    expect(res[0].code).toBe('600001'); // aPass sorted first
  });

  it('resolveUniverse falls back to cached codes when no sidecar/codes', async () => {
    const u = await svc.resolveUniverse(USER, {});
    expect(u.codes).toEqual(expect.arrayContaining(['600001', '600002']));
    expect(u.note).toContain('回退');
  });

  it('runScreen persists and getLatest returns it', async () => {
    const r = await svc.runScreen(USER, { codes: ['600001', '600002'] });
    expect(r.results.length).toBe(2);
    const latest = svc.getLatest(USER);
    expect(latest.results.length).toBe(2);
    expect(latest.results[0].code).toBe('600001');
  });
});
