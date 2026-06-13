import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import * as chat from '../chat/service';

const router = Router();
router.use(authMiddleware);

// Keep in sync with ChatKind in ../chat/service.ts — a missing kind here makes createSession 422.
// 'daily' 和 'ai_model' 故意不在此列：这两个房间仅由 ensure-fixed-rooms 建，禁止用户直接创建。
const KINDS = ['general', 'core_principle', 'stock', 'morning', 'evening', 'screen'] as const;

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

// POST /api/chat/ensure-fixed-rooms — 幂等建齐 3 个固定房间并置顶
router.post('/ensure-fixed-rooms', (req: Request, res: Response) => {
  successResponse(res, chat.ensureFixedRooms(req.user!.userId));
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

// POST /api/chat/sessions/:id/note { content } — 写一条助手消息(不调 AI)，用于把后台流程错误以来财发言显示
router.post('/sessions/:id/note', (req: Request, res: Response) => {
  const parsed = z.object({ content: z.string().min(1).max(4000) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '请输入内容');
  const msg = chat.addAssistantNote(req.user!.userId, req.params.id, parsed.data.content);
  if (!msg) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '会话不存在');
  successResponse(res, msg, '已记录', 201);
});

// POST /api/chat/sessions/:id/analyze — run analysis on a stock session and seed it
router.post('/sessions/:id/analyze', async (req: Request, res: Response) => {
  try {
    const out = await chat.analyzeStockSession(req.user!.userId, req.params.id);
    successResponse(res, out, '分析完成', 201);
  } catch (e: any) {
    if (e.message === 'NOT_FOUND') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '会话不存在');
    if (e.message === 'NOT_STOCK') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '该会话不是个股会话');
    if (e.message === 'NO_RULEBOOK') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「当前策略」导入或设定规则版本');
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    if (e.message === 'DATA_UNTRUSTED') {
      const v = (e as any).validation;
      const miss = v?.missing?.length ? `缺失字段：${v.missing.join('、')}。` : '';
      return errorResponse(res, 400, 'DATA_UNTRUSTED', `数据未通过校验，已阻断分析。${miss}请在「数据」上传该股行情或刷新数据源后重试。`);
    }
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `分析失败：${e.message || '未知错误'}`);
  }
});

// DELETE /api/chat/sessions/:id/messages — clear this session's messages (keep session)
router.delete('/sessions/:id/messages', (req: Request, res: Response) => {
  chat.clearMessages(req.user!.userId, req.params.id);
  successResponse(res, null, '已清空本会话记忆');
});

// PUT /api/chat/sessions/:id/pin { pinned }
router.put('/sessions/:id/pin', (req: Request, res: Response) => {
  const parsed = z.object({ pinned: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    chat.setPinned(req.user!.userId, req.params.id, parsed.data.pinned);
    successResponse(res, null, parsed.data.pinned ? '已置顶' : '已取消置顶');
  } catch (e: any) {
    if (e.message === 'FIXED_ROOM') return errorResponse(res, 409, 'BUSINESS_CONFLICT', '固定房间不可更改置顶');
    throw e;
  }
});

// DELETE /api/chat/sessions — clear ALL chats + stock memory
router.delete('/sessions', (req: Request, res: Response) => {
  chat.clearAll(req.user!.userId);
  successResponse(res, null, '已清空全部对话');
});

// DELETE /api/chat/sessions/:id
router.delete('/sessions/:id', (req: Request, res: Response) => {
  try {
    chat.deleteSession(req.user!.userId, req.params.id);
    successResponse(res, null, '已删除');
  } catch (e: any) {
    if (e.message === 'FIXED_ROOM') return errorResponse(res, 409, 'BUSINESS_CONFLICT', '固定房间不可删除');
    throw e;
  }
});

export default router;
