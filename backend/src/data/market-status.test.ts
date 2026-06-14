import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mktstatus-'));

const { getDb } = require('../db');
const svc = require('./service');
const { getMarketStatus } = require('./market-status');

const WED_SESSION = Date.UTC(2026, 5, 10, 2, 0, 0);
const WED_PRE = Date.UTC(2026, 5, 10, 0, 0, 0);

beforeEach(() => {
  getDb().exec("DELETE FROM realtime_quote; DELETE FROM sync_status; DELETE FROM cron_status; DELETE FROM market_sentiment;");
});

describe('getMarketStatus', () => {
  it('盘中且当天有缓存 → basis=实时,带点数与涨跌幅', () => {
    svc.cacheRealtime('sh000001', { price: 4031.5, prev_close: 3987.0, time: '10:00' }, 'tdx-idx');
    getDb().prepare("UPDATE realtime_quote SET fetched_at = '2026-06-10 02:00:00' WHERE code = 'sh000001'").run();
    const st = getMarketStatus(WED_SESSION, 'ok');
    const sh = st.indices.find((x: any) => x.code === 'sh000001');
    expect(sh).toMatchObject({ name: '上证综指', point: 4031.5, basis: '实时' });
    expect(sh.changePct).toBeCloseTo(1.12, 1);
    expect(st.updatedAt).toBeTruthy();
  });
  it('非盘中(盘前) → basis=收盘(缓存里上次收盘点)', () => {
    svc.cacheRealtime('sh000001', { price: 4031.5, prev_close: 3987.0 }, 'tdx-idx');
    const sh = getMarketStatus(WED_PRE, 'ok').indices.find((x: any) => x.code === 'sh000001');
    expect(sh.basis).toBe('收盘');
    expect(sh.point).toBe(4031.5);
  });
  it('无缓存指数 → point=null', () => {
    const bj = getMarketStatus(WED_SESSION, 'ok').indices.find((x: any) => x.code === 'bj899050');
    expect(bj.point).toBeNull();
  });
  it('alerts 汇总：sidecar down → alertLevel=error', () => {
    const st = getMarketStatus(WED_SESSION, 'down');
    expect(st.alertLevel).toBe('error');
    expect(st.alerts.some((a: any) => a.source === 'sidecar')).toBe(true);
  });
  it('数据正常 → alertLevel=null', () => {
    getDb().prepare("INSERT INTO market_sentiment (date, source) VALUES ('2026-06-10','t')").run();
    const st = getMarketStatus(WED_SESSION, 'ok');
    expect(st.alertLevel).toBeNull();
  });
});

describe('getMarketStatus 回退到 index_daily', () => {
  it('realtime 缓存为空时，取 index_daily 最后一日收盘(收盘 basis)', () => {
    // index_daily 用无前缀代码 000001；状态条 key 为 sh000001
    svc.cacheIndexBars([
      { code: '000001', date: '2026-06-11', open: 3979, high: 3990, low: 3970, close: 3987, volume: 1 },
      { code: '000001', date: '2026-06-12', open: 4017, high: 4040, low: 4010, close: 4031.51, volume: 1 },
    ], 'test');
    const st = getMarketStatus(WED_PRE, 'ok'); // 无 realtime 缓存
    const sh = st.indices.find((x: any) => x.code === 'sh000001');
    expect(sh).toMatchObject({ point: 4031.51, prevClose: 3987, basis: '收盘' });
    expect(sh.changePct).toBeCloseTo(1.12, 1);
    expect(st.updatedAt).toContain('2026-06-12');
  });
});
