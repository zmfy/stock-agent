import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-analysisroute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let adminTok = '';
let freshTok = '';

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456' });
  adminTok = login.body.data.accessToken;
  // a second user with NO rulebook and NO AI
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${adminTok}`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username: 'fresh', password: 'secret123', inviteCode: inv.body.data.code });
  freshTok = reg.body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

// Default: no network (akshare-data is default-ON, so snapshot would otherwise try the sidecar).
// Individual tests override global.fetch as needed.
beforeEach(() => {
  (global as any).fetch = jest.fn(() => Promise.reject(new Error('net-off-in-test')));
});

const AI_JSON =
  '{"a_conclusion":"ROE不足，不进A","b_conclusion":"情绪闸门关闭","exception_channel":null,"position_suggestion":"0仓","one_liner":"淘汰","teach_notes":[{"gate_key":"roe_ttm","note":"ROE是核心"}]}';

describe('analysis routes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('run without a rulebook -> 400 NO_RULEBOOK message', async () => {
    const res = await request(app).post('/api/analysis/run').set(h(freshTok)).send({ code: '600000' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('核心规则');
  });

  it('run with rulebook but no AI model -> 400', async () => {
    await request(app).post('/api/rulebook/init').set(h(freshTok));
    // disable the default akshare-data so snapshot stays offline/fast; no AI configured
    const res = await request(app).post('/api/analysis/run').set(h(freshTok)).send({ code: '600000' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('AI');
  });

  it('runs end-to-end (mocked AI) and persists an auditable report', async () => {
    // admin: rulebook + an enabled AI model
    await request(app).post('/api/rulebook/init').set(h(adminTok));
    await request(app)
      .put('/api/ai/configs/deepseek')
      .set(h(adminTok))
      .send({ apiKey: 'sk-x123456789', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });

    // mock every fetch: AI chat returns our JSON; sidecar calls return junk (graceful -> nulls)
    (global as any).fetch = jest.fn((url: string) => {
      if (String(url).includes('/chat/completions')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: AI_JSON } }] }) });
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'NF', text: async () => '' });
    });

    const run = await request(app).post('/api/analysis/run').set(h(adminTok)).send({ code: '300241' });
    expect(run.status).toBe(201);
    expect(run.body.data.one_liner).toBe('淘汰');
    expect(run.body.data.ai_model).toBe('deepseek-chat');
    expect(run.body.data.rulebook_version_id).toBeTruthy();
    expect(Array.isArray(run.body.data.gate_results)).toBe(true);
    expect(run.body.data.gate_results.length).toBe(10);

    const id = run.body.data.id;
    const list = await request(app).get('/api/analysis/reports').set(h(adminTok));
    expect(list.body.data.some((r: any) => r.id === id)).toBe(true);
    const detail = await request(app).get(`/api/analysis/reports/${id}`).set(h(adminTok));
    expect(detail.status).toBe(200);
    expect(detail.body.data.a_conclusion).toContain('不进A');
  });

  it('404 for an unknown report', async () => {
    const res = await request(app).get('/api/analysis/reports/nope').set(h(adminTok));
    expect(res.status).toBe(404);
  });
});
