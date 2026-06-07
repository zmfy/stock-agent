import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-dataroute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const { parseQuotesCsv } = require('./data');
const app = createApp();

let tok = '';
let userTok = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456' });
  tok = login.body.data.accessToken;

  // Create a non-admin (role:'user') account via invite flow
  const invite = await request(app)
    .post('/api/settings/users/invite')
    .set('Authorization', `Bearer ${tok}`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'plainuser', password: 'secret123', inviteCode: invite.body.data.code, agreed: true });
  userTok = reg.body.data.accessToken;
});
const h = () => ({ Authorization: `Bearer ${tok}` });
const uh = () => ({ Authorization: `Bearer ${userTok}` });

describe('parseQuotesCsv', () => {
  it('parses English headers', () => {
    const rows = parseQuotesCsv('code,date,open,high,low,close,volume\n600000,2026-05-28,10,11,9,10.5,1000');
    expect(rows[0]).toMatchObject({ code: '600000', date: '2026-05-28', close: 10.5 });
  });
  it('parses 通达信 Chinese headers + 8-digit date + sh prefix', () => {
    const rows = parseQuotesCsv('代码,日期,开盘,最高,最低,收盘,成交量\nsh600519,20260528,1700,1720,1690,1710,500');
    expect(rows[0].code).toBe('600519');
    expect(rows[0].date).toBe('2026-05-28');
    expect(rows[0].close).toBe(1710);
  });
});

