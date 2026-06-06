import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

// Set DATA_DIR to a fresh temp dir BEFORE requiring the app, so db.ts (which reads
// DATA_DIR at module load) opens an isolated throwaway database for this run.
// NOTE: must use require() (not a hoisted top-level import) so it runs AFTER this assignment.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-auth-'));
delete process.env.REGISTRATION_MODE; // exercise the invite-only default

const { createApp } = require('../index');
const app = createApp();

const DEFAULT_ADMIN = { username: 'stock-agent', password: 'sg123456' };

async function adminToken(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send(DEFAULT_ADMIN);
  return res.body.data.accessToken;
}

async function mintInvite(): Promise<string> {
  const token = await adminToken();
  const res = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${token}`);
  return res.body.data.code;
}

describe('auth routes (invite-only)', () => {
  it('the seeded default admin can log in', async () => {
    const res = await request(app).post('/api/auth/login').send(DEFAULT_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('admin');
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('rejects self-registration without an invite code', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'nobody', password: 'secret123' });
    expect(res.status).toBe(422);
  });

  it('rejects an invalid invite code', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'nobody', password: 'secret123', inviteCode: 'BOGUSCODE' });
    expect(res.status).toBe(422);
  });

  it('registers with a valid invite code, then the code cannot be reused', async () => {
    const code = await mintInvite();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'invitee', password: 'secret123', inviteCode: code });
    expect(reg.status).toBe(201);
    expect(reg.body.data.user.username).toBe('invitee');

    const reuse = await request(app)
      .post('/api/auth/register')
      .send({ username: 'invitee2', password: 'secret123', inviteCode: code });
    expect(reuse.status).toBe(422);
  });

  it('GET /api/auth/me works for the registered invitee', async () => {
    const code = await mintInvite();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'mona', password: 'secret123', inviteCode: code });
    const token = reg.body.data.accessToken;
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.username).toBe('mona');
  });

  it('POST /api/auth/refresh issues a fresh access token', async () => {
    const login = await request(app).post('/api/auth/login').send(DEFAULT_ADMIN);
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: login.body.data.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });

  describe('PUT /api/auth/password (self change)', () => {
    it('rejects a weak new password', async () => {
      const code = await mintInvite();
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ username: 'weakpwd', password: 'secret123', inviteCode: code });
      const token = reg.body.data.accessToken;
      const res = await request(app)
        .put('/api/auth/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'secret123', newPassword: 'short' });
      expect(res.status).toBe(422);
    });

    it('rejects a wrong current password', async () => {
      const code = await mintInvite();
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ username: 'wrongcur', password: 'secret123', inviteCode: code });
      const token = reg.body.data.accessToken;
      const res = await request(app)
        .put('/api/auth/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'WRONG', newPassword: 'NewPass#123' });
      expect(res.status).toBe(401);
    });

    it('changes the password, then login works with the new one only', async () => {
      const code = await mintInvite();
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ username: 'changer', password: 'secret123', inviteCode: code });
      const token = reg.body.data.accessToken;
      const change = await request(app)
        .put('/api/auth/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'secret123', newPassword: 'NewPass#123' });
      expect(change.status).toBe(200);

      const oldLogin = await request(app).post('/api/auth/login').send({ username: 'changer', password: 'secret123' });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(app).post('/api/auth/login').send({ username: 'changer', password: 'NewPass#123' });
      expect(newLogin.status).toBe(200);
    });
  });
});
