import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../rulebook/service';
import { TEMPLATES } from '../rulebook/templates';

const router = Router();
router.use(authMiddleware);

// GET /api/rulebook/templates — built-in starter templates (no gates payload, just meta)
router.get('/templates', (_req: Request, res: Response) => {
  successResponse(
    res,
    TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description,
      versionLabel: t.baseline.versionLabel,
      gateCount: t.baseline.gates.length,
    }))
  );
});

const gateSchema = z.object({
  system: z.enum(['A', 'B']),
  gate_key: z.string().min(1),
  label: z.string(),
  field: z.string(),
  op: z.enum(['>=', '>', '<=', '<', 'between', 'gt_field']),
  threshold: z.number().nullable(),
  threshold2: z.number().nullable(),
  ref_field: z.string().nullable(),
  unit: z.string(),
  veto: z.number(),
  teach: z.string(),
});

const softRuleSchema = z.object({
  system: z.enum(['A', 'B']),
  text: z.string().min(1),
  teach: z.string(),
});

const versionSchema = z.object({
  versionLabel: z.string().min(1).max(40),
  persona: z.string(),
  note: z.string().optional(),
  parentVersionId: z.string().nullable().optional(),
  gates: z.array(gateSchema),
  softRules: z.array(softRuleSchema),
  positionRules: z.record(z.unknown()),
});

// GET /api/rulebook/active
router.get('/active', (req: Request, res: Response) => {
  successResponse(res, svc.getActive(req.user!.userId));
});

// POST /api/rulebook/init { template? } — import a starter template (only if the user has none)
router.post('/init', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  if (svc.hasAnyVersion(userId)) {
    return errorResponse(res, 409, 'BUSINESS_CONFLICT', '已存在规则版本，无需重复导入');
  }
  const template = typeof req.body?.template === 'string' ? req.body.template : undefined;
  successResponse(res, svc.instantiateTemplate(userId, template), '已导入规则模板', 201);
});

// GET /api/rulebook/versions
router.get('/versions', (req: Request, res: Response) => {
  successResponse(res, svc.listVersions(req.user!.userId));
});

// GET /api/rulebook/versions/:id
router.get('/versions/:id', (req: Request, res: Response) => {
  const rb = svc.getVersion(req.user!.userId, req.params.id);
  if (!rb) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '版本不存在');
  successResponse(res, rb);
});

// POST /api/rulebook/versions — create a new (inactive) version
router.post('/versions', (req: Request, res: Response) => {
  const parsed = versionSchema.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(res, 422, 'VALIDATION_ERROR', parsed.error.errors[0]?.message || '参数校验失败');
  }
  const rb = svc.createVersion(req.user!.userId, { ...parsed.data, author: 'user' });
  successResponse(res, rb, '新版本已创建（未激活）', 201);
});

// POST /api/rulebook/versions/:id/activate — adopt this version
router.post('/versions/:id/activate', (req: Request, res: Response) => {
  try {
    svc.activateVersion(req.user!.userId, req.params.id);
    successResponse(res, null, '已采纳为当前使用版本');
  } catch {
    errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '版本不存在');
  }
});

// GET /api/rulebook/versions/:id/diff?against=<otherId>  (against defaults to active)
router.get('/versions/:id/diff', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  let against = (req.query.against as string) || '';
  if (!against) {
    const active = svc.getActive(userId);
    if (!active) return errorResponse(res, 422, 'VALIDATION_ERROR', '没有可对比的当前版本');
    against = active.version.id;
  }
  const diff = svc.diffVersions(userId, against, req.params.id);
  if (!diff) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '版本不存在');
  successResponse(res, diff);
});

export default router;
