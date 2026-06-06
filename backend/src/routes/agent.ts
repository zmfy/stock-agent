import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as profiles from '../agent/profiles-service';

const router = Router();
router.use(authMiddleware);

// GET /api/agent/profiles — main + sub-agent personas (defaults if unset)
router.get('/profiles', (req: Request, res: Response) => {
  successResponse(res, profiles.listProfiles(req.user!.userId));
});

// PUT /api/agent/profiles/:role — set a persona
router.put('/profiles/:role', (req: Request, res: Response) => {
  const parsed = z.object({ persona: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '请提供人设文本');
  try {
    profiles.setProfile(req.user!.userId, req.params.role, parsed.data.persona);
    successResponse(res, null, '已保存');
  } catch (e: any) {
    if (e.message === 'UNKNOWN_ROLE') return errorResponse(res, 422, 'VALIDATION_ERROR', '未知角色');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '保存失败');
  }
});

// POST /api/agent/profiles/generate-subs — main agent drafts the sub-agent personas
router.post('/profiles/generate-subs', async (req: Request, res: Response) => {
  try {
    const out = await profiles.generateSubAgents(req.user!.userId);
    successResponse(res, out, '已生成子 agent 人设');
  } catch (e: any) {
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `生成失败：${e.message || '未知错误'}`);
  }
});

export default router;
