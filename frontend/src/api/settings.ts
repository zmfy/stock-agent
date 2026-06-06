import api from './client';

export interface AdminUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
}

export interface InviteCode {
  code: string;
  created_by: string | null;
  used_by: string | null;
  used_at: string | null;
  expires_at: string | null;
}

export const settingsApi = {
  getUsers: () => api.get<{ data: AdminUser[] }>('/settings/users'),
  createInvite: () => api.post<{ data: { code: string; expiresAt: string } }>('/settings/users/invite'),
  listInvites: () => api.get<{ data: InviteCode[] }>('/settings/users/invites'),
  updateRole: (id: string, role: 'admin' | 'user') => api.put(`/settings/users/${id}/role`, { role }),
  resetPassword: (id: string, password: string) => api.put(`/settings/users/${id}/password`, { password }),
  deleteUser: (id: string) => api.delete(`/settings/users/${id}`),
};
