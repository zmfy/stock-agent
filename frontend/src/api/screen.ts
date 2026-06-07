import api from './client';

export interface ScreenResult {
  code: string;
  name: string | null;
  aPass: boolean;
  bPass: boolean;
  passed: number;
  total: number;
  failed: string[];
  reason?: string;
}

export interface ScreenRun {
  note: string;
  results: ScreenResult[];
  discussion?: string;
  created_at?: string;
}

export const screenApi = {
  run: (body: { codes?: string[]; top?: number } = {}) => api.post<{ data: ScreenRun }>('/screen/run', body),
  latest: () => api.get<{ data: ScreenRun | null }>('/screen/latest'),
  history: (limit = 20) => api.get('/screen/history?limit=' + limit).then((r) => r.data.data as Array<{ created_at: string; note: string; picks: Array<{ code: string; name: string | null; reason: string }> }>),
};
