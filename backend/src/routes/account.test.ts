import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-account-'));
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

describe('account profile (nickname)', () => {
  it('PUT /api/account/profile 改昵称并读回；用户名不变', async () => {
    const r = await request(app).put('/api/account/profile').set(h(userTok)).send({ nickname: '小明' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ username: 'plainu', nickname: '小明' });
    const me = await request(app).get('/api/auth/me').set(h(userTok));
    expect(me.body.data.nickname).toBe('小明');
    expect(me.body.data.username).toBe('plainu');
  });
  it('空昵称 → 清除', async () => {
    const r = await request(app).put('/api/account/profile').set(h(userTok)).send({ nickname: '' });
    expect(r.status).toBe(200);
    expect(r.body.data.nickname).toBe('');
  });
  it('超长昵称(>30) → 422', async () => {
    const r = await request(app).put('/api/account/profile').set(h(userTok)).send({ nickname: 'x'.repeat(31) });
    expect(r.status).toBe(422);
  });
  it('未登录 401', async () => {
    expect((await request(app).put('/api/account/profile').send({ nickname: 'a' })).status).toBe(401);
  });
});
