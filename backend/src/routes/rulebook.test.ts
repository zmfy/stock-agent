import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rbroute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let token = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456' });
  token = login.body.data.accessToken;
});
const auth = () => ({ Authorization: `Bearer ${token}` });

describe('rulebook routes', () => {
  it('active is null before init, requires auth', async () => {
    const noAuth = await request(app).get('/api/rulebook/active');
    expect(noAuth.status).toBe(401);
    const res = await request(app).get('/api/rulebook/active').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('init imports the V3.0 baseline; second init is 409', async () => {
    const res = await request(app).post('/api/rulebook/init').set(auth());
    expect(res.status).toBe(201);
    expect(res.body.data.version.version_label).toBe('V3.0');
    expect(res.body.data.gates.length).toBe(10);

    const again = await request(app).post('/api/rulebook/init').set(auth());
    expect(again.status).toBe(409);
  });

  it('active now returns V3.0', async () => {
    const res = await request(app).get('/api/rulebook/active').set(auth());
    expect(res.body.data.version.version_label).toBe('V3.0');
  });

  it('creates a new version, diffs it, then activates it', async () => {
    const active = (await request(app).get('/api/rulebook/active').set(auth())).body.data;
    const gates = active.gates.map((g: any) =>
      g.gate_key === 'roe_ttm' ? { ...g, threshold: 8 } : g
    );
    const created = await request(app)
      .post('/api/rulebook/versions')
      .set(auth())
      .send({
        versionLabel: 'V3.1',
        persona: active.version.persona,
        note: '放宽 ROE 到 8%',
        parentVersionId: active.version.id,
        gates,
        softRules: active.softRules.map((r: any) => ({ system: r.system, text: r.text, teach: r.teach })),
        positionRules: active.positionRules,
      });
    expect(created.status).toBe(201);
    expect(created.body.data.version.is_active).toBe(0);
    const draftId = created.body.data.version.id;

    const diff = await request(app)
      .get(`/api/rulebook/versions/${draftId}/diff`)
      .set(auth());
    expect(diff.status).toBe(200);
    const roeChange = diff.body.data.gates.changed.find((c: any) => c.gate_key === 'roe_ttm');
    expect(roeChange.to.threshold).toBe(8);

    const activate = await request(app).post(`/api/rulebook/versions/${draftId}/activate`).set(auth());
    expect(activate.status).toBe(200);

    const nowActive = await request(app).get('/api/rulebook/active').set(auth());
    expect(nowActive.body.data.version.id).toBe(draftId);
  });

  it('lists versions with exactly one active', async () => {
    const res = await request(app).get('/api/rulebook/versions').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data.filter((v: any) => v.is_active === 1).length).toBe(1);
  });

  it('404 for an unknown version', async () => {
    const res = await request(app).get('/api/rulebook/versions/nope').set(auth());
    expect(res.status).toBe(404);
  });
});
