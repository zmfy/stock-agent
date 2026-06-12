import { getRealtime, inTradingSession, MARKET_INDICES } from './service';
import { getDataAlerts, Alert, SidecarState, AlertLevel } from './alerts';

export interface IndexStatus {
  name: string;
  code: string;
  point: number | null;
  prevClose: number | null;
  changePct: number | null;
  basis: '实时' | '收盘';
}
export interface MarketStatus {
  updatedAt: string | null;
  indices: IndexStatus[];
  alerts: Alert[];
  alertLevel: AlertLevel | null;
}

function cnDate(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return String(ts).slice(0, 10);
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function beijingDate(nowMs: number): string {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function getMarketStatus(nowMs: number, sidecar: SidecarState): MarketStatus {
  const session = inTradingSession(nowMs);
  const today = beijingDate(nowMs);
  let updatedAt: string | null = null;

  const indices: IndexStatus[] = MARKET_INDICES.map((d) => {
    const r = getRealtime(d.key) as any;
    if (!r || r.price == null) {
      return { name: d.name, code: d.key, point: null, prevClose: null, changePct: null, basis: '收盘' as const };
    }
    if (r.fetched_at && (!updatedAt || r.fetched_at > updatedAt)) updatedAt = r.fetched_at;
    // 「实时」仅在盘中 且 缓存行是今天(北京日期)取的；否则为昨日收盘或更旧数据。
    const isToday = cnDate(r.fetched_at) === today;
    const prev = r.prev_close ?? null;
    const changePct = prev ? ((r.price - prev) / prev) * 100 : null;
    return {
      name: d.name,
      code: d.key,
      point: r.price,
      prevClose: prev,
      changePct,
      basis: session && isToday ? '实时' : '收盘',
    };
  });

  const alerts = getDataAlerts(sidecar, today);
  const alertLevel: AlertLevel | null = alerts.some((a) => a.level === 'error')
    ? 'error'
    : alerts.some((a) => a.level === 'warn')
      ? 'warn'
      : null;

  return { updatedAt, indices, alerts, alertLevel };
}
