import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mktroute-'));
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

describe('market status route', () => {
  it('GET /api/market/status 返回结构(普通用户可访问)', async () => {
    const res = await request(app).get('/api/market/status').set(h(userTok));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.indices)).toBe(true);
    expect(res.body.data.indices).toHaveLength(5);
    expect(res.body.data).toHaveProperty('updatedAt');
    expect(res.body.data).toHaveProperty('alertLevel');
  });
  it('未登录 401', async () => {
    expect((await request(app).get('/api/market/status')).status).toBe(401);
  });
});
