# 股票小作手 Foundation Implementation Plan (Plan 1 of phase-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a working multi-user web app skeleton (Vue 3 + Express + TypeScript + SQLite) with JWT auth, mirroring the proven easy-Reader conventions, so later plans (rulebook, data layer, analysis engine) have a foundation to build on.

**Architecture:** Single Express server serves the REST API (`/api/*`) and the built Vue SPA (`./public`). `better-sqlite3` holds all data; schema created idempotently at startup. JWT auth = Access token (30min) + Refresh token (30d). All API responses use `{ success, code, message, data, meta }`. Frontend is Vite + Vue 3 + Pinia with an axios client that auto-refreshes expired access tokens.

**Tech Stack:** Node + Express + TypeScript, better-sqlite3, jsonwebtoken, bcryptjs, zod, uuid, jest + ts-jest + supertest (backend tests); Vue 3 + Vite + Pinia + vue-router + axios (frontend).

**Conventions copied from `~/projects/easy-Reader/backend`:** `getDb()` singleton, `successResponse`/`errorResponse` helpers, `secret.ts` auto-generates JWT secret to `data/.jwt_secret`, zod `safeParse` validation, bcrypt hashing, uuid v4 ids.

**Working directory:** `~/projects/stock-agent` (already git-inited).

---

### Task 1: Backend scaffold + config

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/jest.config.js`
- Create: `backend/.env.example`
- Create: `backend/src/index.ts` (placeholder, fleshed out in Task 5)

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "stock-agent-backend",
  "version": "0.1.0",
  "description": "股票小作手 backend",
  "main": "dist/index.js",
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "jest"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^9.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.2.0",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2",
    "uuid": "^9.0.1",
    "zod": "^3.23.4"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/better-sqlite3": "^7.6.10",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.12",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "@types/uuid": "^9.0.8",
    "jest": "^29.7.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.1.4",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Create `backend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020", "DOM"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create `backend/jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  // Each test file gets its own throwaway DB via DATA_DIR (set in tests)
};
```

- [ ] **Step 4: Create `backend/.env.example`**

```
PORT=3000
DATA_DIR=./data
JWT_SECRET=change-this-to-a-secure-random-string
FRONTEND_URL=http://localhost:5173
REGISTRATION_MODE=open
```

- [ ] **Step 5: Create placeholder `backend/src/index.ts`**

```ts
// Fleshed out in Task 5.
export {};
```

- [ ] **Step 6: Install dependencies**

Run: `cd ~/projects/stock-agent/backend && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/stock-agent
git add backend/package.json backend/tsconfig.json backend/jest.config.js backend/.env.example backend/src/index.ts
git commit -m "chore: backend scaffold (express + ts + jest config)"
```

---

### Task 2: Shared types + response helpers + secret

**Files:**
- Create: `backend/src/types/index.ts`
- Create: `backend/src/utils/response.ts`
- Create: `backend/src/secret.ts`

- [ ] **Step 1: Create `backend/src/types/index.ts`**

```ts
export interface ApiResponse<T = unknown> {
  success: boolean;
  code: string;
  message?: string;
  data?: T;
  meta?: { requestId: string; timestamp: string };
}

export interface JwtPayload {
  userId: string;
  role: 'admin' | 'user';
}

export interface User {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: string;
}

// Express request augmentation so req.user is typed everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
```

- [ ] **Step 2: Create `backend/src/utils/response.ts`**

```ts
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ApiResponse } from '../types';

export function successResponse<T>(res: Response, data: T, message = '操作成功', statusCode = 200): void {
  const response: ApiResponse<T> = {
    success: true,
    code: 'OK',
    message,
    data,
    meta: { requestId: uuidv4(), timestamp: new Date().toISOString() },
  };
  res.status(statusCode).json(response);
}

export function errorResponse(res: Response, statusCode: number, code: string, message: string): void {
  const response: ApiResponse = {
    success: false,
    code,
    message,
    meta: { requestId: uuidv4(), timestamp: new Date().toISOString() },
  };
  res.status(statusCode).json(response);
}
```

- [ ] **Step 3: Create `backend/src/secret.ts`**

```ts
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');
const PLACEHOLDER = 'change-this-to-a-secure-random-string';

function loadOrGenerateSecret(): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET !== PLACEHOLDER) {
    return process.env.JWT_SECRET;
  }
  if (fs.existsSync(SECRET_FILE)) {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  console.log('[auth] JWT_SECRET not set — generated and saved to', SECRET_FILE);
  return secret;
}

