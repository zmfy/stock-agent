import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as svc from '../rulebook/service';
import { TEMPLATES } from '../rulebook/templates';
import { proposeChange, applyProposal } from '../rulebook/propose-service';
import { getMessages } from '../chat/service';

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

// POST /api/rulebook/apply-template { template } — switch active rulebook to a template (new version)
router.post('/apply-template', (req: Request, res: Response) => {
  const parsed = z.object({ template: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '请选择模板');
  try {
    const rb = svc.applyTemplateAsVersion(req.user!.userId, parsed.data.template);
    successResponse(res, rb, '已换入模板为当前核心原则', 201);
  } catch (e: any) {
    if (e.message === 'UNKNOWN_TEMPLATE') return errorResponse(res, 422, 'VALIDATION_ERROR', '未知模板');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '换入失败');
  }
});

// POST /api/rulebook/propose { instruction, sessionId? } — agent drafts a change (NOT saved)
router.post('/propose', async (req: Request, res: Response) => {
  const parsed = z.object({ instruction: z.string().max(2000).optional(), sessionId: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  let context = '';
  if (parsed.data.sessionId) {
    try {
      const msgs = getMessages(req.user!.userId, parsed.data.sessionId);
      context = msgs.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
    } catch {
      /* session not found -> no context */
    }
  }
  try {
    const result = await proposeChange(req.user!.userId, parsed.data.instruction || '', { context });
    successResponse(res, result);
  } catch (e: any) {
    if (e.message === 'NO_RULEBOOK') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先导入或设定规则版本');
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    if (e.message === 'PARSE_FAILED') return errorResponse(res, 502, 'UPSTREAM_ERROR', 'agent 提议解析失败，请把诉求说得更具体些再试');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `提议失败：${e.message || '未知错误'}`);
  }
});

const applySchema = z.object({
  versionLabel: z.string().min(1).max(40),
  proposal: z.object({
    persona: z.string(),
    note: z.string().optional(),
    gates: z.array(gateSchema),
    softRules: z.array(softRuleSchema),
    positionRules: z.record(z.unknown()),
  }),
});

// POST /api/rulebook/apply { versionLabel, proposal } — user confirms -> create + activate
router.post('/apply', (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', parsed.error.errors[0]?.message || '参数校验失败');
  const p = parsed.data.proposal;
  const rb = applyProposal(req.user!.userId, { persona: p.persona, note: p.note ?? '规则调整', gates: p.gates as any, softRules: p.softRules as any, positionRules: p.positionRules }, parsed.data.versionLabel);
  successResponse(res, rb, '已采纳并升级版本', 201);
});

export default router;
