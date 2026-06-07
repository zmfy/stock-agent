import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getActive } from '../rulebook/service';
import { getLatestMarket, refreshNews } from '../data/service';
import { resolveSidecarBase, fetchHotSectors } from '../data/sidecar';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { getCorePersona, listProfiles } from '../agent/profiles-service';
import { skillDirectives } from '../plugins/service';
import { recordCollected, listTitleLog, getContent, markAdopted } from '../data/news-log';
import { lastTradingDayBefore } from '../data/trade-calendar';

export type MeetingKind = 'morning' | 'evening';

export function today(): string {
  // 北京日历日 YYYY-MM-DD（DB 仍存 UTC；此处用于「当天会议」键，需按北京日界）
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
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

async function sectorText(userId: string): Promise<{ text: string; sectors: string[] }> {
  const base = resolveSidecarBase(userId);
  let sectors: string[] = [];
  if (base) sectors = (await fetchHotSectors(base, 6).catch(() => null)) || [];
  const text = sectors.length ? `近期热门板块（按涨幅排序）：${sectors.join('、')}。` : '（暂无板块热度数据）';
  return { text, sectors };
}


function buildNewsWithIds(): { text: string; idMap: Record<string, string> } {
  const rows = getDb().prepare('SELECT id, title FROM news_content_log ORDER BY collected_at DESC, rowid DESC LIMIT 8').all() as Array<{ id: string; title: string }>;
  const idMap: Record<string, string> = {};
  const lines = rows.map((r, i) => { const tag = `N${i + 1}`; idMap[tag] = r.id; return `[${tag}] ${r.title}`; });
  return { text: lines.length ? '近期财经要闻：\n' + lines.join('\n') : '（暂无近期财经新闻）', idMap };
}

// 某条 UTC 时间串对应的北京日历日 YYYY-MM-DD
function beijingDateOf(utc: string): string {
  const s = utc.includes('T') ? utc : utc.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

// 早会新闻：取「上个交易日以来」（北京日期 ≥ 上个交易日）攒下的新闻，最多 30 条；
// 覆盖周末/节假日休市期间夜间采集的新闻，作为下个交易日判断凭据。为空则回退最近 8 条。
function buildMorningNewsWithIds(): { text: string; idMap: Record<string, string> } {
  const since = lastTradingDayBefore(today());
  const rows = getDb()
    .prepare('SELECT id, title, collected_at FROM news_content_log ORDER BY collected_at DESC, rowid DESC LIMIT 60')
    .all() as Array<{ id: string; title: string; collected_at: string }>;
  const kept = rows.filter((r) => beijingDateOf(r.collected_at) >= since).slice(0, 30);
  if (!kept.length) return buildNewsWithIds();
  const idMap: Record<string, string> = {};
  const lines = kept.map((r, i) => { const tag = `N${i + 1}`; idMap[tag] = r.id; return `[${tag}] ${r.title}`; });
  return { text: `自上个交易日（${since}）以来的财经要闻：\n` + lines.join('\n'), idMap };
}

function parseAdopt(coreOut: string): { tags: string[]; clean: string } {
  const m = /__ADOPT__\s*([N\d,\s]+)/.exec(coreOut);
  const tags = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const clean = coreOut.replace(/\n?__ADOPT__\s*[N\d,\s]+/g, '').trim();
  return { tags, clean };
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

// 数据员：把今日盘面数据 + 板块热度 + 新闻读成要点
export function buildMorningDataPrompt(persona: string, market: string, sectors: string, news: string): string {
  return `${persona || '你是后台数据员，只客观整理盘面事实，不下结论。'}

你是早会上的【数据员】。今日盘面原始数据：
${market}
${sectors}
${news}
请用 3-5 条要点，客观整理今日盘面事实（涨跌停对比、上证趋势、情绪冷热、近期强势板块、值得注意的新闻），只陈述事实、不下交易结论。中文、简短。`;
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

// 情绪面：题材/情绪观察 + 预测今日可能走强的板块
export function buildMorningQualPrompt(persona: string, market: string, sectors: string, news: string): string {
  return `${persona || '你负责情绪与题材面观察，提炼成要点。'}

你是早会上的【情绪面观察员】。今日盘面与近况：
${market}
${sectors}
${news}
请输出：
1）市场情绪/题材活跃度观察（情绪过热还是冰点、是否适合做短线题材）；
2）**即使今天大盘不适合操作，也要根据新闻与近期板块走势，预测今日哪些板块可能走强**——列出 2-4 个板块名，每个配一句理由。
中文、简短、分点。`;
}

// 主 agent 来财：综合三位子助手，给最终研判并指出依据
export function buildMorningSynthPrompt(
  persona: string,
  market: string,
  rulebook: string,
  dataOut: string,
  analysisOut: string,
  qualOut: string,
  directives?: string
): string {
  return `${persona}
${directives ? `\n${directives}\n` : ''}
你是主 agent「来财」，正在主持盘前【早会】。三位子助手已分别汇报：
〖数据员〗${dataOut}
〖分析师〗${analysisOut}
〖情绪面〗${qualOut}
${market}
${rulebook}

请你综合三位的汇报，给出今日的最终研判：
1）大盘研判（情绪冷热、能否开新仓、A/B 系统今日是否开闸）
2）今日操作思路（偏防守还是进攻、重点关注什么）
3）**今日可能走强的板块**：即使今天不操作，也要明确列出 2-4 个你判断今日可能走强的板块（板块名 + 一句理由），作为复盘对照。最后用一行「今日可能走强板块：A、B、C」收尾。
并务必说明：你主要采纳了哪位子助手的哪条结论作为依据（点名「数据员/分析师/情绪面」）。
要求：简洁、可执行、不预测点位。中文、分点输出。

若你引用了上面某几条新闻作为研判依据，请在回答最后另起一行输出：__ADOPT__ 逗号分隔的编号（如 __ADOPT__ N1,N3）；没有引用就不要输出该行。`;
}

// 晚会·数据员：今日收盘实际表现 + 今日实际走强板块
export function buildEveningDataPrompt(persona: string, market: string, sectors: string): string {
  return `${persona || '你是后台数据员，只客观整理收盘事实。'}

你是晚会上的【数据员】。今日收盘数据：
${market}
${sectors}
请客观整理今日盘面实际表现（涨跌停、上证趋势、情绪冷热）与今日实际走强的板块，2-4 条要点，只陈述事实。中文、简短。`;
}

// 晚会·分析师：对照早会研判（含板块预测）逐条判断对错
export function buildEveningAnalysisPrompt(persona: string, morning: string | null, dataOut: string): string {
  return `${persona || '你是分析师，对照预测与实际，客观判断对错。'}

你是晚会上的【分析师】，负责复盘。今日早会的研判与板块预测如下：
${morning || '（今日无早会记录）'}
今日实际表现（数据员整理）：
${dataOut}
请逐条对照判断：早会的大盘研判是否成立？早会预测「今日可能走强的板块」哪些命中、哪些落空？给出对/错判断与简短依据。中文、分点。`;
}

// 晚会·复盘员：总结经验、是否调原则
export function buildEveningReviewPrompt(
  persona: string,
  rulebook: string,
  analysisOut: string,
  ops: Array<{ stock_code: string; one_liner: string }>
): string {
  const opsText = ops.length ? ops.map((o) => `- ${o.stock_code}：${o.one_liner}`).join('\n') : '（今日无分析/操作记录）';
  return `${persona || '你负责复盘总结与规则优化建议。'}

你是晚会上的【复盘员】。分析师的对错判断：
${analysisOut}
今日的分析/操作：
${opsText}
${rulebook}
请总结今日经验教训，并判断是否建议调整核心原则；如建议，明确指出改哪条、怎么改（用户将另行确认）。中文、分点、简短。`;
}

// 晚会·来财综合：明确早会哪些对哪些错（含板块预测命中与否），总结
export function buildEveningSynthPrompt(
  persona: string,
  market: string,
  morning: string | null,
  dataOut: string,
  analysisOut: string,
  reviewOut: string,
  directives?: string
): string {
  return `${persona}
${directives ? `\n${directives}\n` : ''}
你是主 agent「来财」，正在主持盘后【晚会】复盘。子助手已分别汇报：
〖数据员·今日实际〗${dataOut}
〖分析师·对错判断〗${analysisOut}
〖复盘员·总结建议〗${reviewOut}
今日早会的研判与板块预测：
${morning || '（今日无早会记录）'}
${market}

请综合给出今日复盘结论：
1）今日早会研判是否成立（成功/失败，结合收盘）；
2）**早会预测的板块走强，哪些命中、哪些落空**——逐个点评对错；
3）今日经验总结，以及是否建议调整核心原则。
并说明你主要采纳了哪位子助手的哪条结论。中文、分点输出。

若你引用了上面某几条新闻作为研判依据，请在回答最后另起一行输出：__ADOPT__ 逗号分隔的编号（如 __ADOPT__ N1,N3）；没有引用就不要输出该行。`;
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
  fetchNews?: () => Promise<void>;
}

// 早会 = 多 agent 讨论：数据员→分析师→情绪面 三位子助手分别汇报，来财综合研判并指出依据。
export async function generateMorning(userId: string, opts: GenOpts = {}): Promise<any> {
  // 1. 采集新闻入双日志
  await (opts.fetchNews ? opts.fetchNews() : refreshNews(userId).then(() => {}).catch(() => {}));

  const persona = getCorePersona(userId);
  const mkt = marketText();
  const rbText = rulebookText(userId);
  const sec = await sectorText(userId);
  const { text: news, idMap } = buildMorningNewsWithIds();
  const aiCall = opts.aiCall || ((p: string, role: string) => defaultAiCall(userId, p, role));

  const dataOut = (await aiCall(buildMorningDataPrompt(personaOf(userId, 'data'), mkt.text, sec.text, news), 'data')).trim();
  const analysisOut = (await aiCall(buildMorningAnalysisPrompt(personaOf(userId, 'analysis'), mkt.text, rbText, dataOut), 'analysis')).trim();
  const qualOut = (await aiCall(buildMorningQualPrompt(personaOf(userId, 'qualitative'), mkt.text, sec.text, news), 'qualitative')).trim();
  const rawCoreOut = (await aiCall(buildMorningSynthPrompt(persona, mkt.text, rbText, dataOut, analysisOut, qualOut, skillDirectives(userId)), 'core')).trim();

  // 2. 解析 __ADOPT__，标记并留痕
  const { tags, clean: coreOut } = parseAdopt(rawCoreOut);
  const adoptedIds = tags.map((t) => idMap[t]).filter(Boolean);
  markAdopted(adoptedIds);
  const adopted_news = adoptedIds.map((id) => ({ content_id: id, title: getContent(id)?.title || '' }));

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

  return upsert(userId, 'morning', content, { market: mkt.data, sectors: sec.sectors, discussion: { data: dataOut, analysis: analysisOut, qualitative: qualOut, core: coreOut }, adopted_news });
}

// 晚会 = 多 agent 复盘讨论：数据员(今日实际)→分析师(对错判断)→复盘员(总结建议)→来财综合。
export async function generateEvening(userId: string, opts: GenOpts = {}): Promise<any> {
  // 1. 采集新闻入双日志
  await (opts.fetchNews ? opts.fetchNews() : refreshNews(userId).then(() => {}).catch(() => {}));

  const persona = getCorePersona(userId);
  const mkt = marketText();
  const rbText = rulebookText(userId);
  const sec = await sectorText(userId);
  const { text: news, idMap } = buildNewsWithIds();
  const morning = getMorningOfToday(userId)?.content ?? null;
  const ops = todaysReports(userId);
  const aiCall = opts.aiCall || ((p: string, role: string) => defaultAiCall(userId, p, role));

  const dataOut = (await aiCall(buildEveningDataPrompt(personaOf(userId, 'data'), mkt.text, sec.text), 'data')).trim();
  const analysisOut = (await aiCall(buildEveningAnalysisPrompt(personaOf(userId, 'analysis'), morning, dataOut), 'analysis')).trim();
  const reviewOut = (await aiCall(buildEveningReviewPrompt(personaOf(userId, 'review'), rbText, analysisOut, ops), 'review')).trim();
  const rawCoreOut = (await aiCall(buildEveningSynthPrompt(persona, mkt.text, morning, dataOut, analysisOut, reviewOut, skillDirectives(userId)), 'core')).trim();

  // 2. 解析 __ADOPT__，标记并留痕
  const { tags, clean: coreOut } = parseAdopt(rawCoreOut);
  const adoptedIds = tags.map((t) => idMap[t]).filter(Boolean);
  markAdopted(adoptedIds);
  const adopted_news = adoptedIds.map((id) => ({ content_id: id, title: getContent(id)?.title || '' }));

  const content = [
    `🗣 晚会复盘 · ${today()}`,
    '',
    '【数据员】今日实际表现：',
    dataOut,
    '',
    '【分析师】早会研判/板块预测对错：',
    analysisOut,
    '',
    '【复盘员】经验总结与原则建议：',
    reviewOut,
    '',
    '———',
    '🧠 来财复盘结论：',
    coreOut,
  ].join('\n');

  return upsert(userId, 'evening', content, { market: mkt.data, sectors: sec.sectors, ops, discussion: { data: dataOut, analysis: analysisOut, review: reviewOut, core: coreOut }, adopted_news });
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
