import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as chat from '../chat/service';

const router = Router();
router.use(authMiddleware);

const KINDS = ['general', 'core_principle', 'stock', 'morning', 'evening'] as const;

// POST /api/chat/sessions
router.post('/sessions', (req: Request, res: Response) => {
  const parsed = z
    .object({ kind: z.enum(KINDS).default('general'), refId: z.string().nullable().optional(), title: z.string().max(120).optional() })
    .safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const id = chat.createSession(req.user!.userId, parsed.data.kind, parsed.data.refId, parsed.data.title);
  successResponse(res, { id }, '会话已创建', 201);
});

// GET /api/chat/sessions?kind=
router.get('/sessions', (req: Request, res: Response) => {
  const kind = req.query.kind as chat.ChatKind | undefined;
  successResponse(res, chat.listSessions(req.user!.userId, kind));
});

// GET /api/chat/sessions/:id/messages
router.get('/sessions/:id/messages', (req: Request, res: Response) => {
  try {
    successResponse(res, chat.getMessages(req.user!.userId, req.params.id));
  } catch {
    errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '会话不存在');
  }
});

// POST /api/chat/sessions/:id/messages { content }
router.post('/sessions/:id/messages', async (req: Request, res: Response) => {
  const parsed = z.object({ content: z.string().min(1).max(4000) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '请输入内容');
  try {
    const reply = await chat.postMessage(req.user!.userId, req.params.id, parsed.data.content);
    successResponse(res, reply, '已回复', 201);
  } catch (e: any) {
    if (e.message === 'NOT_FOUND') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '会话不存在');
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `回复失败：${e.message || '未知错误'}`);
  }
});

// POST /api/chat/sessions/:id/analyze — run analysis on a stock session and seed it
router.post('/sessions/:id/analyze', async (req: Request, res: Response) => {
  try {
    const out = await chat.analyzeStockSession(req.user!.userId, req.params.id);
    successResponse(res, out, '分析完成', 201);
  } catch (e: any) {
    if (e.message === 'NOT_FOUND') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '会话不存在');
    if (e.message === 'NOT_STOCK') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '该会话不是个股会话');
    if (e.message === 'NO_RULEBOOK') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「核心规则」导入或设定规则版本');
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `分析失败：${e.message || '未知错误'}`);
  }
});

// DELETE /api/chat/sessions — clear ALL chats + stock memory
router.delete('/sessions', (req: Request, res: Response) => {
  chat.clearAll(req.user!.userId);
  successResponse(res, null, '已清空全部对话');
});

// DELETE /api/chat/sessions/:id
router.delete('/sessions/:id', (req: Request, res: Response) => {
  chat.deleteSession(req.user!.userId, req.params.id);
  successResponse(res, null, '已删除');
});

export default router;
