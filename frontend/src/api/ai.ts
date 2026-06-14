import api from './client';

export interface ProviderDef {
  name: string;
  label: string;
  apiStyle: string;
  needsApiKey: boolean;
  defaultBaseUrl: string;
  baseUrlEditable: boolean;
  models: string[];
  allowCustomModel: boolean;
}

export interface AiConfig {
  provider: string;
  base_url: string;
  model: string;
  enabled: number;
  apiKeySet: boolean;
  apiKeyMasked: string;
  shared?: number;
  shareMaxTokens?: number;
  sharePeriodSeconds?: number;
}

export interface Quota {
  cap: number;
  used: number;
  remaining: number | null;
  periodSeconds: number;
  over: boolean;
}

export interface SharedModel {
  configId: string;
  provider: string;
  model: string;
  label: string;
  enabledForMe: boolean;
  quota: Quota;
}

export interface SharedUsage {
  total: number;
  periodSeconds: number;
  rows: Array<{ userId: string; username: string; calls: number; total_tokens: number }>;
}

export interface RoleAssignment {
  role: string;
  label: string;
  hint: string;
  mode: 'manual' | 'auto';
  pinnedProvider: string | null;
  pinnedModel: string | null;
  pinnedSharedConfigId: string | null;
  resolvedProvider: string | null;
  resolvedModel: string | null;
}

export const aiApi = {
  getProviders: () => api.get<{ data: ProviderDef[] }>('/ai/providers'),
  getConfigs: () => api.get<{ data: AiConfig[] }>('/ai/configs'),
  getActive: () => api.get<{ data: { provider: string; model: string } | null }>('/ai/active'),
  saveConfig: (provider: string, body: { apiKey?: string; baseUrl: string; model: string }) =>
    api.put(`/ai/configs/${provider}`, body),
  setEnabled: (provider: string, enabled: boolean) => api.post(`/ai/configs/${provider}/enable`, { enabled }),
  remove: (provider: string) => api.delete(`/ai/configs/${provider}`),
  test: (provider: string, body: { apiKey?: string; baseUrl?: string; model?: string }) =>
    api.post<{ data: { ok: boolean; reply?: string; error?: string } }>(`/ai/configs/${provider}/test`, body),
  getRoles: () => api.get<{ data: RoleAssignment[] }>('/ai/roles'),
  autoAssignRoles: () => api.post<{ data: RoleAssignment[] }>('/ai/roles/auto-assign'),
  setRole: (role: string, body: { mode: 'manual' | 'auto'; provider?: string | null; model?: string | null; sharedConfigId?: string | null }) =>
    api.put(`/ai/roles/${role}`, body),
  setShared: (provider: string, body: { shared: boolean; maxTokens?: number; periodSeconds?: number }) =>
    api.post(`/ai/configs/${provider}/share`, body),
  getShared: () => api.get<{ data: SharedModel[] }>('/ai/shared'),
  setSharedEnabled: (configId: string, enabled: boolean) => api.post(`/ai/shared/${configId}/enable`, { enabled }),
  getSharedUsage: (configId: string) => api.get<{ data: SharedUsage }>(`/ai/shared/${configId}/usage`),
  resetSharedUsage: (configId: string) => api.post(`/ai/shared/${configId}/reset-usage`),
};
