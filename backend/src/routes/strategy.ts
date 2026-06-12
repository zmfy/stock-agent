import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../strategy/service';

const router = Router();
router.use(authMiddleware);

router.get('/schedule', (req: Request, res: Response) => {
  successResponse(res, { config: svc.getScheduleConfig(req.user!.userId) });
});

const schema = z.object({
  prejudgeTime: z.string().optional(),
  intradayInterval: z.number().int().optional(),
  reviewTime: z.string().optional(),
  holidayBriefTime: z.string().optional(),
});

router.put('/schedule', (req: Request, res: Response) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    const config = svc.setScheduleConfig(req.user!.userId, parsed.data);
    successResponse(res, { config }, '已保存');
  } catch (e: any) {
    if (e.message === 'INVALID_SCHEDULE') return errorResponse(res, 422, 'VALIDATION_ERROR', '时间或盘中间隔不合法(间隔仅 30/60/120/0)');
    throw e;
  }
});

export default router;
