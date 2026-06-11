import { getSyncStatus, getCronStatus, getMarketSentimentSeries } from './service';
import { lastTradingDayBefore } from './trade-calendar';

export type AlertLevel = 'error' | 'warn';
export type SidecarState = 'ok' | 'down' | 'unconfigured';
export interface Alert {
  level: AlertLevel;
  source: string;
  message: string;
  since: string | null;
}

// 有 sync_status 的数据同步任务(失败/陈旧由 sync_status 覆盖)
const SYNC_JOBS: Array<{ key: string; label: string }> = [
  { key: 'stock_universe', label: '股票库同步' },
  { key: 'eod', label: '行情 EOD 入库' },
];
// 无 sync_status 对应的数据类 cron(realtime 在阶段④加入)
const DATA_CRONS: Array<{ key: string; label: string }> = [{ key: 'nightly', label: '夜间数据刷新' }];

function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
// SQLite CURRENT_TIMESTAMP 是 UTC；转北京日期再比，避免跨零点误判陈旧
function cnDate(ts: string | null): string | null {
  if (!ts) return null;
  const t = new Date(ts.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return ts.slice(0, 10);
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function getDataAlerts(sidecar: SidecarState, nowCN: string = beijingToday()): Alert[] {
  const alerts: Alert[] = [];
  const prevTd = lastTradingDayBefore(nowCN);

  if (sidecar === 'down') {
    alerts.push({ level: 'error', source: 'sidecar', message: '数据 sidecar(akshare-mcp)不可达，取数将失败', since: null });
  } else if (sidecar === 'unconfigured') {
    alerts.push({ level: 'warn', source: 'sidecar', message: '尚未配置数据 sidecar，无法取数', since: null });
  }

  // 注：getSyncStatus 为 null(从未跑过)视为「无告警」——全新部署时由 sidecar/market 告警兜底，避免噪声。
  for (const { key, label } of SYNC_JOBS) {
    const st = getSyncStatus(key);
    if (st?.state === 'error') {
      alerts.push({ level: 'error', source: key, message: `${label}上次同步失败：${st.error || '未知错误'}`, since: st.finished_at });
    } else if (st?.last_success_at) {
      const d = cnDate(st.last_success_at)!;
      if (d < prevTd) {
        alerts.push({ level: 'warn', source: key, message: `${label}数据陈旧（最后成功 ${d}，应至 ${prevTd}）`, since: st.last_success_at });
      }
    }
  }

  for (const { key, label } of DATA_CRONS) {
    const cs = getCronStatus(key);
    if (cs?.last_status === 'error') {
      alerts.push({ level: 'error', source: `cron:${key}`, message: `定时任务[${label}]上次执行失败：${cs.last_error || '未知错误'}`, since: cs.last_run_at });
    }
  }

  const latest = getMarketSentimentSeries(1)[0];
  if (!latest) {
    alerts.push({ level: 'warn', source: 'market', message: '大盘情绪数据缺失（尚无任何记录）', since: null });
  } else if (latest.date < prevTd) {
    alerts.push({ level: 'warn', source: 'market', message: `大盘数据陈旧（最新 ${latest.date}，应至 ${prevTd}）`, since: latest.date });
  }

  return alerts;
}
