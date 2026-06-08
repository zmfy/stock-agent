import { getCachedName, findStockCodeInText } from '../data/service';

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
