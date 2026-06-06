import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { PROVIDERS, getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import * as svc from '../ai/service';

const router = Router();
router.use(authMiddleware);

// GET /api/ai/providers — static catalog (no secrets)
router.get('/providers', (_req: Request, res: Response) => {
  successResponse(res, PROVIDERS);
});

// GET /api/ai/configs — this user's saved configs (key masked)
router.get('/configs', (req: Request, res: Response) => {
  successResponse(res, svc.listConfigs(req.user!.userId));
});

// GET /api/ai/active — active provider + model (no key)
router.get('/active', (req: Request, res: Response) => {
  const a = svc.getActiveConfig(req.user!.userId);
  successResponse(res, a ? { provider: a.provider, model: a.model } : null);
});

const saveSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().min(1),
  model: z.string().min(1),
});

// PUT /api/ai/configs/:provider — save/update a provider config
router.put('/configs/:provider', (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    svc.saveConfig(req.user!.userId, req.params.provider, parsed.data);
    successResponse(res, null, '已保存');
  } catch (e: any) {
    if (e.message === 'UNKNOWN_PROVIDER') return errorResponse(res, 422, 'VALIDATION_ERROR', '不支持的提供商');
    if (e.message === 'API_KEY_REQUIRED') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '该提供商需要 API Key');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '保存失败');
  }
});

// POST /api/ai/configs/:provider/enable — toggle whether this config is in the usable pool
router.post('/configs/:provider/enable', (req: Request, res: Response) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  svc.setEnabled(req.user!.userId, req.params.provider, parsed.data.enabled);
  successResponse(res, null, parsed.data.enabled ? '已启用' : '已停用');
});

// GET /api/ai/roles — task roles with current assignment + resolved model (no keys)
router.get('/roles', (req: Request, res: Response) => {
  successResponse(res, svc.listRoleAssignments(req.user!.userId));
});

const roleSchema = z.object({
  mode: z.enum(['manual', 'auto']),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});

// POST /api/ai/roles/auto-assign — main agent assigns models to all task roles
router.post('/roles/auto-assign', async (req: Request, res: Response) => {
  try {
    await svc.autoAssignRoles(req.user!.userId);
    successResponse(res, svc.listRoleAssignments(req.user!.userId), '主 agent 已完成分配');
  } catch (e: any) {
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」启用至少一个模型');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `分配失败：${e.message || '未知错误'}`);
  }
});

// PUT /api/ai/roles/:role — pin a model to a task, or set it to auto (agent picks)
router.put('/roles/:role', (req: Request, res: Response) => {
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    svc.setRoleAssignment(req.user!.userId, req.params.role, parsed.data);
    successResponse(res, null, '已更新分工');
  } catch (e: any) {
    const map: Record<string, [number, string]> = {
      UNKNOWN_ROLE: [422, '未知任务角色'],
      PROVIDER_REQUIRED: [422, '手动指定需选择提供商'],
      NOT_ENABLED: [400, '该提供商未配置或未启用'],
      API_KEY_REQUIRED: [400, '该提供商需要 API Key'],
    };
    const [code, msg] = map[e.message] || [400, e.message || '操作失败'];
    errorResponse(res, code, code === 422 ? 'VALIDATION_ERROR' : 'BUSINESS_CONFLICT', msg);
  }
});

// DELETE /api/ai/configs/:provider
router.delete('/configs/:provider', (req: Request, res: Response) => {
  svc.deleteConfig(req.user!.userId, req.params.provider);
  successResponse(res, null, '已删除');
});

const testSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
});

// POST /api/ai/configs/:provider/test — real tiny call to verify connectivity
router.post('/configs/:provider/test', async (req: Request, res: Response) => {
  const def = getProvider(req.params.provider);
  if (!def) return errorResponse(res, 422, 'VALIDATION_ERROR', '不支持的提供商');
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');

  const saved = svc.getDecrypted(req.user!.userId, req.params.provider);
  const baseUrl = parsed.data.baseUrl || saved?.baseUrl || def.defaultBaseUrl;
  const model = parsed.data.model || saved?.model || def.models[0];
  // Use a freshly typed key if provided & not masked, else the saved one.
  let apiKey = saved?.apiKey || '';
  if (parsed.data.apiKey && !parsed.data.apiKey.includes('****')) apiKey = parsed.data.apiKey;
  if (def.needsApiKey && !apiKey) return errorResponse(res, 422, 'VALIDATION_ERROR', '缺少 API Key');

  try {
    const reply = await chat(def.apiStyle, { baseUrl, model, apiKey }, '请只回复：OK', 16);
    successResponse(res, { ok: true, reply: (reply || '').trim().slice(0, 200) });
  } catch (e: any) {
    successResponse(res, { ok: false, error: e.message || '连接失败' });
  }
});

export default router;
