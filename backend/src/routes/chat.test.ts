import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-chat-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let tok = '';
let userTok = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456' });
  tok = login.body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${tok}`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'chatuser', password: 'secret123', inviteCode: inv.body.data.code });
  userTok = reg.body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('rulebook templates', () => {
  it('lists 3 starter templates incl the user default', async () => {
    const res = await request(app).get('/api/rulebook/templates').set(h(tok));
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: any) => t.key)).toEqual(
      expect.arrayContaining(['v3-dual-system', 'ma-bullish', 'value-quality'])
    );
  });

  it('init with a chosen template instantiates that one', async () => {
    const res = await request(app).post('/api/rulebook/init').set(h(userTok)).send({ template: 'value-quality' });
    expect(res.status).toBe(201);
    expect(res.body.data.version.version_label).toContain('价值质量');
    const roe = res.body.data.gates.find((g: any) => g.gate_key === 'roe_ttm');
    expect(roe.threshold).toBe(15);
  });
});

describe('chat routes', () => {
  it('requires a configured model (NO_MODEL) before chatting', async () => {
    const s = await request(app).post('/api/chat/sessions').set(h(userTok)).send({ kind: 'general' });
    const msg = await request(app).post(`/api/chat/sessions/${s.body.data.id}/messages`).set(h(userTok)).send({ content: '你好' });
    expect(msg.status).toBe(400);
    expect(msg.body.message).toContain('AI');
  });

  it('creates a session, posts a message, gets an AI reply (mocked), persists both', async () => {
    // configure an AI model for stock-agent
    await request(app)
      .put('/api/ai/configs/deepseek')
      .set(h(tok))
      .send({ apiKey: 'sk-x123456789', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '你好，我是你的操盘助手。' } }] }) })
    );

    const s = await request(app).post('/api/chat/sessions').set(h(tok)).send({ kind: 'general', title: '闲聊' });
    const sid = s.body.data.id;
    const msg = await request(app).post(`/api/chat/sessions/${sid}/messages`).set(h(tok)).send({ content: '今天大盘怎么样？' });
    expect(msg.status).toBe(201);
    expect(msg.body.data.role).toBe('assistant');
    expect(msg.body.data.content).toContain('操盘助手');

    const all = await request(app).get(`/api/chat/sessions/${sid}/messages`).set(h(tok));
    expect(all.body.data).toHaveLength(2); // user + assistant
    jest.restoreAllMocks();
  });

  it("cannot read another user's session", async () => {
    const s = await request(app).post('/api/chat/sessions').set(h(tok)).send({ kind: 'general' });
    const res = await request(app).get(`/api/chat/sessions/${s.body.data.id}/messages`).set(h(userTok));
    expect(res.status).toBe(404);
  });
});

describe('agent profiles routes', () => {
  it('lists profiles and updates one', async () => {
    const list = await request(app).get('/api/agent/profiles').set(h(tok));
    expect(list.body.data).toHaveLength(5);
    const upd = await request(app).put('/api/agent/profiles/core').set(h(tok)).send({ persona: '稳健中线主 agent' });
    expect(upd.status).toBe(200);
    const after = await request(app).get('/api/agent/profiles').set(h(tok));
    expect(after.body.data.find((p: any) => p.role === 'core').persona).toBe('稳健中线主 agent');
  });
});
