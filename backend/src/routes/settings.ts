import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { strongPassword } from '../utils/validation';
import { User } from '../types';

const router = Router();

// GET /api/settings/users — list all users (admin)
router.get('/users', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  const db = getDb();
  const users = db
    .prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC')
    .all() as Omit<User, 'password_hash'>[];
  successResponse(res, users);
});

// POST /api/settings/users/invite — mint an invite code (admin), 8-char, 7-day expiry
router.post('/users/invite', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const code = Math.random().toString(36).slice(2, 10).toUpperCase();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invite_codes (code, created_by, expires_at) VALUES (?, ?, ?)').run(
    code,
    req.user!.userId,
    expiresAt
  );
  successResponse(res, { code, expiresAt }, '邀请码已生成', 201);
});

// GET /api/settings/users/invites — list invite codes (admin), unused first
router.get('/users/invites', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  const db = getDb();
  const codes = db
    .prepare(
      'SELECT code, created_by, used_by, used_at, expires_at FROM invite_codes ORDER BY used_by IS NOT NULL, expires_at DESC'
    )
    .all();
  successResponse(res, codes);
});

// PUT /api/settings/users/:id/role — change a user's role (admin)
router.put('/users/:id/role', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const schema = z.object({ role: z.enum(['admin', 'user']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  // Prevent demoting yourself — avoids locking the last admin out.
  if (req.user!.userId === req.params.id && parsed.data.role !== 'admin') {
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', '不能降级自己的管理员权限');
  }
  const db = getDb();
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(parsed.data.role, req.params.id);
  if (result.changes === 0) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '用户不存在');
  successResponse(res, null, '角色已更新');
});

// PUT /api/settings/users/:id/password — admin resets a user's password (strong policy)
router.put('/users/:id/password', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  const schema = z.object({ password: strongPassword });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(res, 422, 'VALIDATION_ERROR', parsed.error.errors[0]?.message || '密码格式不符合要求');
  }
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '用户不存在');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(parsed.data.password, 10),
    req.params.id
  );
  successResponse(res, null, '密码已修改');
});

// DELETE /api/settings/users/:id — delete a user (admin), cannot delete self
router.delete('/users/:id', authMiddleware, adminMiddleware, (req: Request, res: Response) => {
  if (req.user!.userId === req.params.id) {
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', '不能删除自己的账号');
  }
  const db = getDb();
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '用户不存在');
  successResponse(res, null, '用户已删除');
});

export default router;
