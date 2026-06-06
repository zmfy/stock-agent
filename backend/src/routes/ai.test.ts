import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-airoute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let adminTok = '';
let userTok = '';

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456' });
  adminTok = login.body.data.accessToken;
  // create a second user via invite
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${adminTok}`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'trader2', password: 'secret123', inviteCode: inv.body.data.code });
  userTok = reg.body.data.accessToken;
});

const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('ai routes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists the provider catalog (6) and requires auth', async () => {
    expect((await request(app).get('/api/ai/providers')).status).toBe(401);
    const res = await request(app).get('/api/ai/providers').set(h(adminTok));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(6);
    expect(res.body.data.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(['deepseek', 'qwen', 'openai', 'claude', 'minimax', 'ollama'])
    );
  });

  it('saves a config and masks the key on read', async () => {
    const save = await request(app)
      .put('/api/ai/configs/deepseek')
      .set(h(adminTok))
      .send({ apiKey: 'sk-abcdefgh1234', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    expect(save.status).toBe(200);
    const list = await request(app).get('/api/ai/configs').set(h(adminTok));
    const ds = list.body.data.find((c: any) => c.provider === 'deepseek');
    expect(ds.apiKeySet).toBe(true);
    expect(ds.apiKeyMasked).toBe('sk-a****1234');
    expect(JSON.stringify(list.body)).not.toContain('sk-abcdefgh1234');
  });

  it('configs are isolated per user', async () => {
    const list = await request(app).get('/api/ai/configs').set(h(userTok));
    expect(list.body.data).toHaveLength(0);
  });

  it('rejects saving without a key for a provider that needs one', async () => {
    const res = await request(app)
      .put('/api/ai/configs/openai')
      .set(h(adminTok))
      .send({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
    expect(res.status).toBe(400);
  });

  it('/active auto-resolves to the configured deepseek (core role)', async () => {
    const active = await request(app).get('/api/ai/active').set(h(adminTok));
    expect(active.body.data.provider).toBe('deepseek');
    expect(active.body.data.model).toBe('deepseek-chat');
  });

  it('GET /roles returns all 5 roles, resolved to the only enabled config', async () => {
    const res = await request(app).get('/api/ai/roles').set(h(adminTok));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: any) => r.role)).toEqual(['core', 'data', 'analysis', 'qualitative', 'review', 'validation']);
    expect(res.body.data.every((r: any) => r.resolvedProvider === 'deepseek')).toBe(true);
  });

  it('PUT /roles/:role pins manually then reverts to auto', async () => {
    const pin = await request(app).put('/api/ai/roles/data').set(h(adminTok)).send({ mode: 'manual', provider: 'deepseek' });
    expect(pin.status).toBe(200);
    const auto = await request(app).put('/api/ai/roles/data').set(h(adminTok)).send({ mode: 'auto' });
    expect(auto.status).toBe(200);
  });

  it('PUT /roles/:role manual without provider is 422', async () => {
    const res = await request(app).put('/api/ai/roles/data').set(h(adminTok)).send({ mode: 'manual' });
    expect(res.status).toBe(422);
  });

  it('enable toggle removes/returns the config from the pool', async () => {
    await request(app).post('/api/ai/configs/deepseek/enable').set(h(adminTok)).send({ enabled: false });
    const off = await request(app).get('/api/ai/active').set(h(adminTok));
    expect(off.body.data).toBeNull();
    await request(app).post('/api/ai/configs/deepseek/enable').set(h(adminTok)).send({ enabled: true });
    const on = await request(app).get('/api/ai/active').set(h(adminTok));
    expect(on.body.data.provider).toBe('deepseek');
  });

  it('test endpoint reports ok with a mocked successful provider call', async () => {
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) })
    );
    const res = await request(app)
      .post('/api/ai/configs/deepseek/test')
      .set(h(adminTok))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.reply).toBe('OK');
  });

  it('test endpoint reports ok:false when the provider call fails', async () => {
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' })
    );
    const res = await request(app)
      .post('/api/ai/configs/deepseek/test')
      .set(h(adminTok))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error).toMatch(/401/);
  });

  it('test endpoint 422 for unknown provider', async () => {
    const res = await request(app).post('/api/ai/configs/nope/test').set(h(adminTok)).send({});
    expect(res.status).toBe(422);
  });
});
