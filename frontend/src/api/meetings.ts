import api from './client';

export interface Meeting {
  id: string;
  kind: 'morning' | 'evening';
  date: string;
  content: string;
  created_at: string;
}

export const meetingsApi = {
  today: () => api.get<{ data: { morning: Meeting | null; evening: Meeting | null } }>('/meetings/today'),
  generate: (kind: 'morning' | 'evening') => api.post<{ data: Meeting }>('/meetings/generate', { kind }),
};
