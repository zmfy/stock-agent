import { getEnabledCapabilities } from '../plugins/service';
import { primaryBaseGlobal } from './sources-service';
import { QuoteRow } from '../types';

// Resolve the primary data source: global sources first, then the akshare-data plugin (back-compat).
// userId may be empty string (cron context) — global primary works without a userId.
export function resolveSidecarBase(userId: string): string | null {
  const fromSources = primaryBaseGlobal();
  if (fromSources) return fromSources;
  if (userId) {
    const caps = getEnabledCapabilities(userId);
    const ak = caps.mcp.find((m) => m.key === 'akshare-data');
    const url = ak?.config?.url;
    if (typeof url === 'string' && url) return url.replace(/\/+$/, '');
  }
  return null;
}

async function getJson(url: string): Promise<any | null> {
  try {
    // bound it so a blocked/slow data source never hangs the app
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function fetchFundamentals(base: string, code: string, order?: string[]): Promise<{ source: string | null; data: Record<string, unknown> } | null> {
  const d = await getJson(`${base}/fundamentals/${code}${order && order.length ? `?order=${order.join(',')}` : ''}`);
  const data = d?.data ?? (d && !('source' in d) ? d : null);   // 兼容旧裸对象
  if (!data) return null;
  return { source: d?.source ?? null, data };
}

export interface ProbeResult { key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null }

export async function probe(base: string, kind: string): Promise<ProbeResult[]> {
  const data = await getJson(`${base}/probe?kind=${encodeURIComponent(kind)}`);
  if (!Array.isArray(data)) return [];
  return data.map((p: any) => ({
    key: String(p.key), label: String(p.label ?? p.key),
    reachable: !!p.reachable, latencyMs: p.latency_ms == null ? null : Number(p.latency_ms),
    error: p.error == null ? null : String(p.error),
  }));
}

export async function orderedProviders(base: string, kind: string): Promise<string[]> {
  const res = await probe(base, kind);
  return res.filter((p) => p.reachable).sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9)).map((p) => p.key);
}

function qs(order?: string[]): string {
  return order && order.length ? `&order=${order.join(',')}` : '';
}

export async function fetchQuotes(base: string, code: string, days = 120, order?: string[]): Promise<{ source: string | null; rows: QuoteRow[] } | null> {
  const data = await getJson(`${base}/quote/${code}?days=${days}${qs(order)}`);
  const arr = Array.isArray(data) ? data : data?.rows;     // 兼容旧裸数组
  if (!Array.isArray(arr)) return null;
  const source = Array.isArray(data) ? null : (data?.source ?? null);
  return {
    source,
    rows: arr.map((r: any) => ({ code, date: String(r.date), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume) })),
  };
}

export async function fetchMarket(base: string, order?: string[]): Promise<{ source: string | null; data: { limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null } } | null> {
  const d = await getJson(`${base}/market/sentiment${order && order.length ? `?order=${order.join(',')}` : ''}`);
  const data = d?.data ?? (d && !('source' in d) ? d : null);   // 兼容旧裸对象
  if (!data) return null;
  return { source: d?.source ?? null, data: { limit_up_count: num(data.limit_up_count), limit_down_count: num(data.limit_down_count), sse_ma20_slope: num(data.sse_ma20_slope) } };
}

export async function fetchNews(base: string, limit = 20, order?: string[]): Promise<{ source: string | null; rows: Array<{ title: string; summary: string; published_at: string }> } | null> {
  const d = await getJson(`${base}/news?limit=${limit}${order && order.length ? `&order=${order.join(',')}` : ''}`);
  const arr = Array.isArray(d) ? d : d?.rows;
  if (!Array.isArray(arr)) return null;
  return { source: Array.isArray(d) ? null : (d?.source ?? null), rows: arr.map((n: any) => ({ title: String(n.title ?? ''), summary: String(n.summary ?? ''), published_at: String(n.published_at ?? '') })).filter((n) => n.title) };
}

export async function fetchAllStocks(base: string): Promise<Array<{ code: string; name: string; py: string }> | null> {
  const data = await getJson(`${base}/stocks`);
  if (!Array.isArray(data)) return null;
  return data
    .map((s: any) => ({ code: String(s.code ?? '').replace(/^(sh|sz)/i, ''), name: String(s.name ?? ''), py: String(s.py ?? '') }))
    .filter((s) => s.code && s.name);
}

export async function fetchName(base: string, code: string): Promise<string | null> {
  const data = await getJson(`${base}/name/${code}`);
  return data && typeof data.name === 'string' ? data.name : null;
}

export async function fetchHotSectors(base: string, top = 5): Promise<string[] | null> {
  const data = await getJson(`${base}/sectors/hot?top=${top}`);
  if (!Array.isArray(data)) return null;
  return data.map((s: any) => String(s.name ?? s)).filter(Boolean);
}

export async function fetchSectorStocks(base: string, name: string): Promise<string[] | null> {
  const data = await getJson(`${base}/sectors/${encodeURIComponent(name)}/cons`);
  if (!Array.isArray(data)) return null;
  return data.map((c: any) => String(c.code ?? c).replace(/^(sh|sz)/i, '')).filter(Boolean);
}

export async function pingHealth(base: string): Promise<boolean> {
  try {
    const resp = await fetch(`${base}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof n === 'number' && isFinite(n) ? n : null;
}
