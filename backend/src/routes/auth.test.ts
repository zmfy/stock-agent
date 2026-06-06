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
      .send({ username: 'nobody', password: 'secret123', inviteCode: 'bogus-code' });
    expect(res.status).toBe(422);
  });

  it('non-admin cannot mint invite codes', async () => {
    // there is no non-admin yet, so an unauthenticated call must be rejected
    const res = await request(app).post('/api/auth/invite');
    expect(res.status).toBe(401);
  });

  it('admin mints an invite code, then a new user registers with it', async () => {
    const login = await request(app).post('/api/auth/login').send(DEFAULT_ADMIN);
    const adminToken = login.body.data.accessToken;

    const minted = await request(app)
      .post('/api/auth/invite')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(minted.status).toBe(201);
    const code = minted.body.data.code;
    expect(code).toBeTruthy();

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'invitee', password: 'secret123', inviteCode: code });
    expect(reg.status).toBe(201);
    expect(reg.body.data.user.username).toBe('invitee');

    // the same code cannot be reused
    const reuse = await request(app)
      .post('/api/auth/register')
      .send({ username: 'invitee2', password: 'secret123', inviteCode: code });
    expect(reuse.status).toBe(422);
  });

  it('GET /api/auth/me works for the registered invitee', async () => {
    const login = await request(app).post('/api/auth/login').send(DEFAULT_ADMIN);
    const adminToken = login.body.data.accessToken;
    const minted = await request(app)
      .post('/api/auth/invite')
      .set('Authorization', `Bearer ${adminToken}`);
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'mona', password: 'secret123', inviteCode: minted.body.data.code });
    const token = reg.body.data.accessToken;
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.username).toBe('mona');
  });
});
