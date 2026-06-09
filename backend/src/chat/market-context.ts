import { getCachedName, findStockCodeInText, Bar, ensureStockBars, getStockSnapshot, ensureIndexBars, getMarketSentimentSeries } from '../data/service';
import { lastTradingDayBefore } from '../data/trade-calendar';
import { StockSnapshot } from '../types';

// 北京日历日（YYYY-MM-DD）。
function beijingToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}
// 当前「应当已有收盘数据的最近交易日」= 严格早于今日的最近交易日（今日盘中/未收盘不强求）。
export function expectedLatestTradingDay(): string {
  return lastTradingDayBefore(beijingToday());
}

export const RECENT_BARS_N = 30;
export const MAX_BARS_N = 500;

export type Target = { kind: 'stock'; code: string } | { kind: 'index'; code: string };

// 中文时间词 → 交易日数。从长到短匹配。
const TIME_RULES: Array<[RegExp, number]> = [
  [/两年|近两年|过去两年/, 480],
  [/一年|近一年|今年以来|过去一年/, 250],
  [/半年|近半年|六个月|6个月/, 120],
  [/三月|近三月|一季度|季度|三个月|3个月/, 66],
  [/两月|近两月|两个月/, 44],
  [/一月|近一月|本月|一个月|近30天|30天/, 22],
  [/两周|半个月|半月/, 10],
  [/一周|近一周|上周|本周|近7天|7天/, 5],
  [/昨天|今天|前天|这几天|最近几天|近几天/, 5],
];

export function parseTimeWindow(message: string): number {
  for (const [re, n] of TIME_RULES) {
    if (re.test(message)) return Math.min(n, MAX_BARS_N);
  }
  return RECENT_BARS_N;
}

const INDEX_RULES: Array<[RegExp, string]> = [
  [/深成指|深证成指|深证/, '399001'],
  [/创业板指|创业板/, '399006'],
  [/大盘|上证|沪指|A股|a股|指数/, '000001'],
];

export function detectTarget(message: string, sessionRefId: string | null): Target | null {
  for (const [re, code] of INDEX_RULES) {
    if (re.test(message)) return { kind: 'index', code };
  }
  const m = message.match(/\d{6}/);
  if (m && getCachedName(m[0])) return { kind: 'stock', code: m[0] };
  const byName = findStockCodeInText(message);
  if (byName) return { kind: 'stock', code: byName };
  if (sessionRefId) return { kind: 'stock', code: sessionRefId };
  return null;
}

// 编排：据消息解析目标+窗口 → 取数 → 组装。本任务只处理 stock 分支（index 分支留待后续）。
export async function buildMarketInjection(
  userId: string,
  sessionKind: string,
  sessionRefId: string | null,
  message: string
): Promise<string> {
  const refId = sessionKind === 'stock' ? sessionRefId : null;
  const target = detectTarget(message, refId);
  if (!target) return '';
  const n = parseTimeWindow(message);
  try {
    if (target.kind === 'stock') {
      // 先取快照：本地行情浅时它会深取至多 250 根入库；随后 ensureStockBars 多半命中本地、
      // 不再二次联网（避免「ensureStockBars 取 N + 快照又取 250」的重复取数）。
      const snap = await getStockSnapshot(userId, target.code).catch(() => null);
      const bars = await ensureStockBars(userId, target.code, n);
      return buildStockContext(target.code, snap, bars);
    }
    // index
    const expected = expectedLatestTradingDay();
    const ibars = await ensureIndexBars(userId, target.code, n, { freshThrough: expected });
    const sent = getMarketSentimentSeries(Math.min(n, 30));
    return buildIndexContext(target.code, ibars, sent, expected);
  } catch {
    return '';
  }
}

function n2(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : (Math.round(x * 100) / 100).toString();
}

interface Sentiment { date: string; limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null }

export function buildIndexContext(code: string, bars: Bar[], sentiment: Sentiment[], expectedLatest?: string): string {
  const name = code === '000001' ? '上证指数' : code === '399001' ? '深证成指' : code === '399006' ? '创业板指' : code;
  const parts: string[] = [`【大盘 ${name}(${code})】`];
  // 新鲜度判定：取 bars / sentiment 里最新的日期，若早于「应有的最近交易日」则明确告知数据陈旧、不可冒充最新。
  if (expectedLatest) {
    const latestBar = bars.length ? bars[bars.length - 1].date : '';
    const latestSent = sentiment.length ? sentiment[sentiment.length - 1].date : '';
    const latest = [latestBar, latestSent].filter(Boolean).sort().pop() || '';
    if (!latest) {
      parts.push(`⚠️ 暂时取不到大盘数据(数据源不可达)。请勿臆造点位；如需最新，请稍后重试或在「数据」页测速选用通达信服务器。`);
    } else if (latest < expectedLatest) {
      parts.push(`⚠️ 未取到最新行情(数据源暂不可达)。以下为截至 ${latest} 的数据，并非最新交易日(${expectedLatest})；回答时务必说明数据截止到 ${latest}，不要把它当作最新一天。`);
    }
  }
  if (bars.length) {
    parts.push('日期│收│涨跌幅');
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      const prev = i > 0 ? bars[i - 1].close : null;
      const pct = c != null && prev ? `${(((c - prev) / prev) * 100).toFixed(2)}%` : '—';
      parts.push(`${bars[i].date}│${n2(c)}│${pct}`);
    }
    parts.push(`以上为 ${name} 最近 ${bars.length} 个交易日点位(截至 ${bars[bars.length - 1].date});更早数据本地暂未提供。`);
  }
  if (sentiment.length) {
    const s = sentiment.map((x) => `${x.date}: 涨停${x.limit_up_count ?? '—'}/跌停${x.limit_down_count ?? '—'}/上证20线斜率${n2(x.sse_ma20_slope)}`);
    parts.push('近期情绪(涨跌停家数/上证20日线斜率):', ...s);
  }
  // 仅有标题(无数据、无警告)才返回空；若已加陈旧/取不到的警告则保留输出。
  if (parts.length <= 1) return '';
  return parts.join('\n');
}

export function buildStockContext(code: string, snapshot: StockSnapshot | null, bars: Bar[]): string {
  if (!bars.length && !snapshot) return '';
  const head = snapshot
    ? `【${code} ${snapshot.name ?? ''}】现价 ${n2(snapshot.close)}｜MA20 ${n2(snapshot.ma20)}｜MA60 ${n2(snapshot.ma60)}｜PE ${n2(snapshot.pe)}｜PB ${n2(snapshot.pb)}｜ROE ${n2(snapshot.roe_ttm)}%｜年内高 ${n2(snapshot.year_high)}`
    : `【${code}】`;
  const tableHead = '日期│开│高│低│收│量';
  const rows = bars.map((b) => `${b.date}│${n2(b.open)}│${n2(b.high)}│${n2(b.low)}│${n2(b.close)}│${n2(b.volume)}`);
  const note = bars.length
    ? `以上为 ${code} 最近 ${bars.length} 个交易日日线(截至 ${bars[bars.length - 1].date});更早数据本地暂未提供。这些数字系统已算好，请勿臆造窗口外数据。`
    : '本地暂无该股历史行情，可在「数据」页同步后再问。';
  return [head, tableHead, ...rows, note].join('\n');
}