export const JWT_SECRET = loadOrGenerateSecret();
```

- [ ] **Step 4: Typecheck**

Run: `cd ~/projects/stock-agent/backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/stock-agent
git add backend/src/types/index.ts backend/src/utils/response.ts backend/src/secret.ts
git commit -m "feat: shared types, response helpers, jwt secret loader"
```

---

### Task 3: Database init (users / invite_codes / settings)

**Files:**
- Create: `backend/src/db.ts`
- Test: `backend/src/db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/db.test.ts
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('getDb', () => {
  beforeAll(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-db-'));
  });

  it('creates the users, invite_codes and settings tables', () => {
    const { getDb } = require('./db');
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'invite_codes', 'settings']));
  });

  it('returns the same singleton instance', () => {
    const { getDb } = require('./db');
    expect(getDb()).toBe(getDb());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/stock-agent/backend && npx jest src/db.test.ts`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 3: Create `backend/src/db.ts`**

```ts
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'stock-agent.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT,
      used_by TEXT,
      used_at DATETIME,
      expires_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed registration mode from env (open | invite). Default open for a fresh single-user install.
  const mode = process.env.REGISTRATION_MODE === 'invite' ? 'invite' : 'open';
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('registration_mode', ?)
     ON CONFLICT(key) DO NOTHING`
  ).run(mode);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/stock-agent/backend && npx jest src/db.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/stock-agent
git add backend/src/db.ts backend/src/db.test.ts
git commit -m "feat: sqlite init with users/invite_codes/settings tables"
```

---

### Task 4: Auth middleware + token generation

**Files:**
- Create: `backend/src/middleware/auth.ts`
- Test: `backend/src/middleware/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/middleware/auth.test.ts
import { generateTokens, authMiddleware } from './auth';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../secret';

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('auth middleware', () => {
  it('generateTokens issues a 30min access and 30d refresh token', () => {
    const { accessToken, refreshToken } = generateTokens('u1', 'user');
    const a = jwt.verify(accessToken, JWT_SECRET) as any;
    const r = jwt.verify(refreshToken, JWT_SECRET) as any;
    expect(a.userId).toBe('u1');
    expect(a.role).toBe('user');
    expect(a.exp - a.iat).toBe(30 * 60); // 30 minutes
    expect(r.exp - r.iat).toBe(30 * 24 * 60 * 60); // 30 days
  });

  it('authMiddleware rejects a request with no token', () => {
    const req: any = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('authMiddleware accepts a valid token and populates req.user', () => {
    const { accessToken } = generateTokens('u2', 'admin');
    const req: any = { headers: { authorization: `Bearer ${accessToken}` } };
    const res = mockRes();
    const next = jest.fn();
    authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.userId).toBe('u2');
    expect(req.user.role).toBe('admin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/stock-agent/backend && npx jest src/middleware/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Create `backend/src/middleware/auth.ts`**

```ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { errorResponse } from '../utils/response';
import { JwtPayload } from '../types';
import { JWT_SECRET } from '../secret';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    errorResponse(res, 401, 'AUTH_UNAUTHORIZED', '未提供认证令牌');
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    errorResponse(res, 401, 'AUTH_UNAUTHORIZED', '令牌无效或已过期');
  }
}

export function generateTokens(
  userId: string,
  role: 'admin' | 'user'
): { accessToken: string; refreshToken: string } {
  const payload: JwtPayload = { userId, role };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '30m' });
  const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  return { accessToken, refreshToken };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/stock-agent/backend && npx jest src/middleware/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/stock-agent
git add backend/src/middleware/auth.ts backend/src/middleware/auth.test.ts
git commit -m "feat: jwt auth middleware + token generation (30m/30d)"
```

---

### Task 5: Auth routes + Express app

**Files:**
- Create: `backend/src/routes/auth.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/routes/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/routes/auth.test.ts
import path from 'path';
import os from 'os';
import fs from 'fs';

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-auth-'));
  process.env.REGISTRATION_MODE = 'open';
});

import request from 'supertest';

function makeApp() {
  // Imported lazily so DATA_DIR env is set before db.ts runs.
  const { createApp } = require('../index');
  return createApp();
}

describe('auth routes', () => {
  const app = makeApp();

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/stock-agent/backend && npx jest src/routes/auth.test.ts`
Expected: FAIL — `createApp` not exported / route module missing.

- [ ] **Step 3: Create `backend/src/routes/auth.ts`**

```ts
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware, generateTokens } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { JWT_SECRET } from '../secret';
import { User, JwtPayload } from '../types';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(100),
});

const registerSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100),
  inviteCode: z.string().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post('/login', (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const { username, password } = parsed.data;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return errorResponse(res, 401, 'AUTH_UNAUTHORIZED', '用户名或密码错误');
  }
  const tokens = generateTokens(user.id, user.role);
  successResponse(res, { user: { id: user.id, username: user.username, role: user.role }, ...tokens }, '登录成功');
});

router.post('/register', (req: Request, res: Response) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'registration_mode'").get() as
    | { value: string }
    | undefined;
  const registrationMode = setting?.value || 'open';

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const { username, password, inviteCode } = parsed.data;

  if (registrationMode === 'invite') {
    if (!inviteCode) return errorResponse(res, 422, 'VALIDATION_ERROR', '需要邀请码');
    const code = db
      .prepare('SELECT * FROM invite_codes WHERE code = ? AND used_by IS NULL')
      .get(inviteCode) as { code: string; expires_at?: string } | undefined;
    if (!code) return errorResponse(res, 422, 'VALIDATION_ERROR', '邀请码无效或已使用');
    if (code.expires_at && new Date(code.expires_at) < new Date()) {
      return errorResponse(res, 422, 'VALIDATION_ERROR', '邀请码已过期');
    }
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return errorResponse(res, 409, 'BUSINESS_CONFLICT', '用户名已存在');

  const userId = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    userId,
    username,
    hash,
    'user'
  );
  if (registrationMode === 'invite' && inviteCode) {
    db.prepare('UPDATE invite_codes SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE code = ?').run(
      userId,
      inviteCode
    );
  }
  const tokens = generateTokens(userId, 'user');
  successResponse(res, { user: { id: userId, username, role: 'user' }, ...tokens }, '注册成功', 201);
});

router.post('/refresh', (req: Request, res: Response) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    const payload = jwt.verify(parsed.data.refreshToken, JWT_SECRET) as JwtPayload;
    const tokens = generateTokens(payload.userId, payload.role);
    successResponse(res, tokens, '刷新成功');
  } catch {
    errorResponse(res, 401, 'AUTH_UNAUTHORIZED', '刷新令牌无效或已过期');
  }
});

router.post('/logout', authMiddleware, (_req: Request, res: Response) => {
  successResponse(res, null, '已登出');
});

router.get('/me', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const user = db
    .prepare('SELECT id, username, role, created_at FROM users WHERE id = ?')
    .get(req.user!.userId) as Omit<User, 'password_hash'> | undefined;
  if (!user) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '用户不存在');
  successResponse(res, user);
});

export default router;
```

- [ ] **Step 4: Replace `backend/src/index.ts` with the real app**

```ts
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { getDb } from './db';
import authRoutes from './routes/auth';

