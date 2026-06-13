import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../account/service';

const router = Router();
router.use(authMiddleware);

// POST /api/account/backup { label? } — snapshot all of the user's data
router.post('/backup', (req: Request, res: Response) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : undefined;
  const b = svc.createBackup(req.user!.userId, label);
  successResponse(res, b, '已备份', 201);
});

// GET /api/account/backups
router.get('/backups', (req: Request, res: Response) => {
  successResponse(res, svc.listBackups(req.user!.userId));
});

// POST /api/account/backups/:id/restore
router.post('/backups/:id/restore', (req: Request, res: Response) => {
  const ok = svc.restoreBackup(req.user!.userId, req.params.id);
  if (!ok) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '备份不存在或已损坏');
  successResponse(res, null, '已从备份恢复');
});

// DELETE /api/account/backups/:id
router.delete('/backups/:id', (req: Request, res: Response) => {
  svc.deleteBackup(req.user!.userId, req.params.id);
  successResponse(res, null, '已删除备份');
});

// POST /api/account/reset { confirm: true } — auto-backup then wipe everything
router.post('/reset', (req: Request, res: Response) => {
  const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '需要确认 confirm=true');
  const out = svc.resetUser(req.user!.userId);
  successResponse(res, out, '已清空当前用户数据（已自动备份）');
});

// PUT /api/account/profile { nickname } — 改当前用户昵称(用户名不可改)
router.put('/profile', (req: Request, res: Response) => {
  const parsed = z.object({ nickname: z.string() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const nickname = parsed.data.nickname.trim();
  if (nickname.length > 30) return errorResponse(res, 422, 'VALIDATION_ERROR', '昵称不能超过 30 字');
  const user = svc.updateNickname(req.user!.userId, nickname);
  successResponse(res, user, '已保存');
});

export default router;
