import api from './client';

export interface GateResult {
  gate_key: string;
  label: string;
  system: 'A' | 'B';
  field: string;
  op: string;
  threshold: number | null;
  threshold2: number | null;
  ref_field: string | null;
  unit: string;
  veto: number;
  actual: number | null;
  status: 'pass' | 'fail' | 'unknown';
  teach: string;
}

export interface AnalysisReport {
  id: string;
  stock_code: string;
  stock_name: string | null;
  rulebook_version_id: string | null;
  data_date: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  gate_results: GateResult[];
  a_conclusion: string;
  b_conclusion: string;
  exception_channel: string | null;
  position_suggestion: string;
  one_liner: string;
  teach_notes: Array<{ gate_key: string; note: string }>;
  created_at: string;
  sources?: {
    quote: { source: string; date: string; fetched_at: string } | null;
    fundamentals: { source: string; date: string; fetched_at: string } | null;
    market: { source: string; date: string; fetched_at: string } | null;
    sidecarBase: string | null;
  } | null;
  validation?: { trusted: boolean; authority: string; checks: Array<{ name: string; ok: boolean; detail: string }> } | null;
}

export interface ReportSummary {
  id: string;
  stock_code: string;
  stock_name: string | null;
  one_liner: string;
  ai_model: string | null;
  created_at: string;
}

export const analysisApi = {
  run: (code: string) => api.post<{ data: AnalysisReport }>('/analysis/run', { code }),
  listReports: () => api.get<{ data: ReportSummary[] }>('/analysis/reports'),
  getReport: (id: string) => api.get<{ data: AnalysisReport }>(`/analysis/reports/${id}`),
  getLatestByCode: (code: string) => api.get<{ data: AnalysisReport }>(`/analysis/reports/by-code/${code}`),
};
