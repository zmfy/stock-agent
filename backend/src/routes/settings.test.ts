import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-settings-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

const DEFAULT_ADMIN = { username: 'stock-agent', password: 'sg123456' };

async function adminToken(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send(DEFAULT_ADMIN);
  return res.body.data.accessToken;
}

// Create a regular user via invite, return { id, token }.
async function createUser(username: string): Promise<{ id: string; token: string }> {
  const at = await adminToken();
  const invite = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${at}`);
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'secret123', inviteCode: invite.body.data.code , agreed: true });
  return { id: reg.body.data.user.id, token: reg.body.data.accessToken };
}

describe('settings/users (admin)', () => {
  it('admin lists users; the seeded admin is present', async () => {
    const at = await adminToken();
    const res = await request(app).get('/api/settings/users').set('Authorization', `Bearer ${at}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((u: { username: string }) => u.username === 'stock-agent')).toBe(true);
  });

  it('rejects unauthenticated access (401) and non-admin access (403)', async () => {
    const noAuth = await request(app).get('/api/settings/users');
    expect(noAuth.status).toBe(401);
    const { token } = await createUser('plainuser');
    const forbidden = await request(app).get('/api/settings/users').set('Authorization', `Bearer ${token}`);
    expect(forbidden.status).toBe(403);
  });

  it('mints and lists invite codes', async () => {
    const at = await adminToken();
    const minted = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${at}`);
    expect(minted.status).toBe(201);
    expect(minted.body.data.code).toBeTruthy();
    expect(minted.body.data.expiresAt).toBeTruthy();
    const list = await request(app).get('/api/settings/users/invites').set('Authorization', `Bearer ${at}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((c: { code: string }) => c.code === minted.body.data.code)).toBe(true);
  });

  it('admin changes a user role', async () => {
    const at = await adminToken();
    const { id } = await createUser('promoteme');
    const res = await request(app)
      .put(`/api/settings/users/${id}/role`)
      .set('Authorization', `Bearer ${at}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
  });

  it('admin cannot demote or delete themselves', async () => {
    const at = await adminToken();
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${at}`);
    const myId = me.body.data.id;
    const demote = await request(app)
      .put(`/api/settings/users/${myId}/role`)
      .set('Authorization', `Bearer ${at}`)
      .send({ role: 'user' });
    expect(demote.status).toBe(400);
    const del = await request(app).delete(`/api/settings/users/${myId}`).set('Authorization', `Bearer ${at}`);
    expect(del.status).toBe(400);
  });

  it('admin resets a user password (enforcing strong policy), and the user can log in with it', async () => {
    const at = await adminToken();
    const { id } = await createUser('resetme');
    const weak = await request(app)
      .put(`/api/settings/users/${id}/password`)
      .set('Authorization', `Bearer ${at}`)
      .send({ password: 'weak' });
    expect(weak.status).toBe(422);
    const strong = await request(app)
      .put(`/api/settings/users/${id}/password`)
      .set('Authorization', `Bearer ${at}`)
      .send({ password: 'Reset#1234' });
    expect(strong.status).toBe(200);
    const login = await request(app).post('/api/auth/login').send({ username: 'resetme', password: 'Reset#1234' , agreed: true });
    expect(login.status).toBe(200);
  });

  it('admin deletes a user', async () => {
    const at = await adminToken();
    const { id } = await createUser('deleteme');
    const res = await request(app).delete(`/api/settings/users/${id}`).set('Authorization', `Bearer ${at}`);
    expect(res.status).toBe(200);
    const list = await request(app).get('/api/settings/users').set('Authorization', `Bearer ${at}`);
    expect(list.body.data.some((u: { id: string }) => u.id === id)).toBe(false);
  });
});
