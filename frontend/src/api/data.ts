import api from './client';

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
  stockSearch: (q: string) => api.get<{ data: Array<{ code: string; name: string }> }>(`/data/stocks/search?q=${encodeURIComponent(q)}`),
  stockSyncStatus: () => api.get<{ data: { state: string; total: number; done: number; message: string; count: number; updated_at?: string } }>('/data/stocks/sync-status'),
  stockSync: () => api.post('/data/stocks/sync'),
  eodStatus: () => api.get<{ data: { state: string; total: number; done: number; message: string; updated_at?: string; source_breakdown?: Record<string, number> | null } }>('/data/eod/status'),
  probe: (kind = 'quote') => api.get('/data/probe?kind=' + kind).then((r) => r.data.data as Array<{ key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null }>),
  eodIngest: (days?: number, codes?: string[]) => api.post('/data/eod/ingest', { days, codes }),
  listSources: () => api.get<{ data: DataSource[] }>('/data/sources'),
  catalog: () => api.get<{ data: Array<{ name: string; base_url: string; note: string }> }>('/data/sources/catalog'),
  addSource: (name: string, baseUrl: string) => api.post('/data/sources', { name, baseUrl }),
  updateSource: (id: string, body: { enabled?: boolean; priority?: number; name?: string; baseUrl?: string }) => api.put(`/data/sources/${id}`, body),
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
};
