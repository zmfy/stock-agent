// 时间显示统一锁定北京时区。
// DB 的 CURRENT_TIMESTAMP 存的是 UTC（"YYYY-MM-DD HH:MM:SS"，无时区标记），
// Node 的 ISO 串带 "Z"。这里统一解析为 UTC，再格式化为 Asia/Shanghai，
// 无论浏览器/服务器在哪个时区，显示恒为北京时间。
const TZ = 'Asia/Shanghai';

function toDate(ts: string): Date | null {
  let s = ts.includes('T') ? ts : ts.replace(' ', 'T');
  // 末尾无时区标记（Z 或 ±HH:MM）则按 UTC 处理
  if (!/[Zz]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 把 DB 的 UTC 时间串显示成北京时间。date/time 控制粒度，空值返回「—」。 */
export function fmtCN(ts?: string | null, opts: { date?: boolean; time?: boolean } = {}): string {
  const { date = true, time = true } = opts;
  if (!ts) return '—';
  const d = toDate(ts);
  if (!d) return ts;
  return d.toLocaleString('zh-CN', {
    timeZone: TZ,
    hour12: false,
    ...(date ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** 仅日期（北京） */
export const fmtCNDate = (ts?: string | null) => fmtCN(ts, { time: false });

/** 当前北京日历日 YYYY-MM-DD（用于「今天」比较） */
export const beijingToday = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** 把一个 DB UTC 时间串转成它的北京日历日 YYYY-MM-DD（无效返回空串） */
export function beijingDateOf(ts?: string | null): string {
  if (!ts) return '';
  const d = toDate(ts);
  return d ? d.toLocaleDateString('en-CA', { timeZone: TZ }) : '';
}