export function createApp(): express.Express {
  const app = express();

  // Ensure DB is initialized.
  getDb();

  app.use(helmet({ contentSecurityPolicy: false }));
  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl) {
    app.use(cors({ origin: frontendUrl, credentials: true }));
  }

  const publicDir = path.join(__dirname, '../public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: { success: false, code: 'RATE_LIMIT', message: '请求过于频繁，请稍后再试' },
  });

  app.use('/api/auth', authLimiter, authRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/*', (_req, res) => {
    res.status(404).json({ success: false, code: 'RESOURCE_NOT_FOUND', message: '接口不存在' });
  });

  app.get('*', (_req, res) => {
    const indexPath = path.join(__dirname, '../public/index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).json({ success: false, code: 'NOT_FOUND', message: '前端尚未构建' });
  });

  return app;
}

// Only start a listener when run directly (not when imported by tests).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  createApp().listen(PORT, () => console.log(`[stock-agent] backend listening on :${PORT}`));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/projects/stock-agent/backend && npx jest src/routes/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full backend test suite**

Run: `cd ~/projects/stock-agent/backend && npm test`
Expected: PASS — all suites (db, middleware, routes) green.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/stock-agent
git add backend/src/routes/auth.ts backend/src/index.ts backend/src/routes/auth.test.ts
git commit -m "feat: auth routes (register/login/refresh/me/logout) + express app"
```

---

### Task 6: Frontend scaffold (Vue 3 + Vite + Pinia + router)

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.ts`
- Create: `frontend/src/App.vue`
- Create: `frontend/src/router/index.ts`

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "stock-agent-frontend",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "axios": "^1.7.2",
    "pinia": "^2.1.7",
    "vue": "^3.4.27",
    "vue-router": "^4.3.2"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.4",
    "typescript": "^5.4.5",
    "vite": "^5.2.11",
    "vue-tsc": "^2.0.19"
  }
}
```

- [ ] **Step 2: Create `frontend/vite.config.ts`** (proxy `/api` → backend; build into backend `public`)

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  build: { outDir: path.resolve(__dirname, '../backend/public'), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
```

- [ ] **Step 3: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue"]
}
```

- [ ] **Step 4: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>股票小作手</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `frontend/src/main.ts`**

```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';

createApp(App).use(createPinia()).use(router).mount('#app');
```

- [ ] **Step 6: Create `frontend/src/App.vue`**

```vue
<template>
  <router-view />
</template>
```

- [ ] **Step 7: Create `frontend/src/router/index.ts`** (route guard added in Task 8)

```ts
import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
  { path: '/', name: 'home', component: () => import('../views/HomeView.vue'), meta: { requiresAuth: true } },
];

const router = createRouter({ history: createWebHistory(), routes });
export default router;
```

- [ ] **Step 8: Install dependencies**

Run: `cd ~/projects/stock-agent/frontend && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 9: Commit**

```bash
cd ~/projects/stock-agent
git add frontend/package.json frontend/vite.config.ts frontend/tsconfig.json frontend/index.html frontend/src/main.ts frontend/src/App.vue frontend/src/router/index.ts
git commit -m "chore: frontend scaffold (vue3 + vite + pinia + router)"
```

---

### Task 7: API client + auth store

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/stores/auth.ts`

- [ ] **Step 1: Create `frontend/src/api/client.ts`** (axios with auto access-token refresh)

```ts
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshing: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) return null;
  try {
    const res = await axios.post('/api/auth/refresh', { refreshToken });
    const next = res.data.data.accessToken as string;
    localStorage.setItem('accessToken', next);
    return next;
  } catch {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    return null;
  }
}

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      refreshing = refreshing || tryRefresh();
      const next = await refreshing;
      refreshing = null;
      if (next) {
        original.headers.Authorization = `Bearer ${next}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  }
);

export default api;
```

- [ ] **Step 2: Create `frontend/src/stores/auth.ts`**

```ts
import { defineStore } from 'pinia';
import api from '../api/client';

interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    accessToken: localStorage.getItem('accessToken'),
  }),
  getters: {
    isAuthenticated: (s) => !!s.accessToken,
  },
  actions: {
    persist(accessToken: string, refreshToken: string, user: AuthUser) {
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
      this.accessToken = accessToken;
      this.user = user;
    },
    async login(username: string, password: string) {
      const res = await api.post('/auth/login', { username, password });
      const { accessToken, refreshToken, user } = res.data.data;
      this.persist(accessToken, refreshToken, user);
    },
    async register(username: string, password: string, inviteCode?: string) {
      const res = await api.post('/auth/register', { username, password, inviteCode });
      const { accessToken, refreshToken, user } = res.data.data;
      this.persist(accessToken, refreshToken, user);
    },
    async fetchMe() {
      const res = await api.get('/auth/me');
      this.user = res.data.data;
    },
    logout() {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      this.accessToken = null;
      this.user = null;
    },
  },
});
```

- [ ] **Step 3: Typecheck**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: no errors (views referenced by router are added in Task 8 — if vue-tsc errors on missing views, proceed; they are created next task. To keep this step green, run it after Task 8 instead.)

- [ ] **Step 4: Commit**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/client.ts frontend/src/stores/auth.ts
git commit -m "feat: axios client with token refresh + pinia auth store"
```

---

### Task 8: Login/Home views + route guard

**Files:**
- Create: `frontend/src/views/LoginView.vue`
- Create: `frontend/src/views/HomeView.vue`
- Modify: `frontend/src/router/index.ts`

- [ ] **Step 1: Create `frontend/src/views/LoginView.vue`**

```vue
<template>
  <div class="login">
    <h1>股票小作手</h1>
    <form @submit.prevent="submit">
      <input v-model="username" placeholder="用户名" autocomplete="username" />
      <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
      <input v-if="mode === 'register'" v-model="inviteCode" placeholder="邀请码（如需要）" />
      <button type="submit">{{ mode === 'login' ? '登录' : '注册' }}</button>
      <p class="err" v-if="error">{{ error }}</p>
      <a href="#" @click.prevent="toggle">{{ mode === 'login' ? '没有账号？注册' : '已有账号？登录' }}</a>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const inviteCode = ref('');
const error = ref('');

function toggle() {
  mode.value = mode.value === 'login' ? 'register' : 'login';
  error.value = '';
}

async function submit() {
  error.value = '';
  try {
    if (mode.value === 'login') await auth.login(username.value, password.value);
    else await auth.register(username.value, password.value, inviteCode.value || undefined);
    router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.message || '操作失败';
  }
}
</script>

<style scoped>
.login { max-width: 320px; margin: 80px auto; display: flex; flex-direction: column; }
form { display: flex; flex-direction: column; gap: 8px; }
.err { color: #c00; }
</style>
```

- [ ] **Step 2: Create `frontend/src/views/HomeView.vue`**

```vue
<template>
  <div class="home">
    <h1>股票小作手</h1>
    <p v-if="auth.user">欢迎，{{ auth.user.username }}（{{ auth.user.role }}）</p>
    <button @click="logout">登出</button>
    <p class="hint">规则管理、选股分析等功能将在后续计划中加入。</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

onMounted(() => {
  if (!auth.user) auth.fetchMe().catch(() => {});
});

function logout() {
  auth.logout();
  router.push('/login');
}
</script>

<style scoped>
.home { max-width: 640px; margin: 40px auto; }
.hint { color: #888; }
</style>
```

- [ ] **Step 3: Add the route guard in `frontend/src/router/index.ts`**

Append before `export default router;`:

```ts
router.beforeEach((to) => {
  const token = localStorage.getItem('accessToken');
  if (to.meta.requiresAuth && !token) return { name: 'login' };
  if (to.name === 'login' && token) return { name: 'home' };
  return true;
});
```

- [ ] **Step 4: Typecheck the frontend**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke test (both servers running)**

Run backend: `cd ~/projects/stock-agent/backend && npm run dev`
Run frontend: `cd ~/projects/stock-agent/frontend && npm run dev`
Open `http://localhost:5173` → register a user → land on Home showing the username → reload → still logged in → logout → back to login.
Expected: all steps work; no console errors.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/LoginView.vue frontend/src/views/HomeView.vue frontend/src/router/index.ts
git commit -m "feat: login/home views + auth route guard"
```

---

### Task 9: Docker + compose + README

**Files:**
- Create: `backend/Dockerfile`
- Create: `docker-compose.yml`
- Modify: `README.md`

- [ ] **Step 1: Create `backend/Dockerfile`** (multi-stage: build frontend, build backend, serve together)

```dockerfile
# ---- build frontend ----
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build   # outputs to /app/backend/public

# ---- build backend ----
FROM node:20-slim AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
COPY --from=frontend /app/backend/public ./public
RUN npm run build

# ---- runtime ----
FROM node:20-slim
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=backend /app/backend/dist ./dist
COPY --from=backend /app/backend/public ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  app:
    build:
      context: .
      dockerfile: backend/Dockerfile
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - DATA_DIR=/app/backend/data
      - REGISTRATION_MODE=open
    volumes:
      - stock_agent_data:/app/backend/data

volumes:
  stock_agent_data:
```

> Note: the frontend build expects `outDir: ../backend/public`. In the Docker `frontend` stage the backend dir doesn't exist yet, so the build writes to `/app/backend/public` inside that stage and is copied across — paths align because both stages root at `/app`.

- [ ] **Step 3: Update `README.md`**

```markdown
# 股票小作手 (stock-agent)

按用户的 A/B 双系统操盘规则分析 A 股、产出可审计可归因带教学的结构化报告。

## 本地开发
```bash
# 后端 (port 3000)
cd backend && npm install && npm run dev
# 前端 (port 5173, 代理 /api → :3000)
cd frontend && npm install && npm run dev
```

## Docker
```bash
docker compose up -d --build
# 访问 http://localhost:3000
```

## 文档
- 设计：`docs/superpowers/specs/2026-06-05-stock-agent-core-loop-design.md`
- 计划：`docs/superpowers/plans/`
```

- [ ] **Step 4: Build the image to verify it compiles end-to-end**

Run: `cd ~/projects/stock-agent && docker compose build`
Expected: image builds with no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/stock-agent
git add backend/Dockerfile docker-compose.yml README.md
git commit -m "chore: dockerfile + compose + readme (single-container deploy)"
```

---

## Done criteria for Plan 1

- `npm test` in `backend/` passes (db, auth middleware, auth routes).
- `npm run dev` in both `backend/` and `frontend/` runs; register → login → me → refresh → logout works end-to-end in the browser.
- `docker compose build` succeeds.
- Next: **Plan 2 — Rulebook versioning + V3.0 baseline import**.
