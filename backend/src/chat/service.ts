import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { getCorePersona } from '../agent/profiles-service';
import { runAnalysis } from '../analysis/orchestrator';
import { getStockName, getCachedName } from '../data/service';
import { skillDirectives } from '../plugins/service';
import { getLatestReportByCode } from '../analysis/report-service';
import { getActive, listVersionHistory } from '../rulebook/service';
import { getLatest as getLatestScreen } from '../screen/service';
import { buildMarketInjection } from './market-context';
import { isTradingDay } from '../data/trade-calendar';
import { beijingDate, dailyPhase, getStrategy, getIntradayTimeline } from '../strategy/service';

export type ChatKind = 'general' | 'core_principle' | 'stock' | 'morning' | 'evening' | 'screen' | 'daily';

export const FIXED_ROOM_KINDS = ['core_principle', 'daily', 'screen'] as const satisfies ChatKind[];
const FIXED_ROOM_TITLES: Record<typeof FIXED_ROOM_KINDS[number], string> = {
  core_principle: '当前策略探讨',
  daily: '当天策略和复盘',
  screen: '选股讨论',
};

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
  stock: '针对某只股票，结合当前策略与已算出的门槛结果与用户讨论。',
  morning: '盘前早会：基于大盘与板块信息给出今日操作方向。',
  evening: '盘后晚会：复盘今日操作，总结成败、找原因。',
  screen: '按当前策略的选股讨论：解释本次选股结果与依据，回答关于入选/未入选个股的追问；不替用户做买卖决定。',
  daily: '当天策略与复盘：结合今日的策略预判/盘中/复盘，与用户讨论操作与得失。',
};

const CORE_PRINCIPLE_INTERVIEW_FRAMING =
  '用户还没有当前策略。你要用【引导式半结构化】提问，一次只问 1–2 个问题，循序渐进地了解：' +
  '① 看基本面还是技术面（或都看）；② 偏好什么股（蓝筹/成长/题材/低估…）；③ 持股周期；' +
  '④ 买入信号；⑤ 卖出/止损习惯；⑥ 单票仓位、能接受的回撤。' +
  '聊到信息足够时，提示用户点下方「生成当前策略」按钮。不要替用户编造他没说过的偏好。';

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

// 幂等确保 4 个固定房间存在且置顶；返回该用户全部会话(含这 4 个)。
export function ensureFixedRooms(userId: string): any[] {
  const db = getDb();
  for (const kind of FIXED_ROOM_KINDS) {
    const existing = db.prepare('SELECT id FROM chat_sessions WHERE user_id = ? AND kind = ?').get(userId, kind) as { id: string } | undefined;
    if (!existing) {
      db.prepare('INSERT INTO chat_sessions (id, user_id, kind, ref_id, title, pinned) VALUES (?, ?, ?, NULL, ?, 1)')
        .run(uuidv4(), userId, kind, FIXED_ROOM_TITLES[kind]);
    } else {
      db.prepare('UPDATE chat_sessions SET pinned = 1 WHERE id = ?').run(existing.id);
    }
  }
  for (const oldKind of ['morning', 'evening']) {
    const rows = db.prepare('SELECT id FROM chat_sessions WHERE user_id = ? AND kind = ?').all(userId, oldKind) as { id: string }[];
    for (const r of rows) {
      db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(r.id);
      db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(r.id);
    }
  }
  return listSessions(userId);
}

// Clear a session's messages (keep the session) — e.g. restart the core-principle discussion.
export function clearMessages(userId: string, sessionId: string): void {
  if (!ownSession(userId, sessionId)) return;
  getDb().prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
}

export function setPinned(userId: string, sessionId: string, pinned: boolean): void {
  const s = ownSession(userId, sessionId);
  if (s && FIXED_ROOM_KINDS.includes(s.kind)) throw new Error('FIXED_ROOM');
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
  if (FIXED_ROOM_KINDS.includes(s.kind)) throw new Error('FIXED_ROOM');
  const db = getDb();
  db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
  // 注意：分析报告(历史)独立于会话，删除会话不删报告——选股分析里仍可查看历史。
}

// Clear all chat windows for this user. 分析历史(reports)保留，仅清空左侧会话列表。
export function clearAll(userId: string): void {
  const db = getDb();
  const ids = (db.prepare('SELECT id FROM chat_sessions WHERE user_id = ?').all(userId) as { id: string }[]).map((r) => r.id);
  for (const id of ids) db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(userId);
}

