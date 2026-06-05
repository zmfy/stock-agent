import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

// Set DATA_DIR to a fresh temp dir BEFORE requiring the app, so db.ts (which reads
// DATA_DIR at module load) opens an isolated throwaway database for this run.
// NOTE: must use require() (not a hoisted top-level import) so it runs AFTER this assignment.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-auth-'));
process.env.REGISTRATION_MODE = 'open';

const { createApp } = require('../index');
const app = createApp();

describe('auth routes', () => {
  it('registers a new user and returns tokens', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'alice', password: 'secret123' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.username).toBe('alice');
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
  });

  it('rejects duplicate username', async () => {
    await request(app).post('/api/auth/register').send({ username: 'bob', password: 'secret123' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'bob', password: 'secret123' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BUSINESS_CONFLICT');
  });

  it('logs in with correct credentials and rejects wrong password', async () => {
    await request(app).post('/api/auth/register').send({ username: 'carol', password: 'secret123' });
    const ok = await request(app).post('/api/auth/login').send({ username: 'carol', password: 'secret123' });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ username: 'carol', password: 'wrong' });
    expect(bad.status).toBe(401);
  });

  it('GET /api/auth/me returns the user for a valid token', async () => {
    const reg = await request(app).post('/api/auth/register').send({ username: 'dave', password: 'secret123' });
    const token = reg.body.data.accessToken;
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.username).toBe('dave');
  });

  it('POST /api/auth/refresh issues a fresh access token', async () => {
    const reg = await request(app).post('/api/auth/register').send({ username: 'erin', password: 'secret123' });
    const refreshToken = reg.body.data.refreshToken;
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
  });
});
