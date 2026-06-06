import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { getCorePersona } from '../agent/profiles-service';
import { runAnalysis } from '../analysis/orchestrator';
import { getStockName, getCachedName } from '../data/service';
import { getLatestReportByCode, deleteReportsByCode, deleteAllReports } from '../analysis/report-service';
import { getTodayContent } from '../meetings/service';
import { getActive } from '../rulebook/service';

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
  // 个股会话：本地股票库里已有名称就直接用「名称 代码」当标题（即时，无需联网）；
  // 本地查不到时保留占位标题，由 analyzeStockSession 走 sidecar/AI 兜底补全。
  let finalTitle = title ?? null;
  if (kind === 'stock' && refId) {
    const name = getCachedName(refId);
    if (name) finalTitle = `${name} ${refId}`;
  }
  getDb()
    .prepare('INSERT INTO chat_sessions (id, user_id, kind, ref_id, title) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, kind, refId ?? null, finalTitle);
  return id;
}

export function listSessions(userId: string, kind?: ChatKind): any[] {
  if (kind) {
    return getDb()
      .prepare('SELECT * FROM chat_sessions WHERE user_id = ? AND kind = ? ORDER BY pinned DESC, created_at DESC')
      .all(userId, kind);
  }
  return getDb().prepare('SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY pinned DESC, created_at DESC').all(userId);
}

// Clear a session's messages (keep the session) — e.g. restart the core-principle discussion.
export function clearMessages(userId: string, sessionId: string): void {
  if (!ownSession(userId, sessionId)) return;
  getDb().prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
}

export function setPinned(userId: string, sessionId: string, pinned: boolean): void {
  getDb().prepare('UPDATE chat_sessions SET pinned = ? WHERE id = ? AND user_id = ?').run(pinned ? 1 : 0, sessionId, userId);
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
  // Clearing a stock window also clears the agent's "memory" of that stock (its analysis reports).
  if (s.kind === 'stock' && s.ref_id) deleteReportsByCode(userId, s.ref_id);
}

// Clear all chat windows and the agent's stock memory (reports) for this user.
export function clearAll(userId: string): void {
  const db = getDb();
  const ids = (db.prepare('SELECT id FROM chat_sessions WHERE user_id = ?').all(userId) as { id: string }[]).map((r) => r.id);
  for (const id of ids) db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(userId);
  deleteAllReports(userId);
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

function reportContext(report: any): string {
  if (!report) return '';
  const fails = (report.gate_results || [])
    .filter((g: any) => g.status === 'fail')
    .map((g: any) => `${g.label}(实测 ${g.actual})`)
    .join('、');
  return [
    `已对 ${report.stock_code}${report.stock_name ? '（' + report.stock_name + '）' : ''} 按当前核心原则做过判定：`,
    `一句话：${report.one_liner}`,
    `A系统：${report.a_conclusion}`,
    `B系统：${report.b_conclusion}`,
    fails ? `未通过的硬门槛：${fails}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Run a fresh analysis on a stock session's code and seed the conversation with it.
export async function analyzeStockSession(userId: string, sessionId: string): Promise<{ report: any; message: ChatMessage }> {
  const session = ownSession(userId, sessionId);
  if (!session) throw new Error('NOT_FOUND');
  if (session.kind !== 'stock' || !session.ref_id) throw new Error('NOT_STOCK');
  // Resolve the name first (reliable, independent of full data) so the window shows
  // name+code even if analysis is then blocked by the validation gate.
  const name = await getStockName(userId, session.ref_id).catch(() => null);
  if (name) {
    getDb().prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(`${name} ${session.ref_id}`, sessionId);
  }
  const report = await runAnalysis(userId, session.ref_id);
  if (report?.stock_name && !name) {
    getDb().prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(`${report.stock_name} ${session.ref_id}`, sessionId);
  }
  const summary = `${reportContext(report)}\n\n你可以继续追问这只股票（估值、买点、仓位、与同类比较等）。`;
  const message = addMessage(sessionId, 'assistant', summary);
  return { report, message };
}

export async function postMessage(userId: string, sessionId: string, content: string, opts: PostOptions = {}): Promise<ChatMessage> {
  const session = ownSession(userId, sessionId);
  if (!session) throw new Error('NOT_FOUND');
  addMessage(sessionId, 'user', content);
  const history = getMessages(userId, sessionId);
  const persona = getCorePersona(userId);
  // Ground stock-session follow-ups in the latest analysis report for that code.
  let extra = opts.extraContext;
  if (!extra && session.kind === 'stock' && session.ref_id) {
    extra = reportContext(getLatestReportByCode(userId, session.ref_id));
  }
  if (!extra && (session.kind === 'morning' || session.kind === 'evening')) {
    const mc = getTodayContent(userId, session.kind);
    if (mc) extra = `今日${session.kind === 'morning' ? '早会' : '晚会'}内容：\n${mc}`;
  }
  if (!extra && session.kind === 'core_principle') {
    const rb = getActive(userId);
    if (rb) {
      const g = rb.gates
        .map((x) => `${x.system}:${x.label} ${x.op}${x.threshold ?? ''}${x.unit}${x.veto ? '(否决)' : ''}`)
        .join('；');
      extra = `当前核心原则【${rb.version.version_label}】人设：${rb.version.persona}\n硬门槛：${g}`;
    }
  }
  const prompt = buildPrompt(persona, session.kind, history, extra);
  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));
  const { raw } = await aiCall(prompt);
  return addMessage(sessionId, 'assistant', (raw || '').trim() || '（无回复）');
}
