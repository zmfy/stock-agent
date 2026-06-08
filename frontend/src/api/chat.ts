import api from './client';

export type ChatKind = 'general' | 'core_principle' | 'stock' | 'morning' | 'evening' | 'screen';

export interface ChatSession {
  id: string;
  user_id: string;
  kind: ChatKind;
  ref_id: string | null;
  title: string | null;
  pinned: number;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

export const chatApi = {
  createSession: (kind: ChatKind, refId?: string | null, title?: string) =>
    api.post<{ data: { id: string } }>('/chat/sessions', { kind, refId, title }),
  listSessions: (kind?: ChatKind) =>
    api.get<{ data: ChatSession[] }>(`/chat/sessions${kind ? `?kind=${kind}` : ''}`),
  getMessages: (id: string) => api.get<{ data: ChatMessage[] }>(`/chat/sessions/${id}/messages`),
  postMessage: (id: string, content: string) =>
    api.post<{ data: ChatMessage }>(`/chat/sessions/${id}/messages`, { content }),
  analyze: (id: string) => api.post<{ data: { report: any; message: ChatMessage } }>(`/chat/sessions/${id}/analyze`),
  deleteSession: (id: string) => api.delete(`/chat/sessions/${id}`),
  setPinned: (id: string, pinned: boolean) => api.put(`/chat/sessions/${id}/pin`, { pinned }),
  clearMessages: (id: string) => api.delete(`/chat/sessions/${id}/messages`),
  clearAll: () => api.delete('/chat/sessions'),
  postNote: (id: string, content: string) =>
    api.post<{ data: ChatMessage }>(`/chat/sessions/${id}/note`, { content }),
};
