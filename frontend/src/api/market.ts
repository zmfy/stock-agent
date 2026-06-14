import api from './client';

export interface IndexStatus { name: string; code: string; point: number | null; prevClose: number | null; changePct: number | null; basis: '实时' | '收盘' }
export interface MarketAlert { level: 'error' | 'warn'; source: string; message: string }
export interface MarketStatus { updatedAt: string | null; indices: IndexStatus[]; limitUp: number | null; limitDown: number | null; sentimentDate: string | null; sentimentSlope: number | null; sentimentFetchedAt: string | null; sentimentSource: string | null; alerts: MarketAlert[]; alertLevel: 'error' | 'warn' | null }

export const marketApi = {
  status: () => api.get<{ data: MarketStatus }>('/market/status'),
};
