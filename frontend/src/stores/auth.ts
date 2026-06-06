import { defineStore } from 'pinia';
import api from '../api/client';

interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    accessToken: localStorage.getItem('accessToken'),
  }),
  getters: {
    isAuthenticated: (s) => !!s.accessToken,
    isAdmin: (s) => s.user?.role === 'admin',
  },
  actions: {
    persist(accessToken: string, refreshToken: string, user: AuthUser) {
      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
      this.accessToken = accessToken;
      this.user = user;
    },
    async login(username: string, password: string) {
      const res = await api.post('/auth/login', { username, password });
      const { accessToken, refreshToken, user } = res.data.data;
      this.persist(accessToken, refreshToken, user);
    },
    async register(username: string, password: string, inviteCode?: string) {
      const res = await api.post('/auth/register', { username, password, inviteCode });
      const { accessToken, refreshToken, user } = res.data.data;
      this.persist(accessToken, refreshToken, user);
    },
    async fetchMe() {
      const res = await api.get('/auth/me');
      this.user = res.data.data;
    },
    async changePassword(currentPassword: string, newPassword: string) {
      await api.put('/auth/password', { currentPassword, newPassword });
    },
    logout() {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      this.accessToken = null;
      this.user = null;
    },
  },
});
