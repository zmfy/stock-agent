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
}

export const dataApi = {
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
