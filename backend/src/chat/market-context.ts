import { getCachedName, findStockCodeInText, Bar, ensureStockBars, getStockSnapshot } from '../data/service';
import { StockSnapshot } from '../types';

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
    return ''; // index：后续任务实现
  } catch {
    return '';
  }
}

function n2(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : (Math.round(x * 100) / 100).toString();
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
