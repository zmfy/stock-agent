import api from './client';

export interface ScheduleConfig {
  prejudgeTime: string;
  intradayInterval: number;
  reviewTime: string;
  holidayBriefTime: string;
}
export type StrategyPhase = 'prejudge' | 'intraday' | 'review' | 'holiday';
export interface StrategyEntry { content: string; updatedAt: string }
export interface StrategyToday {
  date: string;
  isTradingDay: boolean;
  phase: StrategyPhase;
  prejudge: StrategyEntry | null;
  review: StrategyEntry | null;
  holiday: StrategyEntry | null;
  intraday: Array<{ content: string; createdAt: string }>;
}
export interface StrategyHistoryRow {
  date: string;
  phase: StrategyPhase;
  content: string;
  created_at: string;
  updated_at: string;
}
export const strategyApi = {
  getSchedule: () => api.get<{ data: { config: ScheduleConfig } }>('/strategy/schedule'),
  setSchedule: (cfg: Partial<ScheduleConfig>) => api.put<{ data: { config: ScheduleConfig } }>('/strategy/schedule', cfg),
  today: () => api.get<{ data: StrategyToday }>('/strategy/today'),
  generate: (phase: StrategyPhase) => api.post<{ data: { content: string } }>(`/strategy/generate/${phase}`),
  history: () => api.get<{ data: StrategyHistoryRow[] }>('/strategy/history'),
};
