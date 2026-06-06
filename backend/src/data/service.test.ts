import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-datasvc-'));

const svc = require('./service');
const USER = 'u1';

function quotes(code: string, closes: number[]) {
  // most-recent first input -> assign descending dates
  return closes.map((close, i) => ({
    code,
    date: `2026-05-${String(28 - i).padStart(2, '0')}`,
    open: close, high: close, low: close, close, volume: 100,
  }));
}

describe('data/service', () => {
  afterEach(() => jest.restoreAllMocks());

  it('caches quotes and computes ma20 from cached closes', async () => {
    // 20 closes all = 10 -> ma20 = 10; plus one 12 today -> close = latest
    const rows = quotes('600000', [12, ...Array(19).fill(10)]);
    svc.cacheQuotes(rows, 'csv');
    svc.cacheFundamentals('600000', '2026-05-28', { roe_ttm: 15, pe: 20, pb: 2, ps: 3, net_profit: 1000, turnover_rate: 5, name: '测试股' }, 'csv');
    svc.cacheMarket('2026-05-28', { limit_up_count: 60, limit_down_count: 5, sse_ma20_slope: 0.1 }, 'csv');

    const snap = await svc.getStockSnapshot(USER, '600000');
    expect(snap.close).toBe(12);
    expect(snap.ma5).toBeCloseTo((12 + 4 * 10) / 5, 5);
    expect(snap.ma10).toBeCloseTo((12 + 9 * 10) / 10, 5);
    expect(snap.ma20).toBeCloseTo((12 + 19 * 10) / 20, 5);
    expect(snap.roe_ttm).toBe(15);
    expect(snap.name).toBe('测试股');
    expect(snap.limit_up_count).toBe(60);
    expect(snap._missing).toHaveLength(0);
  });

  it('a snapshot for an unknown code lists missing fields and does not throw', async () => {
    // no akshare-data plugin enabled for this user -> sidecar base null -> graceful
    const snap = await svc.getStockSnapshot(USER, '999999');
    expect(snap.code).toBe('999999');
    expect(snap._missing).toEqual(expect.arrayContaining(['roe_ttm', 'pe', 'ma20']));
  });

  it('listCachedCodes returns distinct cached codes', () => {
    expect(svc.listCachedCodes()).toContain('600000');
  });
});
