import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mctx-'));

const mc = require('./market-context');
const svc = require('../data/service');

describe('parseTimeWindow', () => {
  it('maps time phrases to trading-day counts, defaults 30', () => {
    expect(mc.parseTimeWindow('昨天收盘价多少')).toBe(5);
    expect(mc.parseTimeWindow('近半年走势如何')).toBe(120);
    expect(mc.parseTimeWindow('最近一年呢')).toBe(250);
    expect(mc.parseTimeWindow('这只票怎么样')).toBe(30);
    expect(mc.parseTimeWindow('近三月')).toBe(66);
    expect(mc.parseTimeWindow('近两年走势')).toBe(480);
  });
});

describe('detectTarget', () => {
  beforeAll(() => {
    svc.cacheName('600519', '贵州茅台');
    svc.cacheName('000001', '平安银行');
  });
  it('detects index by 大盘/上证, sz/cyb keywords', () => {
    expect(mc.detectTarget('大盘近期怎么样', null)).toEqual({ kind: 'index', code: '000001' });
    expect(mc.detectTarget('深成指走势', null)).toEqual({ kind: 'index', code: '399001' });
    expect(mc.detectTarget('创业板指如何', null)).toEqual({ kind: 'index', code: '399006' });
  });
  it('detects stock by 6-digit known code or exact name', () => {
    expect(mc.detectTarget('600519 昨天收盘', null)).toEqual({ kind: 'stock', code: '600519' });
    expect(mc.detectTarget('贵州茅台近半年走势', null)).toEqual({ kind: 'stock', code: '600519' });
  });
  it('falls back to session stock, else null', () => {
    expect(mc.detectTarget('它最近怎么样', '600519')).toEqual({ kind: 'stock', code: '600519' });
    expect(mc.detectTarget('讲个笑话', null)).toBeNull();
  });
});

describe('buildStockContext', () => {
  it('renders snapshot head + OHLC table + range note; empty when no data', () => {
    const snap = { code: '600519', name: '贵州茅台', close: 1600, ma20: 1550, ma60: 1500, pe: 30, pb: 9, roe_ttm: 28, year_high: 1800 };
    const bars = [
      { date: '2026-06-03', open: 1580, high: 1610, low: 1570, close: 1600, volume: 1000 },
      { date: '2026-06-04', open: 1600, high: 1620, low: 1590, close: 1610, volume: 1100 },
    ];
    const out = mc.buildStockContext('600519', snap, bars);
    expect(out).toContain('600519');
    expect(out).toContain('贵州茅台');
    expect(out).toContain('2026-06-04');
    expect(out).toContain('1610');
    expect(out).toContain('最近 2 个交易日');
    expect(mc.buildStockContext('X', null, [])).toBe('');
  });
});
