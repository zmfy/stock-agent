import api from './client';

export interface IndexStatus { name: string; code: string; point: number | null; prevClose: number | null; changePct: number | null; basis: '实时' | '收盘' }
export interface MarketAlert { level: 'error' | 'warn'; source: string; message: string }
export interface MarketStatus { updatedAt: string | null; indices: IndexStatus[]; alerts: MarketAlert[]; alertLevel: 'error' | 'warn' | null }

export const marketApi = {
  status: () => api.get<{ data: MarketStatus }>('/market/status'),
};
