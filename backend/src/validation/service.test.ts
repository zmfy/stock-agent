import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-validation-'));

const { validateStock } = require('./service');
const rb = require('../rulebook/service');
const USER = 'u-val';

beforeAll(() => {
  rb.instantiateBaseline(USER); // V3.0 veto fields: roe_ttm/pe/pb/ps/net_profit/ma20/ma60 + B emotion
});

const today = new Date().toISOString().slice(0, 10);

function snap(over: any = {}) {
  return {
    code: '600000', name: 'X', date: today,
    roe_ttm: 12, pe: 20, pb: 2, ps: 3, net_profit: 1e8, turnover_rate: 5,
    ma5: 11, ma10: 10.5, ma20: 10, ma60: 9, year_high: 12, close: 11,
    limit_up_count: 60, limit_down_count: 5, sse_ma20_slope: 0.1,
    _missing: [],
    sources: { quote: { source: 'csv', date: today, fetched_at: today }, fundamentals: { source: 'akshare', date: today, fetched_at: today }, market: { source: 'akshare', date: today, fetched_at: today }, sidecarBase: 'http://x' },
    ...over,
  };
}

describe('validateStock', () => {
  it('trusted when all veto fields present + sane', async () => {
    const v = await validateStock(USER, snap());
    expect(v.trusted).toBe(true);
    expect(v.authority).toBe('uploaded'); // quote source = csv
    expect(v.missing).toHaveLength(0);
  });

  it('untrusted + lists missing when a veto field is null', async () => {
    const v = await validateStock(USER, snap({ roe_ttm: null, pe: null }));
    expect(v.trusted).toBe(false);
    expect(v.missing).toEqual(expect.arrayContaining(['roe_ttm', 'pe']));
  });

  it('flags impossible values (negative price)', async () => {
    const v = await validateStock(USER, snap({ close: -1 }));
    expect(v.trusted).toBe(false);
    expect(v.checks.find((c: any) => c.name === '数值合理性').ok).toBe(false);
  });

  it('authority internal when source is not an upload', async () => {
    const v = await validateStock(USER, snap({ sources: { quote: { source: 'akshare', date: today, fetched_at: today }, fundamentals: null, market: null, sidecarBase: null } }));
    expect(v.authority).toBe('internal');
  });
});
