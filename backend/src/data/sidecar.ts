import { getEnabledCapabilities } from '../plugins/service';
import { primaryBase } from './sources-service';
import { QuoteRow } from '../types';

// Resolve the primary data source: data-source manager first, then the akshare-data plugin (back-compat).
export function resolveSidecarBase(userId: string): string | null {
  const fromSources = primaryBase(userId);
  if (fromSources) return fromSources;
  const caps = getEnabledCapabilities(userId);
  const ak = caps.mcp.find((m) => m.key === 'akshare-data');
  const url = ak?.config?.url;
  return typeof url === 'string' && url ? url.replace(/\/+$/, '') : null;
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

export async function fetchFundamentals(base: string, code: string): Promise<Record<string, unknown> | null> {
  return getJson(`${base}/fundamentals/${code}`);
}

export async function fetchQuotes(base: string, code: string, days = 120): Promise<QuoteRow[] | null> {
  const data = await getJson(`${base}/quote/${code}?days=${days}`);
  if (!Array.isArray(data)) return null;
  return data.map((r: any) => ({
    code,
    date: String(r.date),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume: num(r.volume),
  }));
}

export async function fetchMarket(base: string): Promise<{ limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null } | null> {
  const data = await getJson(`${base}/market/sentiment`);
  if (!data) return null;
  return {
    limit_up_count: num(data.limit_up_count),
    limit_down_count: num(data.limit_down_count),
    sse_ma20_slope: num(data.sse_ma20_slope),
  };
}

export async function fetchNews(base: string, limit = 20): Promise<Array<{ title: string; summary: string; published_at: string }> | null> {
  const data = await getJson(`${base}/news?limit=${limit}`);
  if (!Array.isArray(data)) return null;
  return data
    .map((n: any) => ({ title: String(n.title ?? ''), summary: String(n.summary ?? ''), published_at: String(n.published_at ?? '') }))
    .filter((n) => n.title);
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
