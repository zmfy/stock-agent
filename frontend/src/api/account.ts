import api from './client';

export interface Backup {
  id: string;
  label: string;
  created_at: string;
  size: number;
}

export const accountApi = {
  updateProfile: (nickname: string) => api.put<{ data: { id: string; username: string; role: string; nickname: string | null } }>('/account/profile', { nickname }),
  backup: (label?: string) => api.post<{ data: { id: string; label: string } }>('/account/backup', { label }),
  listBackups: () => api.get<{ data: Backup[] }>('/account/backups'),
  restore: (id: string) => api.post(`/account/backups/${id}/restore`),
  deleteBackup: (id: string) => api.delete(`/account/backups/${id}`),
  reset: () => api.post('/account/reset', { confirm: true }),
};
