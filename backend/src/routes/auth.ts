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
