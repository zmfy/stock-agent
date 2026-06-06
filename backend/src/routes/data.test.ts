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
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456' });
  tok = login.body.data.accessToken;
});
const h = () => ({ Authorization: `Bearer ${tok}` });

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

  it('source endpoint reports the built-in data source as configured', async () => {
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('no-net')));
    const res = await request(app).get('/api/data/source').set(h());
    expect(res.status).toBe(200);
    expect(res.body.data.sidecarConfigured).toBe(true); // built-in data source is seeded
    expect(res.body.data.sidecarHealthy).toBe(false);
  });
});
