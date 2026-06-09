import api from './client';

export interface ProxyConfig {
  enabled: boolean;
  scheme: 'http' | 'socks5';
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface StockSnapshot {
  code: string;
  name: string | null;
  date: string;
  roe_ttm: number | null;
  pe: number | null;
  pb: number | null;
  ps: number | null;
  net_profit: number | null;
  turnover_rate: number | null;
  ma20: number | null;
  ma60: number | null;
  year_high: number | null;
  close: number | null;
  limit_up_count: number | null;
  limit_down_count: number | null;
  sse_ma20_slope: number | null;
  realtime?: { price: number; time: string; source: string | null } | null;
  _missing: string[];
  sources?: {
    quote: { source: string; date: string; fetched_at: string } | null;
    fundamentals: { source: string; date: string; fetched_at: string } | null;
    market: { source: string; date: string; fetched_at: string } | null;
    sidecarBase: string | null;
  };
}

export interface DataSource {
  id: string;
  name: string;
  base_url: string;
  builtin: number;
  priority: number;
  enabled: number;
}

export interface NewsItem {
  title: string;
  summary: string;
  published_at: string;
  fetched_at: string;
}

export const dataApi = {
  getNews: () => api.get<{ data: NewsItem[] }>('/data/news'),
  refreshNews: () => api.post<{ data: { inserted: number; news: NewsItem[] } }>('/data/news/refresh'),
  newsLog: (limit = 50) => api.get('/data/news/log?limit=' + limit).then((r) => r.data.data as Array<{ id: string; content_id: string; title: string; source: string; collected_at: string; adopted: number }>),
  newsContent: (id: string) => api.get('/data/news/content/' + id).then((r) => r.data.data as { title: string; content: string; source: string; collected_at: string; adopted: number }),
  stockSearch: (q: string) => api.get<{ data: Array<{ code: string; name: string }> }>(`/data/stocks/search?q=${encodeURIComponent(q)}`),
  probe: (kind = 'quote') => api.get('/data/probe?kind=' + kind).then((r) => r.data.data as Array<{ key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null }>),
  probeList: (kind = 'quote') => api.get('/data/probe/list?kind=' + kind).then((r) => r.data.data as Array<{ key: string; label: string }>),
  probeOne: (kind: string, provider: string) => api.get(`/data/probe?kind=${kind}&provider=${provider}`).then((r) => (r.data.data[0] || null) as { key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null } | null),
  runJob: (job: 'stock_universe' | 'eod') => api.post(`/data/${job}/run`).then((r) => r.data),
  jobStatus: (job: 'stock_universe' | 'eod') => api.get(`/data/${job}/status`).then((r) => r.data.data),
  cancelJob: (job: 'stock_universe' | 'eod') => api.post(`/data/${job}/cancel`).then((r) => r.data),
  forceStopJob: (job: 'stock_universe' | 'eod') => api.post(`/data/${job}/force-stop`).then((r) => r.data),
  tdxTestServers: () => api.get('/data/tdx/servers/test').then((r) => r.data.data.servers as Array<{ site: string; addr: string; port: number; ok: boolean; latency_ms: number | null }>),
  tdxGetServer: () => api.get('/data/tdx/server').then((r) => r.data.data.server as string),
  tdxSetServer: (addr: string, port: number) => api.post('/data/tdx/server', { addr, port }).then((r) => r.data.data.server as string),
  getProxy: () => api.get('/data/proxy').then((r) => r.data.data as { config: ProxyConfig; live: any }),
  setProxy: (cfg: ProxyConfig) => api.post('/data/proxy', cfg).then((r) => r.data.data as { config: ProxyConfig; live: any }),
  testProxy: (cfg?: ProxyConfig) => api.post('/data/proxy/test', cfg || {}).then((r) => r.data.data as { ok: boolean; latency_ms: number; source: string | null; error: string | null }),
  jobLog: (job: 'stock_universe' | 'eod') => api.get(`/data/${job}/log`).then((r) => r.data.data as Array<{ ts: string; level: string; message: string }>),
  listSources: () => api.get<{ data: DataSource[] }>('/data/sources'),
  catalog: () => api.get<{ data: Array<{ name: string; base_url: string; note: string }> }>('/data/sources/catalog'),
  addSource: (name: string, baseUrl: string) => api.post('/data/sources', { name, base_url: baseUrl }),
  updateSource: (id: string, body: { enabled?: 0 | 1; priority?: number; name?: string; base_url?: string }) => api.put(`/data/sources/${id}`, body),
  deleteSource: (id: string) => api.delete(`/data/sources/${id}`),
  getSource: () => api.get<{ data: { sidecarConfigured: boolean; base: string | null; sidecarHealthy: boolean } }>('/data/source'),
  snapshot: (code: string) => api.get<{ data: StockSnapshot }>(`/data/snapshot/${code}`),
  refresh: (code?: string) => api.post<{ data: { marketRefreshed: boolean; snapshot: StockSnapshot | null } }>('/data/refresh', { code }),
  uploadCsv: (file: File, code?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    const qs = code ? `?code=${encodeURIComponent(code)}` : '';
    return api.post<{ data: { inserted: number; codes: string[] } }>(`/data/quotes/csv${qs}`, fd);
  },
  tradeCalendar: (year: number, month: number) =>
    api
      .get(`/data/trade-calendar?year=${year}&month=${month}`)
      .then((r) => r.data.data as { year: number; month: number; days: Array<{ date: string; trading: boolean }> }),
};
