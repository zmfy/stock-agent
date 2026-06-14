import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { listCronJobs, applyCronChange, runCronNow, CRON_JOBS } from '../cron/registry';
import { getJobLog } from '../data/service';

const router = Router();
router.use(authMiddleware, adminMiddleware);

router.get('/', (_req: Request, res: Response) => successResponse(res, listCronJobs()));

router.put('/:key', (req: Request, res: Response) => {
  const parsed = z.object({ time: z.string().optional(), enabled: z.boolean().optional(), expr: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    applyCronChange(req.params.key, parsed.data);
    const job = listCronJobs().jobs.find((j) => j.key === req.params.key);
    successResponse(res, job);
  } catch (e: any) {
    if (e.message === 'UNKNOWN_JOB') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知定时任务');
    if (e.message === 'BAD_TIME') return errorResponse(res, 422, 'VALIDATION_ERROR', '时间格式应为 HH:MM');
    if (e.message === 'BAD_EXPR') return errorResponse(res, 422, 'VALIDATION_ERROR', 'cron 表达式不合法');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '操作失败');
  }
});

router.post('/:key/run', (req: Request, res: Response) => {
  try {
    runCronNow(req.params.key);
    successResponse(res, { started: true });
  } catch (e: any) {
    if (e.message === 'UNKNOWN_JOB') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知定时任务');
    if (e.message === 'ALREADY_RUNNING') return errorResponse(res, 409, 'JOB_LOCKED', '该任务正在运行');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '操作失败');
  }
});

router.get('/:key/log', (req: Request, res: Response) => {
  if (!CRON_JOBS.find((j) => j.key === req.params.key)) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知定时任务');
  successResponse(res, getJobLog(`cron:${req.params.key}`));
});

export default router;
