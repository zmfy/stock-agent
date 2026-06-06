import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getActive } from '../rulebook/service';
import { getLatestMarket } from '../data/service';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { getCorePersona, listProfiles } from '../agent/profiles-service';

export type MeetingKind = 'morning' | 'evening';

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function marketText(): { text: string; data: any } {
  const m = getLatestMarket();
  if (!m) return { text: '（暂无大盘数据，建议先在「数据」刷新或上传）', data: null };
  const slope = m.sse_ma20_slope;
  const trend = slope === null ? '未知' : slope > 0 ? '向上' : slope < 0 ? '向下' : '走平';
  return {
    text: `大盘情绪（${m.date}）：涨停 ${m.limit_up_count ?? '?'} 家、跌停 ${m.limit_down_count ?? '?'} 家、上证20日线斜率 ${slope ?? '?'}（趋势${trend}）。`,
    data: m,
  };
}

function rulebookText(userId: string): string {
  const rb = getActive(userId);
  if (!rb) return '（用户尚未设定核心原则）';
  const gates = rb.gates.map((g) => `${g.system}:${g.label}`).join('、');
  return `当前核心原则【${rb.version.version_label}】硬门槛：${gates}。`;
}

function todaysReports(userId: string): Array<{ stock_code: string; one_liner: string }> {
  return getDb()
    .prepare("SELECT stock_code, one_liner FROM reports WHERE user_id = ? AND date(created_at) = date('now') ORDER BY created_at")
    .all(userId) as any[];
}

function getMorningOfToday(userId: string): { content: string } | undefined {
  return getDb()
    .prepare("SELECT content FROM meetings WHERE user_id = ? AND kind = 'morning' AND date = ?")
    .get(userId, today()) as any;
}

// 子助手人设（取不到就用空串，由各 prompt 自带职责说明兜底）
function personaOf(userId: string, role: string): string {
  return listProfiles(userId).find((p) => p.role === role)?.persona || '';
}

// 数据员：把今日盘面数据读成要点
export function buildMorningDataPrompt(persona: string, market: string): string {
  return `${persona || '你是后台数据员，只客观整理盘面事实，不下结论。'}

你是早会上的【数据员】。今日盘面原始数据：
${market}
请用 2-4 条要点，客观整理今日盘面事实（涨跌停对比、上证趋势、情绪冷热程度），只陈述事实、不下交易结论。中文、简短。`;
}

// 分析师：按核心原则把数据读成交易研判
export function buildMorningAnalysisPrompt(persona: string, market: string, rulebook: string, dataOut: string): string {
  return `${persona || '你是分析师，严格按核心原则把数据转成可执行研判。'}

你是早会上的【分析师】。数据员刚才的整理：
${dataOut}
${market}
${rulebook}
请据此判断：今日能否开新仓？A / B 系统今日是否开闸？给出理由（对照硬门槛/情绪闸门）。中文、分点、简短。`;
}

// 情绪面：题材/情绪观察
export function buildMorningQualPrompt(persona: string, market: string): string {
  return `${persona || '你负责情绪与题材面观察，提炼成要点。'}

你是早会上的【情绪面观察员】。今日盘面：
${market}
请从市场情绪/题材活跃度角度给 1-3 条观察（情绪是否过热或冰点、是否适合做短线题材）。中文、简短。`;
}

// 主 agent 来财：综合三位子助手，给最终研判并指出依据
export function buildMorningSynthPrompt(
  persona: string,
  market: string,
  rulebook: string,
  dataOut: string,
  analysisOut: string,
  qualOut: string
): string {
  return `${persona}

你是主 agent「来财」，正在主持盘前【早会】。三位子助手已分别汇报：
〖数据员〗${dataOut}
〖分析师〗${analysisOut}
〖情绪面〗${qualOut}
${market}
${rulebook}

请你综合三位的汇报，给出今日的最终研判：
1）大盘研判（情绪冷热、能否开新仓、A/B 系统今日是否开闸）
2）今日操作思路（偏防守还是进攻、重点关注什么）
并务必说明：你主要采纳了哪位子助手的哪条结论作为依据（点名「数据员/分析师/情绪面」）。
要求：简洁、可执行、不预测点位。中文、分点输出。`;
}

export function buildEveningPrompt(
  persona: string,
  market: string,
  rulebook: string,
  morning: string | null,
  ops: Array<{ stock_code: string; one_liner: string }>
): string {
  const opsText = ops.length ? ops.map((o) => `- ${o.stock_code}：${o.one_liner}`).join('\n') : '（今日无分析/操作记录）';
  return `${persona}

你在主持盘后【晚会】复盘。已知信息：
${market}
${rulebook}
今日早会观点：${morning || '（今日无早会记录）'}
今日的分析/操作：
${opsText}

请复盘：
1）今日早会研判是否成立（成功/失败，结合大盘收盘表现）
2）若有偏差，找出原因（情绪误判？原则太松/太严？执行问题？）
3）是否建议调整核心原则；如建议，明确指出改哪条、怎么改（用户将另行确认）
用中文，分点输出，简洁。`;
}

