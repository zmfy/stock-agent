import api from './client';

export interface CronJob {
  key: string;
  label: string;
  description: string;
  expr: string;
  time: string | null;
  enabled: boolean;
  timezone: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: string | null;
}
export interface CronList {
  cronEnabled: boolean;
  jobs: CronJob[];
}

export const cronApi = {
  list: () => api.get<{ data: CronList }>('/cron').then((r) => r.data.data),
  update: (key: string, body: { time?: string; enabled?: boolean; expr?: string }) => api.put(`/cron/${key}`, body).then((r) => r.data.data as CronJob),
  runNow: (key: string) => api.post(`/cron/${key}/run`).then((r) => r.data),
  log: (key: string) => api.get(`/cron/${key}/log`).then((r) => r.data.data as Array<{ ts: string; level: string; message: string }>),
};