// 往会话里写一条助手消息(不调 AI)——把后台流程(选股/分析/早晚会)的错误以「来财发言」落到会话。
export function addAssistantNote(userId: string, sessionId: string, content: string): ChatMessage | null {
  if (!ownSession(userId, sessionId)) return null;
  return addMessage(sessionId, 'assistant', content);
}

function addMessage(sessionId: string, role: ChatMessage['role'], content: string): ChatMessage {
  const id = uuidv4();
  getDb().prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(id, sessionId, role, content);
  return getDb().prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as ChatMessage;
}

// 主 agent 的名字。用户在系统里说「来财」即指主 agent。
export const AGENT_NAME = '来财';

function buildPrompt(persona: string, framing: string, history: ChatMessage[], extraContext?: string, directives?: string): string {
  const convo = history.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
  return `你的名字叫「${AGENT_NAME}」，是用户的操盘主助手；当用户称呼「${AGENT_NAME}」时就是在叫你。
${persona}
${directives ? `\n${directives}\n` : ''}
当前场景：${framing}${extraContext ? `\n背景资料：\n${extraContext}` : ''}

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
  const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
  const raw = await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 1500, acct);
  return { raw, provider: cfg.provider, model: cfg.model };
}

function reportContext(report: any): string {
  if (!report) return '';
  const fails = (report.gate_results || [])
    .filter((g: any) => g.status === 'fail')
    .map((g: any) => `${g.label}(实测 ${g.actual})`)
    .join('、');
  return [
    `已对 ${report.stock_code}${report.stock_name ? '（' + report.stock_name + '）' : ''} 按当前策略做过判定：`,
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
  if (!extra && session.kind === 'daily') {
    const now = Date.now();
    const date = beijingDate(now);
    const phase = dailyPhase(now, isTradingDay(date));
    if (phase === 'prejudge') {
      const r = getStrategy(userId, date, 'prejudge');
      if (r) extra = `今日策略预判：\n${r.content}`;
    } else if (phase === 'intraday') {
      const tl = getIntradayTimeline(userId, date);
      if (tl.length) extra = `今日盘中时间线：\n${tl.map((x: any) => `· ${x.content}`).join('\n')}`;
    } else if (phase === 'review') {
      const r = getStrategy(userId, date, 'review');
      if (r) extra = `今日复盘：\n${r.content}`;
    } else {
      const r = getStrategy(userId, date, 'holiday');
      if (r) extra = `休市快报：\n${r.content}`;
    }
  }
  if (!extra && session.kind === 'screen') {
    const s = getLatestScreen(userId);
    if (s) {
      const top = s.results.slice(0, 12).map((r: any) => `${r.code} ${r.name ?? ''} ${r.aPass || r.bPass ? '入选' : '未入选'} · ${r.reason ?? ''}`).join('\n');
      extra = `本次选股范围：${s.note}\n讨论纪要：${s.discussion || '（无）'}\n候选与结果：\n${top}`;
    }
  }
  if (!extra && session.kind === 'core_principle') {
    const rb = getActive(userId);
    if (rb) {
      const g = rb.gates
        .map((x) => `${x.system}:${x.label} ${x.op}${x.threshold ?? ''}${x.unit}${x.veto ? '(否决)' : ''}`)
        .join('；');
      const hist = listVersionHistory(userId, 5)
        .map((v) => `· ${v.version_label}（${(v.created_at || '').slice(0, 10)}）：${v.note || '（无说明）'}`)
        .join('\n');
      extra = `当前策略【${rb.version.version_label}】人设：${rb.version.persona}\n硬门槛：${g}\n\n原则演进记忆（最近变更，知道为什么是现在这样）：\n${hist}`;
    }
  }
  // 行情数据注入（个股/大盘，动态窗口）。仅当调用方未显式传 extraContext 时。
  if (!opts.extraContext) {
    try {
      const mc = await buildMarketInjection(userId, session.kind, session.ref_id ?? null, content);
      if (mc) extra = [extra, mc].filter(Boolean).join('\n\n');
    } catch {
      /* 安静降级 */
    }
  }
  let framing = KIND_FRAMING[session.kind as ChatKind];
  if (session.kind === 'core_principle' && !getActive(userId)) framing = CORE_PRINCIPLE_INTERVIEW_FRAMING;
  const prompt = buildPrompt(persona, framing, history, extra, skillDirectives(userId));
  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));
  const { raw } = await aiCall(prompt);
  return addMessage(sessionId, 'assistant', (raw || '').trim() || '（无回复）');
}
