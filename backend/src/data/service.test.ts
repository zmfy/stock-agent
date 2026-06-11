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

  it('富状态：beginJob/finishJob/canStartJob/cancel/log', () => {
    const svc = require('./service');
    svc.beginJob('eod', 'alice', 100);
    let st = svc.getSyncStatus('eod');
    expect(st.state).toBe('running'); expect(st.started_by).toBe('alice');
    expect(svc.canStartJob('eod')).toBe(false);
    svc.requestCancel('eod'); expect(svc.isCancelRequested('eod')).toBe(true);
    svc.jobLog('eod', 'info', '处理中…');
    expect(svc.getJobLog('eod').some((l: any) => l.message === '处理中…')).toBe(true);
    svc.finishJob('eod', 'done', '完成', { tx: 90, sina: 10 });
    st = svc.getSyncStatus('eod');
    expect(st.state).toBe('done'); expect(st.last_success_at).toBeTruthy();
    expect(st.source_breakdown).toEqual({ tx: 90, sina: 10 });
    expect(st.cancel_requested).toBe(0);
    // 今日已成功后仍可再次手动更新（增量取数，负担小）；只有「正在运行」才禁止。
    expect(svc.canStartJob('eod')).toBe(true);
  });

  it('canStartJob: error 状态可重试', () => {
    const svc = require('./service');
    svc.finishJob('stock_universe', 'error', '出错', null, '网络错误');
    expect(svc.getSyncStatus('stock_universe').error).toBe('网络错误');
    expect(svc.canStartJob('stock_universe')).toBe(true);
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

  it('getStockSnapshot 带 realtime 现价(best-effort)', async () => {
    const svc = require('./service');
    require('./sources-service').ensureSeedGlobal?.();
    (global as any).fetch = jest.fn((u: string) =>
      u.includes('/realtime') ? Promise.resolve({ ok: true, json: async () => ({ source: 'sina-rt', data: { price: 10.5, time: 't' } }) })
      : Promise.resolve({ ok: true, json: async () => ({ source: null, rows: [], data: {} }) }));
    const snap = await svc.getStockSnapshot('u1', '600519');
    expect(snap).toHaveProperty('realtime');
    expect(snap.realtime?.price).toBe(10.5);
  });

  it('refreshNews 写入 news 双日志', async () => {
    const svc = require('./service');
    require('./sources-service').ensureSeedGlobal?.();
    (global as any).fetch = jest.fn((u: string) =>
      u.includes('/news') ? Promise.resolve({ ok: true, json: async () => ({ source: 'em', rows: [{ title: '热点X', summary: 's', content: '正文X', published_at: '2026-06-07' }] }) })
      : Promise.resolve({ ok: true, json: async () => ([]) }));
    await svc.refreshNews('u1', 5);
    const db = require('../db').getDb();
    expect((db.prepare("SELECT content FROM news_content_log WHERE title='热点X'").get() as any).content).toBe('正文X');
  });

  it('ingestEod 用 beginJob/finishJob 并在 cancel 时中止', async () => {
    const svc = require('./service');
    const db = require('../db').getDb();
    db.prepare("INSERT OR IGNORE INTO stock_names (code,name) VALUES ('600519','x'),('000001','y'),('000002','z')").run();
    require('./sources-service').ensureSeed?.('u1');
    (global as any).fetch = jest.fn((url: string) => {
      if (url.includes('/probe')) return Promise.resolve({ ok: true, json: async () => [{ key: 'tx', label: '腾讯', reachable: true, latency_ms: 1, error: null }] });
      svc.requestCancel('eod');
      return Promise.resolve({ ok: true, json: async () => ({ source: 'tx', rows: [{ date: '2026-06-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }] }) });
    });
    await svc.ingestEod('u1', { days: 5, startedBy: 'alice' });
    const st = svc.getSyncStatus('eod');
    expect(st.state).toBe('idle'); expect(st.message).toContain('取消'); expect(st.done).toBeLessThan(3);
  });

  describe('getRecentBars', () => {
    it('returns recent bars ascending, capped at n, empty for unknown', () => {
      const db = require('../db').getDb();
      const code = 'BARS01';
      for (const d of ['2026-06-01','2026-06-02','2026-06-03','2026-06-04']) {
        db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)')
          .run(code, d, 1, 2, 0.5, Number(d.slice(-2)), 100, 'test');
      }
      const bars = svc.getRecentBars(code, 3);
      expect(bars.map((b: any) => b.date)).toEqual(['2026-06-02','2026-06-03','2026-06-04']);
      expect(bars[2].close).toBe(4);
      expect(svc.getRecentBars('NOPE', 5)).toEqual([]);
    });
  });

  describe('ensureStockBars', () => {
    it('uses local when enough; otherwise fetches via injected fetcher and caches', async () => {
      const code = 'ENS01';
      const db = require('../db').getDb();
      db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)').run(code, '2026-05-30', 1,1,1,9,1,'test');
      let fetched = 0;
      const fetcher = async (_code: string, n: number) => {
        fetched++;
        return [
          { code, date: '2026-06-01', open: 1, high: 1, low: 1, close: 10, volume: 1 },
          { code, date: '2026-06-02', open: 1, high: 1, low: 1, close: 11, volume: 1 },
          { code, date: '2026-06-03', open: 1, high: 1, low: 1, close: 12, volume: 1 },
          { code, date: '2026-06-04', open: 1, high: 1, low: 1, close: 13, volume: 1 },
          { code, date: '2026-06-05', open: 1, high: 1, low: 1, close: 14, volume: 1 },
        ].slice(0, n);
      };
      const bars = await svc.ensureStockBars('u1', code, 5, { fetcher });
      expect(fetched).toBe(1);
      expect(bars.length).toBeGreaterThanOrEqual(5);
      const bars2 = await svc.ensureStockBars('u1', code, 5, { fetcher });
      expect(fetched).toBe(1); // local now sufficient → no second fetch
      expect(bars2.length).toBeGreaterThanOrEqual(5);
    });
  });
});

describe('index bars store + ensure', () => {
  it('cache + getRecent ascending; ensure fetches when local insufficient', async () => {
    svc.cacheIndexBars([
      { code: '000001', date: '2026-06-02', open: 3000, high: 3010, low: 2990, close: 3005, volume: 1 },
      { code: '000001', date: '2026-06-03', open: 3005, high: 3030, low: 3000, close: 3025, volume: 1 },
    ], 'test');
    const bars = svc.getRecentIndexBars('000001', 5);
    expect(bars.map((b: any) => b.date)).toEqual(['2026-06-02', '2026-06-03']);
    let fetched = 0;
    const fetcher = async (_c: string, n: number) => { fetched++; return [
      { code: '000001', date: '2026-06-04', open: 3025, high: 3050, low: 3020, close: 3040, volume: 1 },
      { code: '000001', date: '2026-06-05', open: 3040, high: 3060, low: 3030, close: 3055, volume: 1 },
      { code: '000001', date: '2026-06-06', open: 3055, high: 3070, low: 3050, close: 3060, volume: 1 },
    ].slice(0, n); };
    const out = await svc.ensureIndexBars('u1', '000001', 5, { fetcher });
    expect(fetched).toBe(1);
    expect(out.length).toBeGreaterThanOrEqual(5);
  });
});

describe('getStockSnapshot depth gate', () => {
  it('shouldDeepFetch true when local closes < 60', () => {
    const code = 'DEP01';
    const { getDb } = require('../db');
    const db = getDb();
    for (let i = 0; i < 10; i++) {
      db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,close,source) VALUES (?,?,?,?)').run(code, `2026-05-${(i+1).toString().padStart(2,'0')}`, 5, 'test');
    }
    expect(svc.shouldDeepFetch(code)).toBe(true);
  });
  it('shouldDeepFetch false when local closes >= 60', () => {
    const code = 'DEP02';
    const { getDb } = require('../db');
    const db = getDb();
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,close,source) VALUES (?,?,?,?)').run(code, d, 5, 'test');
    }
    expect(svc.shouldDeepFetch(code)).toBe(false);
  });
});

describe('getMarketSentimentSeries', () => {
  it('returns ascending series capped at n', () => {
    const db = svc.getDb ? svc.getDb() : require('../db').getDb();
    for (const d of ['2026-06-01','2026-06-02','2026-06-03']) {
      db.prepare('INSERT OR REPLACE INTO market_sentiment (date,limit_up_count,limit_down_count,sse_ma20_slope,source) VALUES (?,?,?,?,?)')
        .run(d, 50, 10, 0.1, 'test');
    }
    const s = svc.getMarketSentimentSeries(2);
    expect(s.map((x: any) => x.date)).toEqual(['2026-06-02','2026-06-03']);
  });
});

describe('fundamentalsIncomplete', () => {
  it('true when no fundamentals or missing pe; false when pe present', () => {
    const code = 'FUND01';
    expect(svc.fundamentalsIncomplete(code)).toBe(true); // none cached
    svc.cacheFundamentals(code, '2026-06-08', { net_profit: 100, roe_ttm: 10 }, 'em'); // no pe
    expect(svc.fundamentalsIncomplete(code)).toBe(true);
    svc.cacheFundamentals(code, '2026-06-08', { pe: 19, pb: 5, ps: 9, net_profit: 100, roe_ttm: 10 }, 'baidu');
    expect(svc.fundamentalsIncomplete(code)).toBe(false);
  });
});

describe('proxy config', () => {
  it('returns disabled default when unset', () => {
    const c = svc.getProxyConfig();
    expect(c).toEqual({ enabled: false, scheme: 'http', host: '', port: 0, username: '', password: '' });
  });
  it('round-trips set/get incl password', () => {
    svc.setProxyConfig({ enabled: true, scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' });
    expect(svc.getProxyConfig()).toEqual({ enabled: true, scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' });
  });
});

describe('ensureIndexBars freshness (refetch when stale, not just when count low)', () => {
  it('refetches when local latest < freshThrough even though row count is sufficient', async () => {
    const code = 'IDXFRESH1';
    svc.cacheIndexBars([
      { code, date: '2026-06-05', open: 1, high: 1, low: 1, close: 3000, volume: 1 },
      { code, date: '2026-06-08', open: 1, high: 1, low: 1, close: 3010, volume: 1 },
    ], 'seed');
    let called = 0;
    const fetcher = async () => { called++; return [{ code, date: '2026-06-09', open: 1, high: 1, low: 1, close: 3020, volume: 1 }]; };
    const bars = await svc.ensureIndexBars('u', code, 2, { fetcher, freshThrough: '2026-06-09' });
    expect(called).toBe(1);
    expect(bars[bars.length - 1].date).toBe('2026-06-09');
  });

  it('does NOT refetch when local is already fresh enough', async () => {
    const code = 'IDXFRESH2';
    svc.cacheIndexBars([
      { code, date: '2026-06-08', open: 1, high: 1, low: 1, close: 3010, volume: 1 },
      { code, date: '2026-06-09', open: 1, high: 1, low: 1, close: 3020, volume: 1 },
    ], 'seed');
    let called = 0;
    const fetcher = async () => { called++; return []; };
    const bars = await svc.ensureIndexBars('u', code, 2, { fetcher, freshThrough: '2026-06-09' });
    expect(called).toBe(0);
    expect(bars.length).toBe(2);
  });
});

describe('ma20Slope (local SSE slope fallback)', () => {
  it('returns MA20(today)-MA20(prev); null when <21 closes', () => {
    const bars = Array.from({ length: 25 }, (_, i) => ({ date: '2026-06-' + String(i + 1).padStart(2, '0'), open: 0, high: 0, low: 0, close: 100 + i, volume: 0 }));
    const s = svc.ma20Slope(bars);
    expect(s).toBeCloseTo(1, 5); // closes rise by 1/day → ma20 rises by 1/day
    expect(svc.ma20Slope(bars.slice(0, 10))).toBeNull();
  });
});

describe('cron config + status', () => {
  it('getCronConfig default empty; set/get round-trips', () => {
    expect(svc.getCronConfig()).toEqual({});
    svc.setCronConfig({ nightly: { expr: '5 23 * * *', enabled: false } });
    expect(svc.getCronConfig()).toEqual({ nightly: { expr: '5 23 * * *', enabled: false } });
  });
  it('records cron start/finish with duration + run_count', () => {
    svc.recordCronStart('nightly');
    let s = svc.getCronStatus('nightly');
    expect(s.last_status).toBe('running');
    svc.recordCronFinish('nightly', 'ok', 1234, null);
    s = svc.getCronStatus('nightly');
    expect(s).toMatchObject({ last_status: 'ok', last_duration_ms: 1234, run_count: 1 });
    svc.recordCronStart('nightly'); svc.recordCronFinish('nightly', 'error', 50, 'boom');
    s = svc.getCronStatus('nightly');
    expect(s).toMatchObject({ last_status: 'error', last_error: 'boom', run_count: 2 });
  });
});

describe('realtime_quote', () => {
  const svc = require('./service');
  it('cacheRealtime/getRealtime 往返(含五档) + upsert 重置未给字段', () => {
    svc.cacheRealtime('600519', { price: 1700, open: 1690, bid1: 1699, bid1_vol: 50, ask1: 1701, ask1_vol: 60, bid5: 1695, ask5: 1705, time: '15:00:00' }, 'tdx-rt');
    const r = svc.getRealtime('600519');
    expect(r).toMatchObject({ code: '600519', price: 1700, bid1: 1699, bid1_vol: 50, ask1: 1701, ask5: 1705, source: 'tdx-rt' });
    svc.cacheRealtime('600519', { price: 1710 }, 'sina-rt');
    const r2 = svc.getRealtime('600519');
    expect(r2.price).toBe(1710);
    expect(r2.source).toBe('sina-rt');
    expect(r2.bid1).toBeNull();
  });
  it('getRealtime 未知 code → null', () => {
    expect(svc.getRealtime('000001')).toBeNull();
  });
});

describe('ingestRealtime', () => {
  const svc = require('./service');
  const sidecar = require('./sidecar');
  afterEach(() => jest.restoreAllMocks());

  it('非交易时段直接跳过、不写表', async () => {
    const sun = Date.UTC(2026, 5, 7, 2, 0, 0); // 周日 北京 10:00
    const r = await svc.ingestRealtime('uid', { now: sun });
    expect(r.skipped).toBe(true);
    expect(r.count).toBe(0);
  });

  it('交易时段遍历已缓存股票、写实时表', async () => {
    const { getDb } = require('../db');
    getDb().prepare("INSERT OR IGNORE INTO quote_daily (code, date, close) VALUES ('600000','2026-06-09',10)").run();
    jest.spyOn(sidecar, 'resolveSidecarBase').mockReturnValue('http://x');
    jest.spyOn(sidecar, 'fetchRealtime').mockResolvedValue({ source: 'tdx-rt', data: { price: 9.99, bid1: 9.98, bid1_vol: 10, time: '10:00:00' } });
    const wed = Date.UTC(2026, 5, 10, 2, 0, 0); // 周三 北京 10:00
    const r = await svc.ingestRealtime('uid', { now: wed });
    expect(r.skipped).toBe(false);
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(svc.getRealtime('600000')).toMatchObject({ price: 9.99, bid1: 9.98 });
  });
});

describe('getStockSnapshot 优先实时表', () => {
  const svc = require('./service');
  const sidecar = require('./sidecar');
  afterEach(() => jest.restoreAllMocks());

  it('实时表新鲜(<2min)时用表数据(含五档)、不调 live', async () => {
    svc.cacheRealtime('600000', { price: 12.3, bid1: 12.29, bid1_vol: 100, ask1: 12.31, time: '10:00:00' }, 'tdx-rt');
    const spy = jest.spyOn(sidecar, 'fetchRealtime').mockResolvedValue(null);
    const snap = await svc.getStockSnapshot('uid', '600000');
    expect(snap.realtime).toMatchObject({ price: 12.3, bid1: 12.29, bid1_vol: 100, ask1: 12.31 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('实时表陈旧(>2min)时回退 live fetchRealtime', async () => {
    svc.cacheRealtime('600001', { price: 5.0, time: '09:40:00' }, 'tdx-rt');
    // 把 fetched_at 改成 10 分钟前，制造陈旧
    require('../db').getDb().prepare("UPDATE realtime_quote SET fetched_at = datetime('now','-10 minutes') WHERE code='600001'").run();
    jest.spyOn(sidecar, 'resolveSidecarBase').mockReturnValue('http://x');
    const spy = jest.spyOn(sidecar, 'fetchRealtime').mockResolvedValue({ source: 'tdx-rt', data: { price: 5.55, bid1: 5.54, time: '10:00:00' } });
    const snap = await svc.getStockSnapshot('uid', '600001');
    expect(spy).toHaveBeenCalled();
    expect(snap.realtime).toMatchObject({ price: 5.55, bid1: 5.54, source: 'tdx-rt' });
  });
});
