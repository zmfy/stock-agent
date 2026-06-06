import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { getCorePersona } from '../agent/profiles-service';

export type ChatKind = 'general' | 'core_principle' | 'stock' | 'morning' | 'evening';

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

const KIND_FRAMING: Record<ChatKind, string> = {
  general: '与用户自由交流操盘相关话题。',
  core_principle: '与用户探讨核心选股/操作原则的修改；给出建议但不替用户做决定。',
  stock: '针对某只股票，结合核心原则与已算出的门槛结果与用户讨论。',
  morning: '盘前早会：基于大盘与板块信息给出今日操作方向。',
  evening: '盘后晚会：复盘今日操作，总结成败、找原因。',
};

export function createSession(userId: string, kind: ChatKind, refId?: string | null, title?: string): string {
  const id = uuidv4();
  getDb()
    .prepare('INSERT INTO chat_sessions (id, user_id, kind, ref_id, title) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, kind, refId ?? null, title ?? null);
  return id;
}

export function listSessions(userId: string, kind?: ChatKind): any[] {
  if (kind) {
    return getDb()
      .prepare('SELECT * FROM chat_sessions WHERE user_id = ? AND kind = ? ORDER BY created_at DESC')
      .all(userId, kind);
  }
  return getDb().prepare('SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function ownSession(userId: string, sessionId: string): any | undefined {
  return getDb().prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
}

export function getMessages(userId: string, sessionId: string): ChatMessage[] {
  if (!ownSession(userId, sessionId)) throw new Error('NOT_FOUND');
  return getDb()
    .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid')
    .all(sessionId) as ChatMessage[];
}

export function deleteSession(userId: string, sessionId: string): void {
  const s = ownSession(userId, sessionId);
  if (!s) return;
  const db = getDb();
  db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
}

function addMessage(sessionId: string, role: ChatMessage['role'], content: string): ChatMessage {
  const id = uuidv4();
  getDb().prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(id, sessionId, role, content);
  return getDb().prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as ChatMessage;
}

function buildPrompt(persona: string, kind: ChatKind, history: ChatMessage[], extraContext?: string): string {
  const convo = history.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
  return `${persona}

当前场景：${KIND_FRAMING[kind]}${extraContext ? `\n背景资料：\n${extraContext}` : ''}

对话历史：
${convo}

请作为助手，用中文回复用户的最新一条消息（简洁、专业、可执行）：`;
}

export interface PostOptions {
  aiCall?: (prompt: string) => Promise<{ raw: string; provider: string; model: string }>;
  extraContext?: string;
}

async function defaultAiCall(userId: string, prompt: string): Promise<{ raw: string; provider: string; model: string }> {
  const cfg = getModelForRole(userId, 'core');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  const raw = await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 1500);
  return { raw, provider: cfg.provider, model: cfg.model };
}

export async function postMessage(userId: string, sessionId: string, content: string, opts: PostOptions = {}): Promise<ChatMessage> {
  const session = ownSession(userId, sessionId);
  if (!session) throw new Error('NOT_FOUND');
  addMessage(sessionId, 'user', content);
  const history = getMessages(userId, sessionId);
  const persona = getCorePersona(userId);
  const prompt = buildPrompt(persona, session.kind, history, opts.extraContext);
  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));
  const { raw } = await aiCall(prompt);
  return addMessage(sessionId, 'assistant', (raw || '').trim() || '（无回复）');
}
