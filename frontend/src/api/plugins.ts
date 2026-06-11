import api from './client';

export interface PluginView {
  key: string;
  kind: 'mcp' | 'skill';
  label: string;
  description: string;
  recommended: boolean;
  source: 'builtin' | 'custom';
  transport: 'stdio' | 'http' | null;
  enabled: boolean;
  config: Record<string, any>;
  configHint?: string;
  shared?: boolean;
  owner?: 'me' | 'admin';
  sharedByMe?: boolean;
  configured?: boolean;
}

export const pluginsApi = {
  list: () => api.get<{ data: PluginView[] }>('/plugins'),
  setEnabled: (key: string, enabled: boolean, config?: Record<string, any>) =>
    api.post(`/plugins/${key}/enable`, { enabled, config }),
  addCustom: (body: { key: string; label: string; kind: 'mcp' | 'skill'; transport?: 'stdio' | 'http' | null; config: Record<string, any> }) =>
    api.post('/plugins/custom', body),
  updateConfig: (key: string, config: Record<string, any>) => api.put(`/plugins/${key}/config`, { config }),
  remove: (key: string) => api.delete(`/plugins/${key}`),
  share: (key: string, shared: boolean) => api.post(`/plugins/${key}/share`, { shared }),
  setSharedEnabled: (key: string, enabled: boolean) => api.post(`/plugins/shared/${key}/enable`, { enabled }),
};
