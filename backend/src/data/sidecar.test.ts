import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sidecar-'));

const { fetchFundamentals, fetchQuotes, fetchMarket, pingHealth } = require('./sidecar');

describe('data/sidecar client', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses fundamentals JSON', async () => {
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ roe_ttm: 12.3, pe: 20 }) }));
    const f = await fetchFundamentals('http://x', '600519');
    expect(f.roe_ttm).toBe(12.3);
  });

  it('maps quote rows and coerces numbers', async () => {
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => [{ date: '2026-06-01', open: '10', high: 11, low: 9, close: '10.5', volume: 1000 }] })
    );
    const q = await fetchQuotes('http://x', '600519', 5);
    expect(q).toHaveLength(1);
    expect(q[0].close).toBe(10.5);
    expect(q[0].code).toBe('600519');
  });

  it('returns null on non-2xx and on throw', async () => {
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: false }));
    expect(await fetchMarket('http://x')).toBeNull();
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('down')));
    expect(await fetchFundamentals('http://x', 'c')).toBeNull();
    expect(await pingHealth('http://x')).toBe(false);
  });
});
