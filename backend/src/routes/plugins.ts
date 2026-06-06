import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { CATALOG } from '../plugins/catalog';
import * as svc from '../plugins/service';

const router = Router();
router.use(authMiddleware);

// GET /api/plugins/catalog
router.get('/catalog', (_req: Request, res: Response) => {
  successResponse(res, CATALOG);
});

// GET /api/plugins — merged per-user view
router.get('/', (req: Request, res: Response) => {
  successResponse(res, svc.listForUser(req.user!.userId));
});

// GET /api/plugins/enabled — resolved capabilities for the agent (Plan 5/6)
router.get('/enabled', (req: Request, res: Response) => {
  successResponse(res, svc.getEnabledCapabilities(req.user!.userId));
});

const enableSchema = z.object({ enabled: z.boolean(), config: z.record(z.unknown()).optional() });

// POST /api/plugins/:key/enable
router.post('/:key/enable', (req: Request, res: Response) => {
  const parsed = enableSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    svc.setEnabled(req.user!.userId, req.params.key, parsed.data.enabled, parsed.data.config);
    successResponse(res, null, parsed.data.enabled ? '已启用' : '已停用');
  } catch (e: any) {
    if (e.message === 'UNKNOWN_PLUGIN') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知插件');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '操作失败');
  }
});

const customSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[a-zA-Z0-9_-]+$/, 'key 只能含字母数字-_'),
  label: z.string().min(1).max(60),
  kind: z.enum(['mcp', 'skill']),
  transport: z.enum(['stdio', 'http']).nullable().optional(),
  config: z.record(z.unknown()),
});

// POST /api/plugins/custom
router.post('/custom', (req: Request, res: Response) => {
  const parsed = customSchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', parsed.error.errors[0]?.message || '参数校验失败');
  try {
    svc.addCustom(req.user!.userId, parsed.data);
    successResponse(res, null, '自定义插件已添加', 201);
  } catch (e: any) {
    if (e.message === 'DUPLICATE_KEY') return errorResponse(res, 409, 'BUSINESS_CONFLICT', '插件 key 已存在');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '添加失败');
  }
});

// PUT /api/plugins/:key/config
router.put('/:key/config', (req: Request, res: Response) => {
  const parsed = z.object({ config: z.record(z.unknown()) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    svc.updateConfig(req.user!.userId, req.params.key, parsed.data.config);
    successResponse(res, null, '配置已更新');
  } catch (e: any) {
    if (e.message === 'UNKNOWN_PLUGIN') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知插件');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '更新失败');
  }
});

// DELETE /api/plugins/:key
router.delete('/:key', (req: Request, res: Response) => {
  svc.remove(req.user!.userId, req.params.key);
  successResponse(res, null, '已移除');
});

export default router;
