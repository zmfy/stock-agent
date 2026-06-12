import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cronroute-'));
process.env.ENABLE_CRON = 'false';
delete process.env.REGISTRATION_MODE;
const { createApp } = require('../index');
const app = createApp();
let aTok = '', uTok = '';
beforeAll(async () => {
  aTok = (await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456', agreed: true })).body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${aTok}`);
  uTok = (await request(app).post('/api/auth/register').send({ username: 'cronu', password: 'secret123', inviteCode: inv.body.data.code, agreed: true })).body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('cron routes', () => {
  it('GET /api/cron requires admin', async () => {
    expect((await request(app).get('/api/cron').set(h(uTok))).status).toBe(403);
  });
  it('lists 5 jobs with cronEnabled flag', async () => {
    const r = await request(app).get('/api/cron').set(h(aTok));
    expect(r.status).toBe(200);
    expect(r.body.data.cronEnabled).toBe(false);
    expect(r.body.data.jobs.length).toBe(5);
    expect(r.body.data.jobs.find((j: any) => j.key === 'nightly').time).toBe('23:00');
  });
  it('定时任务列表含 realtime(自定义周期，非每日 time)', async () => {
    const res = await request(app).get('/api/cron').set(h(aTok));
    expect(res.status).toBe(200);
    const rt = res.body.data.jobs.find((j: any) => j.key === 'realtime');
    expect(rt).toBeTruthy();
    expect(rt.time).toBeNull();
    expect(rt.expr).toBe('*/5 * * * *');
  });
  it('PUT changes time + enabled', async () => {
    const r = await request(app).put('/api/cron/nightly').set(h(aTok)).send({ time: '23:30', enabled: false });
    expect(r.status).toBe(200);
    const list = await request(app).get('/api/cron').set(h(aTok));
    const n = list.body.data.jobs.find((j: any) => j.key === 'nightly');
    expect(n.time).toBe('23:30');
    expect(n.enabled).toBe(false);
    expect(n.nextRunAt).toBeNull();
  });
  it('PUT rejects bad time 422 / unknown job 404', async () => {
    expect((await request(app).put('/api/cron/nightly').set(h(aTok)).send({ time: '99:99' })).status).toBe(422);
    expect((await request(app).put('/api/cron/nope').set(h(aTok)).send({ enabled: true })).status).toBe(404);
  });
  it('GET log (admin) + run requires admin', async () => {
    expect((await request(app).get('/api/cron/nightly/log').set(h(aTok))).status).toBe(200);
    expect((await request(app).post('/api/cron/nightly/run').set(h(uTok))).status).toBe(403);
  });
});
