import { getActive } from '../rulebook/service';
import { refreshNews } from '../data/service';
import { newsTitlesSince } from '../data/news-log';
import { getCorePersona } from '../agent/profiles-service';
import { lastTradingDayBefore } from '../data/trade-calendar';
import { marketText, sectorText, rulebookText, defaultAiCall } from '../meetings/service';
import { beijingDate, recordStrategy, getStrategy, getIntradayTimeline } from './service';

export interface GenStrategyOpts {
  aiCall?: (prompt: string, role?: string) => Promise<string>;
  fetchNews?: () => Promise<void>;
  now?: number;
}

function resolveAi(userId: string, opts: GenStrategyOpts) {
  return opts.aiCall || ((p: string, role = 'core') => defaultAiCall(userId, p, role));
}

function prejudgeNewsText(now: number): string {
  const since = lastTradingDayBefore(beijingDate(now));
  const items = newsTitlesSince(`${since} 00:00:00`);
  if (!items.length) return '（暂无自上一交易日以来的新闻）';
  return items.map((n) => `· ${n.title}`).join('\n');
}

function prejudgePrompt(persona: string, market: string, sectors: string, news: string, rb: string, hasRb: boolean): string {
  return `${persona}\n场景：盘前【策略预判】。基于以下信息，给出今天的操作预判（方向、关注板块、风险点；${hasRb ? '结合用户当前策略' : '无个人策略，仅给大盘/板块层面预判'}）。\n大盘：${market}\n板块：${sectors}\n自上一交易日以来的新闻：\n${news}\n${hasRb ? `用户当前策略：\n${rb}` : ''}\n请用中文给出简洁、可执行的预判：`;
}
function intradayPrompt(persona: string, market: string, sectors: string, rb: string, hasRb: boolean): string {
  return `${persona}\n场景：盘中【实时策略】。总结当前大盘走势与板块热度，并${hasRb ? '结合用户当前策略' : '在大盘/板块层面'}给出用户此刻可能的交易策略。\n大盘：${market}\n板块：${sectors}\n${hasRb ? `用户当前策略：\n${rb}` : ''}\n请用中文给出简洁的盘中小结（这一时点）：`;
}
function reviewPrompt(persona: string, market: string, prejudge: string, intraday: string, rb: string, hasRb: boolean): string {
  return `${persona}\n场景：盘后【复盘】。只复盘今天这个交易日：对照实际行情，复盘今早的「策略预判」与当天的「盘中策略」，总结对错、原因与改进。\n今日大盘：${market}\n今日预判：\n${prejudge || '（今日无预判）'}\n今日盘中时间线：\n${intraday || '（今日无盘中记录）'}\n${hasRb ? `用户当前策略：\n${rb}` : ''}\n请用中文给出复盘（哪些对/错、为什么、下次怎么调整）：`;
}
function holidayPrompt(persona: string, sectors: string, news: string): string {
  return `${persona}\n场景：【休市日快报】。今天休市，无操作。请仅做：① 近期消息面/新闻归纳；② 可能受影响的板块（说明逻辑）。\n板块：${sectors}\n近期新闻：\n${news}\n请用中文给出简洁的休市快报：`;
}

export async function generatePrejudge(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  await (opts.fetchNews ? opts.fetchNews() : refreshNews(userId).then(() => {}).catch(() => {}));
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const sec = await sectorText(userId);
  const rb = rulebookText(userId);
  const hasRb = !!getActive(userId);
  const news = prejudgeNewsText(now);
  const out = (await resolveAi(userId, opts)(prejudgePrompt(persona, mkt.text, sec.text, news, rb, hasRb), 'core')).trim();
  recordStrategy(userId, 'prejudge', out, { market: mkt.data, sectors: sec.sectors }, beijingDate(now));
  return out;
}

export async function generateIntraday(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const sec = await sectorText(userId);
  const rb = rulebookText(userId);
  const hasRb = !!getActive(userId);
  const out = (await resolveAi(userId, opts)(intradayPrompt(persona, mkt.text, sec.text, rb, hasRb), 'core')).trim();
  recordStrategy(userId, 'intraday', out, { market: mkt.data, sectors: sec.sectors }, beijingDate(now));
  return out;
}

export async function generateReview(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const date = beijingDate(now);
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const rb = rulebookText(userId);
  const hasRb = !!getActive(userId);
  const prejudge = getStrategy(userId, date, 'prejudge')?.content ?? '';
  const intraday = getIntradayTimeline(userId, date).map((r: any) => `· ${r.content}`).join('\n');
  const out = (await resolveAi(userId, opts)(reviewPrompt(persona, mkt.text, prejudge, intraday, rb, hasRb), 'core')).trim();
  recordStrategy(userId, 'review', out, { market: mkt.data }, date);
  return out;
}

export async function generateHoliday(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  await (opts.fetchNews ? opts.fetchNews() : refreshNews(userId).then(() => {}).catch(() => {}));
  const persona = getCorePersona(userId);
  const sec = await sectorText(userId);
  const news = prejudgeNewsText(now);
  const out = (await resolveAi(userId, opts)(holidayPrompt(persona, sec.text, news), 'core')).trim();
  recordStrategy(userId, 'holiday', out, { sectors: sec.sectors }, beijingDate(now));
  return out;
}
