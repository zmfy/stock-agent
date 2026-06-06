import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../meetings/service';

const router = Router();
router.use(authMiddleware);

// GET /api/meetings/today — today's morning + evening meeting (null if not generated)
router.get('/today', (req: Request, res: Response) => {
  successResponse(res, svc.getToday(req.user!.userId));
});

// POST /api/meetings/generate { kind } — manually run a meeting now
router.post('/generate', async (req: Request, res: Response) => {
  const parsed = z.object({ kind: z.enum(['morning', 'evening']) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    const m = parsed.data.kind === 'morning' ? await svc.generateMorning(req.user!.userId) : await svc.generateEvening(req.user!.userId);
    successResponse(res, m, '已生成', 201);
  } catch (e: any) {
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `生成失败：${e.message || '未知错误'}`);
  }
});

export default router;
