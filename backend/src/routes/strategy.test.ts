import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-stratroute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let userTok = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456', agreed: true });
  const tok = login.body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${tok}`);
  const reg = await request(app).post('/api/auth/register').send({ username: 'plainu', password: 'secret123', inviteCode: inv.body.data.code, agreed: true });
  userTok = reg.body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('strategy schedule routes', () => {
  it('GET 默认配置', async () => {
    const res = await request(app).get('/api/strategy/schedule').set(h(userTok));
    expect(res.status).toBe(200);
    expect(res.body.data.config).toEqual({ prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' });
  });
  it('PUT 合法保存并读回', async () => {
    const put = await request(app).put('/api/strategy/schedule').set(h(userTok)).send({ intradayInterval: 120, prejudgeTime: '08:45' });
    expect(put.status).toBe(200);
    expect(put.body.data.config).toMatchObject({ intradayInterval: 120, prejudgeTime: '08:45' });
    const get = await request(app).get('/api/strategy/schedule').set(h(userTok));
    expect(get.body.data.config.intradayInterval).toBe(120);
  });
  it('PUT 非法 → 422', async () => {
    expect((await request(app).put('/api/strategy/schedule').set(h(userTok)).send({ intradayInterval: 45 })).status).toBe(422);
    expect((await request(app).put('/api/strategy/schedule').set(h(userTok)).send({ reviewTime: '99:99' })).status).toBe(422);
  });
  it('未登录 401', async () => {
    expect((await request(app).get('/api/strategy/schedule')).status).toBe(401);
  });
});