describe('data routes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires auth', async () => {
    expect((await request(app).get('/api/data/snapshot/600000')).status).toBe(401);
  });

  it('uploads a CSV and the snapshot reflects it (close + ma)', async () => {
    // 20 rows close=10 except newest=13
    let csv = 'code,date,open,high,low,close,volume\n';
    csv += `600000,2026-05-28,13,13,13,13,100\n`;
    for (let i = 1; i < 20; i++) csv += `600000,2026-05-${String(28 - i).padStart(2, '0')},10,10,10,10,100\n`;
    const up = await request(app).post('/api/data/quotes/csv').set(h()).attach('file', Buffer.from(csv), 'q.csv');
    expect(up.status).toBe(200);
    expect(up.body.data.inserted).toBe(20);

    const snap = await request(app).get('/api/data/snapshot/600000').set(h());
    expect(snap.body.data.close).toBe(13);
    expect(snap.body.data.ma20).toBeCloseTo((13 + 19 * 10) / 20, 5);
    // fundamentals not provided -> listed missing
    expect(snap.body.data._missing).toEqual(expect.arrayContaining(['roe_ttm', 'pe']));
  });

  it('eod status starts idle and run with an empty universe reports an error', async () => {
    const st0 = await request(app).get('/api/data/eod/status').set(h());
    expect(st0.status).toBe(200);
    expect(st0.body.data.state).toBe('idle');

    // No stock_names seeded in this test DB -> ingestEod short-circuits to an error state.
    (global as any).fetch = jest.fn((u: string) =>
      u.includes('/probe') ? Promise.resolve({ ok: true, json: async () => [] })
      : Promise.resolve({ ok: true, json: async () => ({ source: null, rows: [] }) }));
    const ing = await request(app).post('/api/data/eod/run').set(h());
    expect(ing.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const st1 = await request(app).get('/api/data/eod/status').set(h());
    expect(st1.body.data.state).toBe('error');
    expect(st1.body.data.message).toContain('股票库');
  });

  it('source endpoint reports the built-in data source as configured', async () => {
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('no-net')));
    const res = await request(app).get('/api/data/source').set(h());
    expect(res.status).toBe(200);
    expect(res.body.data.sidecarConfigured).toBe(true); // built-in data source is seeded
    expect(res.body.data.sidecarHealthy).toBe(false);
  });

  it('GET /api/data/probe 返回各 provider 状态', async () => {
    (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => [{ key: 'tx', label: '腾讯', reachable: true, latency_ms: 90, error: null }] }));
    const res = await request(app).get('/api/data/probe?kind=quote').set(h());
    expect(res.status).toBe(200);
    expect(res.body.data[0].key).toBe('tx');
  });

  it('POST /api/data/eod/run 触发；状态可查', async () => {
    (global as any).fetch = jest.fn((u: string) =>
      u.includes('/probe') ? Promise.resolve({ ok: true, json: async () => [] })
      : Promise.resolve({ ok: true, json: async () => ({ source: null, rows: [] }) }));
    const r1 = await request(app).post('/api/data/eod/run').set(h());
    expect(r1.status).toBeLessThan(500);
  });

  it('GET /api/data/eod/status 返回富状态字段', async () => {
    const res = await request(app).get('/api/data/eod/status').set(h());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('last_success_at');
    expect(res.body.data).toHaveProperty('cancel_requested');
  });

  it('POST /api/data/eod/cancel 与 /log 需要 admin（admin token 可用）', async () => {
    const res = await request(app).post('/api/data/eod/cancel').set(h());
    expect(res.status).toBe(200);
    const log = await request(app).get('/api/data/eod/log').set(h());
    expect(log.status).toBe(200);
    expect(Array.isArray(log.body.data)).toBe(true);
  });

  it('admin 强制中止把 running 重置为 idle；非 admin 403', async () => {
    const svc = require('../data/service');
    svc.beginJob('eod', 'tester', 10);
    expect(svc.getSyncStatus('eod').state).toBe('running');
    const forbidden = await request(app).post('/api/data/eod/force-stop').set(uh());
    expect(forbidden.status).toBe(403);
    const ok = await request(app).post('/api/data/eod/force-stop').set(h());
    expect(ok.status).toBe(200);
    expect(ok.body.data.state).toBe('idle');
    expect(svc.getSyncStatus('eod').cancel_requested).toBe(1);
    expect(svc.canStartJob('eod')).toBe(true);
    const bad = await request(app).post('/api/data/nope/force-stop').set(h());
    expect(bad.status).toBe(400);
  });

  it('POST /api/data/foo/run → 400 未知任务', async () => {
    const res = await request(app).post('/api/data/foo/run').set(h());
    expect(res.status).toBe(400);
  });

  it('非管理员访问 eod/cancel 和 eod/log 返回 403', async () => {
    const cancel = await request(app).post('/api/data/eod/cancel').set(uh());
    expect(cancel.status).toBe(403);
    const log = await request(app).get('/api/data/eod/log').set(uh());
    expect(log.status).toBe(403);
  });

  it('GET /api/data/news/log 返回采集日志；/news/content/:id 返回内容', async () => {
    const nl = require('../data/news-log');
    const [{ content_id }] = nl.recordCollected([{ title: '日志测试', content: '内容Z', source: 'em', published_at: 'p' }]);
    const log = await request(app).get('/api/data/news/log').set('Authorization', `Bearer ${tok}`);
    expect(log.status).toBe(200);
    expect(log.body.data.some((x: any) => x.title === '日志测试')).toBe(true);
    const c = await request(app).get(`/api/data/news/content/${content_id}`).set('Authorization', `Bearer ${tok}`);
    expect(c.status).toBe(200);
    expect(c.body.data.content).toBe('内容Z');
  });

  it('数据源增删改查写入轮转：POST → GET → PUT → DELETE', async () => {
    // POST /api/data/sources — admin only
    const add = await request(app)
      .post('/api/data/sources')
      .set(h())
      .send({ name: '测试源', base_url: 'http://t:8000' });
    expect(add.status).toBeLessThan(300); // 200 or 201
    const addedId: string = add.body.data.id;
    expect(addedId).toBeTruthy();

    // GET /api/data/sources — lists the new source
    const list = await request(app).get('/api/data/sources').set(h());
    expect(list.status).toBe(200);
    expect(list.body.data.some((s: { id: string }) => s.id === addedId)).toBe(true);

    // PUT /api/data/sources/:id — disable it (enabled: 0)
    const upd = await request(app)
      .put(`/api/data/sources/${addedId}`)
      .set(h())
      .send({ enabled: 0 });
    expect(upd.status).toBe(200);

    // DELETE /api/data/sources/:id
    const del = await request(app).delete(`/api/data/sources/${addedId}`).set(h());
    expect(del.status).toBe(200);

    // Confirm it's gone
    const list2 = await request(app).get('/api/data/sources').set(h());
    expect(list2.body.data.some((s: { id: string }) => s.id === addedId)).toBe(false);
  });
});
