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
  it('lists starter templates (V3 dual-system removed from the picker)', async () => {
    const res = await request(app).get('/api/rulebook/templates').set(h(tok));
    expect(res.status).toBe(200);
    const keys = res.body.data.map((t: any) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['ma-bullish', 'value-quality']));
    expect(keys).not.toContain('v3-dual-system');
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

  it('stock session: analyze runs a report and seeds an opening message; follow-up is grounded', async () => {
    await request(app).post('/api/rulebook/init').set(h(tok)).send({}); // ensure rulebook (409 if exists is fine)
    // deepseek already configured above; mock AI for analysis + chat, sidecar -> 404 (graceful)
    const ANALYSIS_JSON =
      '{"a_conclusion":"ROE达标，进A观察","b_conclusion":"情绪闸门关","exception_channel":null,"position_suggestion":"试仓","one_liner":"可中线关注","teach_notes":[]}';
    (global as any).fetch = jest.fn((url: string) =>
      String(url).includes('/chat/completions')
        ? Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: ANALYSIS_JSON } }] }) })
        : Promise.resolve({ ok: false, status: 404, statusText: 'NF', text: async () => '' })
    );

    // seed complete data so validation passes
    const data = require('../data/service');
    data.cacheFundamentals('600519', '2026-06-05', { roe_ttm: 30, pe: 25, pb: 8, ps: 12, net_profit: 1e9, turnover_rate: 1, name: '贵州茅台' }, 'csv');
    data.cacheQuotes(Array.from({ length: 60 }, (_, i) => ({ code: '600519', date: `2026-04-${String(60 - i).padStart(2, '0')}`, open: 1700, high: 1700, low: 1700, close: 1700, volume: 1 })), 'csv');
    data.cacheMarket('2026-06-05', { limit_up_count: 60, limit_down_count: 5, sse_ma20_slope: 0.1 }, 'csv');

    const s = await request(app).post('/api/chat/sessions').set(h(tok)).send({ kind: 'stock', refId: '600519', title: '个股 600519' });
    const sid = s.body.data.id;
    const a = await request(app).post(`/api/chat/sessions/${sid}/analyze`).set(h(tok));
    expect(a.status).toBe(201);
    expect(a.body.data.report.stock_code).toBe('600519');
    expect(a.body.data.message.role).toBe('assistant');
    expect(a.body.data.message.content).toContain('可中线关注');

    const msgs = await request(app).get(`/api/chat/sessions/${sid}/messages`).set(h(tok));
    expect(msgs.body.data).toHaveLength(1); // seeded assistant opening

    // a follow-up returns another assistant message (grounded in the report)
    (global as any).fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: '基于上面的判定，建议轻仓试一手。' } }] }) })
    );
    const f = await request(app).post(`/api/chat/sessions/${sid}/messages`).set(h(tok)).send({ content: '那我能买吗？' });
    expect(f.status).toBe(201);
    expect(f.body.data.content).toContain('轻仓');
    jest.restoreAllMocks();
  });

  it('clear-all deletes every session for the user', async () => {
    await request(app).post('/api/chat/sessions').set(h(tok)).send({ kind: 'general' });
    const before = await request(app).get('/api/chat/sessions').set(h(tok));
    expect(before.body.data.length).toBeGreaterThan(0);
    const del = await request(app).delete('/api/chat/sessions').set(h(tok));
    expect(del.status).toBe(200);
    const after = await request(app).get('/api/chat/sessions').set(h(tok));
    expect(after.body.data).toHaveLength(0);
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
    expect(list.body.data).toHaveLength(6);
    const upd = await request(app).put('/api/agent/profiles/core').set(h(tok)).send({ persona: '稳健中线主 agent' });
    expect(upd.status).toBe(200);
    const after = await request(app).get('/api/agent/profiles').set(h(tok));
    expect(after.body.data.find((p: any) => p.role === 'core').persona).toBe('稳健中线主 agent');
  });
});
