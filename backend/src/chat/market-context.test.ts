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
