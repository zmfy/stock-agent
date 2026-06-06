import api from './client';

export interface AgentProfile {
  role: string;
  label: string;
  persona: string;
  generated: boolean;
}

export const agentApi = {
  getProfiles: () => api.get<{ data: AgentProfile[] }>('/agent/profiles'),
  setProfile: (role: string, persona: string) => api.put(`/agent/profiles/${role}`, { persona }),
  generateSubs: () => api.post<{ data: Array<{ role: string; persona: string }> }>('/agent/profiles/generate-subs'),
};
