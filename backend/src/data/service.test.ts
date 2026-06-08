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
    expect(svc.canStartJob('eod')).toBe(false);
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
