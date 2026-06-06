import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware, generateTokens } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { strongPassword } from '../utils/validation';
import { JWT_SECRET } from '../secret';
import { User, JwtPayload } from '../types';

const router = Router();

// 登录防暴力破解：按「用户名+IP」记失败次数，连续失败达上限即锁定一段时间（返回 429）。
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 5;
const LOGIN_LOCK_MS = (Number(process.env.LOGIN_LOCK_MINUTES) || 15) * 60 * 1000;
const loginFails = new Map<string, { fails: number; lockedUntil: number }>();
const loginKey = (req: Request, username: string) => `${String(username || '').toLowerCase()}|${req.ip}`;

const loginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(100),
});

// 当前免责声明版本（内容变更时升级，便于追溯用户同意的是哪一版）
export const DISCLAIMER_VERSION = 'v1';

const registerSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100),
  nickname: z.string().max(30).optional(),
  inviteCode: z.string().optional(),
  agreed: z.boolean().optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post('/login', (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const { username, password } = parsed.data;

  // 锁定检查
  const key = loginKey(req, username);
  const now = Date.now();
  const rec = loginFails.get(key);
  if (rec && rec.lockedUntil > now) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000);
    res.set('Retry-After', String(secs));
    return errorResponse(res, 429, 'RATE_LIMIT', `登录失败次数过多，请 ${Math.ceil(secs / 60)} 分钟后再试`);
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const r = loginFails.get(key) || { fails: 0, lockedUntil: 0 };
    r.fails += 1;
    if (r.fails >= LOGIN_MAX_FAILS) {
      r.lockedUntil = now + LOGIN_LOCK_MS;
      r.fails = 0;
    }
    loginFails.set(key, r);
    const left = Math.max(0, LOGIN_MAX_FAILS - r.fails);
    return errorResponse(res, 401, 'AUTH_UNAUTHORIZED', `用户名或密码错误${r.lockedUntil > now ? '，已临时锁定' : left <= 2 ? `（再错 ${left} 次将锁定）` : ''}`);
  }
  loginFails.delete(key); // 成功即清零
  const tokens = generateTokens(user.id, user.role);
  successResponse(res, { user: { id: user.id, username: user.username, role: user.role, nickname: (user as any).nickname ?? null }, ...tokens }, '登录成功');
});

router.post('/register', (req: Request, res: Response) => {
  const db = getDb();
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'registration_mode'").get() as
    | { value: string }
    | undefined;
  const registrationMode = setting?.value || 'open';

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const { username, password, nickname, inviteCode, agreed } = parsed.data;

  // 必须勾选同意免责声明才允许注册
  if (agreed !== true) return errorResponse(res, 422, 'VALIDATION_ERROR', '请先阅读并同意《免责声明》后再注册');

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
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, nickname, agreed_at, disclaimer_version) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)'
  ).run(userId, username, hash, 'user', nickname || null, DISCLAIMER_VERSION);
  if (registrationMode === 'invite' && inviteCode) {
    db.prepare('UPDATE invite_codes SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE code = ?').run(
      userId,
      inviteCode
    );
  }
  const tokens = generateTokens(userId, 'user');
  successResponse(res, { user: { id: userId, username, role: 'user', nickname: nickname || null }, ...tokens }, '注册成功', 201);
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

// PUT /api/auth/password — logged-in user changes their OWN password (verifies current).
router.put('/password', authMiddleware, (req: Request, res: Response) => {
  const schema = z.object({ currentPassword: z.string().min(1), newPassword: strongPassword });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(res, 422, 'VALIDATION_ERROR', parsed.error.errors[0]?.message || '参数校验失败');
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.userId) as User | undefined;
  if (!user) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '用户不存在');
  if (!bcrypt.compareSync(parsed.data.currentPassword, user.password_hash)) {
    return errorResponse(res, 401, 'AUTH_UNAUTHORIZED', '当前密码错误');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(parsed.data.newPassword, 10),
    user.id
  );
  successResponse(res, null, '密码已修改');
});

router.get('/me', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const user = db
    .prepare('SELECT id, username, role, nickname, created_at FROM users WHERE id = ?')
    .get(req.user!.userId) as Omit<User, 'password_hash'> | undefined;
  if (!user) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '用户不存在');
  successResponse(res, user);
});

export default router;
