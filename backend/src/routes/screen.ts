import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../screen/service';

const router = Router();
router.use(authMiddleware);

// POST /api/screen/run { codes?, top? } — screen the hot-sector universe by the rulebook
router.post('/run', async (req: Request, res: Response) => {
  const parsed = z.object({ codes: z.array(z.string()).optional(), top: z.number().int().min(1).max(20).optional() }).safeParse(req.body || {});
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    const out = await svc.runScreen(req.user!.userId, parsed.data);
    successResponse(res, out, '选股完成', 201);
  } catch (e: any) {
    if (e.message === 'NO_RULEBOOK') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「核心规则」导入或设定规则版本');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `选股失败：${e.message || '未知错误'}`);
  }
});

// GET /api/screen/latest
router.get('/latest', (req: Request, res: Response) => {
  successResponse(res, svc.getLatest(req.user!.userId));
});

// GET /api/screen/history?limit=20
router.get('/history', (req: Request, res: Response) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  successResponse(res, svc.getHistory(req.user!.userId, limit));
});

export default router;
