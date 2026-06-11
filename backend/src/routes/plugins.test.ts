import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-plugroute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let adminTok = '';
let userTok = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456' , agreed: true });
  adminTok = login.body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${adminTok}`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'trader3', password: 'secret123', inviteCode: inv.body.data.code , agreed: true });
  userTok = reg.body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('plugins routes', () => {
  it('catalog has 6 entries and requires auth', async () => {
    expect((await request(app).get('/api/plugins/catalog')).status).toBe(401);
    const res = await request(app).get('/api/plugins/catalog').set(h(adminTok));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(6);
  });

  it('built-ins are enabled by default; disabling persists', async () => {
    const list0 = await request(app).get('/api/plugins').set(h(adminTok));
    expect(list0.body.data.every((p: any) => p.enabled)).toBe(true);
    const off = await request(app).post('/api/plugins/fetch/enable').set(h(adminTok)).send({ enabled: false });
    expect(off.status).toBe(200);
    const list1 = await request(app).get('/api/plugins').set(h(adminTok));
    expect(list1.body.data.find((p: any) => p.key === 'fetch').enabled).toBe(false);
  });

  it('a new user sees built-ins enabled by default (isolation)', async () => {
    const list = await request(app).get('/api/plugins').set(h(userTok));
    expect(list.body.data.find((p: any) => p.key === 'playwright').enabled).toBe(true);
    expect(list.body.data.find((p: any) => p.key === 'fetch').enabled).toBe(true); // admin's disable didn't leak
  });

  it('adds a custom plugin; duplicate is 409', async () => {
    const add = await request(app)
      .post('/api/plugins/custom')
      .set(h(adminTok))
      .send({ key: 'tushare', label: 'Tushare Pro', kind: 'mcp', transport: 'http', config: { url: 'http://tushare/sse' } });
    expect(add.status).toBe(201);
    const dup = await request(app)
      .post('/api/plugins/custom')
      .set(h(adminTok))
      .send({ key: 'tushare', label: 'dup', kind: 'mcp', config: {} });
    expect(dup.status).toBe(409);
  });

  it('enabled endpoint groups mcp vs skill', async () => {
    await request(app).post('/api/plugins/research/enable').set(h(adminTok)).send({ enabled: true });
    const res = await request(app).get('/api/plugins/enabled').set(h(adminTok));
    expect(res.body.data.mcp.map((m: any) => m.key)).toEqual(expect.arrayContaining(['playwright', 'tushare']));
    expect(res.body.data.skills.map((s: any) => s.key)).toContain('research');
  });

  it('updates config and removes', async () => {
    const upd = await request(app)
      .put('/api/plugins/akshare-data/config')
      .set(h(adminTok))
      .send({ config: { url: 'http://x:1/sse' } });
    expect(upd.status).toBe(200);
    const del = await request(app).delete('/api/plugins/tushare').set(h(adminTok));
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/plugins').set(h(adminTok));
    expect(list.body.data.find((p: any) => p.key === 'tushare')).toBeUndefined();
  });
});

describe('shared plugins routes', () => {
  it('admin 才能共享：用户 403、admin 200', async () => {
    await request(app).post('/api/plugins/custom').set(h(adminTok)).send({ key: 'shmcp', label: '共享MCP', kind: 'mcp', transport: 'http', config: { url: 'http://x' } });
    const u = await request(app).post('/api/plugins/shmcp/share').set(h(userTok)).send({ shared: true });
    expect(u.status).toBe(403);
    const a = await request(app).post('/api/plugins/shmcp/share').set(h(adminTok)).send({ shared: true });
    expect(a.status).toBe(200);
  });

  it('GET /plugins 给用户返回共享项且无 config', async () => {
    const res = await request(app).get('/api/plugins').set(h(userTok));
    const m = res.body.data.find((p: any) => p.key === 'shmcp');
    expect(m).toMatchObject({ shared: true, owner: 'admin' });
    expect(m.config).toEqual({});
  });

  it('用户可 opt-out 共享插件', async () => {
    const off = await request(app).post('/api/plugins/shared/shmcp/enable').set(h(userTok)).send({ enabled: false });
    expect(off.status).toBe(200);
    const res = await request(app).get('/api/plugins').set(h(userTok));
    expect(res.body.data.find((p: any) => p.key === 'shmcp').enabled).toBe(false);
  });
});