async function defaultAiCall(userId: string, prompt: string, role: string): Promise<string> {
  const cfg = getModelForRole(userId, role) || getModelForRole(userId, 'core');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  return chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 1200);
}

function upsert(userId: string, kind: MeetingKind, content: string, data: any): any {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM meetings WHERE user_id = ? AND kind = ? AND date = ?').get(userId, kind, today()) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare('UPDATE meetings SET content = ?, data = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, JSON.stringify(data), existing.id);
    return db.prepare('SELECT * FROM meetings WHERE id = ?').get(existing.id);
  }
  const id = uuidv4();
  db.prepare('INSERT INTO meetings (id, user_id, kind, date, content, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, kind, today(), content, JSON.stringify(data));
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

export interface GenOpts {
  aiCall?: (prompt: string, role: string) => Promise<string>;
}

// 早会 = 多 agent 讨论：数据员→分析师→情绪面 三位子助手分别汇报，来财综合研判并指出依据。
export async function generateMorning(userId: string, opts: GenOpts = {}): Promise<any> {
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const rbText = rulebookText(userId);
  const aiCall = opts.aiCall || ((p: string, role: string) => defaultAiCall(userId, p, role));

  const dataOut = (await aiCall(buildMorningDataPrompt(personaOf(userId, 'data'), mkt.text), 'data')).trim();
  const analysisOut = (await aiCall(buildMorningAnalysisPrompt(personaOf(userId, 'analysis'), mkt.text, rbText, dataOut), 'analysis')).trim();
  const qualOut = (await aiCall(buildMorningQualPrompt(personaOf(userId, 'qualitative'), mkt.text), 'qualitative')).trim();
  const coreOut = (await aiCall(buildMorningSynthPrompt(persona, mkt.text, rbText, dataOut, analysisOut, qualOut), 'core')).trim();

  const content = [
    `🗣 早会讨论 · ${today()}`,
    '',
    '【数据员】整理今日盘面：',
    dataOut,
    '',
    '【分析师】按核心原则研判：',
    analysisOut,
    '',
    '【情绪面】题材/情绪观察：',
    qualOut,
    '',
    '———',
    '🧠 来财综合研判：',
    coreOut,
  ].join('\n');

  return upsert(userId, 'morning', content, { market: mkt.data, discussion: { data: dataOut, analysis: analysisOut, qualitative: qualOut, core: coreOut } });
}

export async function generateEvening(userId: string, opts: GenOpts = {}): Promise<any> {
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const morning = getMorningOfToday(userId)?.content ?? null;
  const ops = todaysReports(userId);
  const prompt = buildEveningPrompt(persona, mkt.text, rulebookText(userId), morning, ops);
  const aiCall = opts.aiCall || ((p: string, role: string) => defaultAiCall(userId, p, role));
  const content = await aiCall(prompt, 'review');
  return upsert(userId, 'evening', content.trim(), { market: mkt.data, ops });
}

export function getToday(userId: string): { morning: any | null; evening: any | null } {
  const db = getDb();
  const m = db.prepare("SELECT * FROM meetings WHERE user_id = ? AND kind = 'morning' AND date = ?").get(userId, today());
  const e = db.prepare("SELECT * FROM meetings WHERE user_id = ? AND kind = 'evening' AND date = ?").get(userId, today());
  return { morning: m ?? null, evening: e ?? null };
}

export function listMeetings(userId: string, limit = 30): any[] {
  return getDb()
    .prepare('SELECT id, kind, date, content, created_at FROM meetings WHERE user_id = ? ORDER BY date DESC, kind LIMIT ?')
    .all(userId, limit);
}

export function getTodayContent(userId: string, kind: MeetingKind): string | null {
  const db = getDb();
  const row = db.prepare('SELECT content FROM meetings WHERE user_id = ? AND kind = ? AND date = ?').get(userId, kind, today()) as
    | { content: string }
    | undefined;
  return row?.content ?? null;
}

// Users eligible for auto-generation: have an active rulebook + a usable core model.
export function eligibleUserIds(): string[] {
  const users = getDb().prepare('SELECT id FROM users').all() as { id: string }[];
  return users.filter((u) => getActive(u.id) && getModelForRole(u.id, 'core')).map((u) => u.id);
}
