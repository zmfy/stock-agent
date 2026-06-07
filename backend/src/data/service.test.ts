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

  it('searchStocks matches a heteronym pinyin candidate (长亮科技: clkj as well as zlkj)', () => {
    const { getDb } = require('../db');
    getDb()
      .prepare("INSERT OR REPLACE INTO stock_names (code, name, py, source, fetched_at) VALUES ('300348','长亮科技','zlkj zlkq clkj clkq','test',CURRENT_TIMESTAMP)")
      .run();
    // the default reading puts it under z…, but a user typing the cháng reading must still find it
    expect(svc.searchStocks('clkj').map((r: any) => r.code)).toContain('300348');
    expect(svc.searchStocks('cl').map((r: any) => r.code)).toContain('300348'); // prefix of a later candidate
    expect(svc.searchStocks('zlkj').map((r: any) => r.code)).toContain('300348'); // first candidate still works
    expect(svc.searchStocks('300348').map((r: any) => r.code)).toContain('300348'); // by code
  });

  it('ingestEod 探测择优、按真实来源缓存并写占比', async () => {
    const svc = require('./service');
    const db = require('../db').getDb();
    db.prepare("INSERT OR IGNORE INTO stock_names (code, name) VALUES ('600519','贵州茅台'),('000001','平安银行')").run();
    require('./sources-service').ensureSeed?.('u1');
    (global as any).fetch = jest.fn((url: string) => {
      if (url.includes('/probe')) return Promise.resolve({ ok: true, json: async () => [{ key: 'tx', label: '腾讯', reachable: true, latency_ms: 100, error: null }] });
      return Promise.resolve({ ok: true, json: async () => ({ source: 'tx', rows: [{ date: '2026-06-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }) });
    });
    await svc.ingestEod('u1', { days: 5 });
    const st = svc.getSyncStatus('eod');
    expect(st.state).toBe('done');
    const row = db.prepare("SELECT source FROM quote_daily WHERE code='600519' LIMIT 1").get();
    expect(row.source).toBe('tx');
    expect(JSON.stringify(st.source_breakdown)).toContain('tx');
  });
});
