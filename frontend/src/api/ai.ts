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
  is_active: number;
  apiKeySet: boolean;
  apiKeyMasked: string;
}

export const aiApi = {
  getProviders: () => api.get<{ data: ProviderDef[] }>('/ai/providers'),
  getConfigs: () => api.get<{ data: AiConfig[] }>('/ai/configs'),
  getActive: () => api.get<{ data: { provider: string; model: string } | null }>('/ai/active'),
  saveConfig: (provider: string, body: { apiKey?: string; baseUrl: string; model: string }) =>
    api.put(`/ai/configs/${provider}`, body),
  activate: (provider: string) => api.post(`/ai/configs/${provider}/activate`),
  remove: (provider: string) => api.delete(`/ai/configs/${provider}`),
  test: (provider: string, body: { apiKey?: string; baseUrl?: string; model?: string }) =>
    api.post<{ data: { ok: boolean; reply?: string; error?: string } }>(`/ai/configs/${provider}/test`, body),
};
