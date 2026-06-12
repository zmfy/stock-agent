import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../strategy/service';
import { generatePrejudge, generateIntraday, generateReview, generateHoliday } from '../strategy/generate';
import { isTradingDay } from '../data/trade-calendar';

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

// GET /api/strategy/history — 策略历史(倒序)
router.get('/history', (req: Request, res: Response) => {
  successResponse(res, svc.listStrategyHistory(req.user!.userId));
});

// GET /api/strategy/today — 当天策略房间渲染数据(按北京时段)
router.get('/today', (req: Request, res: Response) => {
  const uid = req.user!.userId;
  const now = Date.now();
  const date = svc.beijingDate(now);
  const trading = isTradingDay(date);
  const pick = (p: 'prejudge' | 'review' | 'holiday') => {
    const r = svc.getStrategy(uid, date, p) as any;
    return r ? { content: r.content, updatedAt: r.updated_at ?? r.created_at } : null;
  };
  successResponse(res, {
    date,
    isTradingDay: trading,
    phase: svc.dailyPhase(now, trading),
    prejudge: pick('prejudge'),
    review: pick('review'),
    holiday: pick('holiday'),
    intraday: (svc.getIntradayTimeline(uid, date) as any[]).map((x) => ({ content: x.content, createdAt: x.created_at })),
  });
});

const GEN_PHASES: Record<string, (uid: string) => Promise<string>> = {
  prejudge: generatePrejudge,
  intraday: generateIntraday,
  review: generateReview,
  holiday: generateHoliday,
};

// POST /api/strategy/generate/:phase — 手动生成某 phase(限流由 index.ts 在 /generate 子路径挂载)
router.post('/generate/:phase', async (req: Request, res: Response) => {
  const fn = GEN_PHASES[req.params.phase];
  if (!fn) return errorResponse(res, 422, 'VALIDATION_ERROR', '未知阶段');
  try {
    const content = await fn(req.user!.userId);
    successResponse(res, { content }, '已生成');
  } catch (e: any) {
    return errorResponse(res, 502, 'UPSTREAM_ERROR', e?.message || '生成失败');
  }
});

export default router;
