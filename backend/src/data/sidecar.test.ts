import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sidecar-'));

const { fetchFundamentals, fetchQuotes, fetchMarket, pingHealth, probe } = require('./sidecar');

describe('data/sidecar client', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses fundamentals JSON', async () => {
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ roe_ttm: 12.3, pe: 20 }) }));
    const f = await fetchFundamentals('http://x', '600519');
    expect(f.data.roe_ttm).toBe(12.3);
  });

  it('maps quote rows and coerces numbers', async () => {
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ source: 'em', rows: [{ date: '2026-06-01', open: '10', high: 11, low: 9, close: '10.5', volume: 1000 }] }) })
    );
    const q = await fetchQuotes('http://x', '600519', 5);
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].close).toBe(10.5);
    expect(q.rows[0].code).toBe('600519');
  });

  it('returns null on non-2xx and on throw', async () => {
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: false }));
    expect(await fetchMarket('http://x')).toBeNull();
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('down')));
    expect(await fetchFundamentals('http://x', 'c')).toBeNull();
    expect(await pingHealth('http://x')).toBe(false);
  });

  it('probe 返回各 provider 状态数组', async () => {
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => [
        { key: 'tx', label: '腾讯', reachable: true, latency_ms: 120, error: null },
        { key: 'em', label: '东方财富', reachable: false, latency_ms: null, error: 'reset' },
      ] })
    );
    const r = await probe('http://x', 'quote');
    expect(r.map((p: any) => p.key)).toEqual(['tx', 'em']);
    expect(r[0].reachable).toBe(true);
    expect(r[0].latencyMs).toBe(120);
  });

  it('fetchQuotes 解析 {source, rows} 并带 source', async () => {
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ source: 'tx', rows: [{ date: '2026-06-01', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 }] }) })
    );
    const q = await fetchQuotes('http://x', '600519', 5, ['tx', 'sina']);
    expect(q.source).toBe('tx');
    expect(q.rows[0].close).toBe(10.5);
    expect(q.rows[0].code).toBe('600519');
  });

  it('fetchMarket/fetchNews/fetchFundamentals 解析 {source, data/rows}', async () => {
    const sc = require('./sidecar');
    (global as any).fetch = jest.fn((u: string) => Promise.resolve({ ok: true, json: async () =>
      u.includes('/news') ? { source: 'em', rows: [{ title: 'x', summary: '', published_at: '' }] }
      : u.includes('/market') ? { source: 'em', data: { limit_up_count: 5, limit_down_count: 1, sse_ma20_slope: 0.1 } }
      : { source: 'baostock', data: { roe_ttm: 12 } } }));
    expect((await sc.fetchMarket('http://x')).source).toBe('em');
    expect((await sc.fetchNews('http://x', 3)).source).toBe('em');
    expect((await sc.fetchFundamentals('http://x', '600519')).source).toBe('baostock');
  });

  it('probeList 返回 provider 列表；probeOne 返回单条', async () => {
    const sc = require('./sidecar');
    (global as any).fetch = jest.fn((u: string) =>
      u.includes('/probe/list')
        ? Promise.resolve({ ok: true, json: async () => [{ key: 'sina', label: '新浪' }, { key: 'tx', label: '腾讯' }] })
        : Promise.resolve({ ok: true, json: async () => [{ key: 'sina', label: '新浪', reachable: true, latency_ms: 100, error: null }] }));
    expect((await sc.probeList('http://x', 'quote')).map((p: any) => p.key)).toEqual(['sina', 'tx']);
    const one = await sc.probeOne('http://x', 'quote', 'sina');
    expect(one.key).toBe('sina'); expect(one.latencyMs).toBe(100);
  });
});
