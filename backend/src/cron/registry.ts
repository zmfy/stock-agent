import cron from 'node-cron';
import { runNightly } from './nightly';
import { runStrategyTick } from '../strategy/dispatcher';
import { runStockUniverse, runEod, runRealtime } from './shared-data';
import * as svc from '../data/service';

export interface CronJobDef {
  key: string;
  label: string;
  description: string;
  defaultExpr: string;
  run: () => Promise<void> | void;
}

const TZ = 'Asia/Shanghai';

export const CRON_JOBS: CronJobDef[] = [
  { key: 'nightly', label: '夜间数据刷新', description: '清理日志/同步交易日历/刷新新闻+大盘+缓存个股', defaultExpr: '0 23 * * *', run: runNightly },
  { key: 'stock_universe', label: '股票库同步', description: '全量名单 diff 入库', defaultExpr: '25 9 * * *', run: () => runStockUniverse() },
  { key: 'eod', label: '行情 EOD 入库', description: '全量个股日线(首次365/之后增量)', defaultExpr: '0 1 * * *', run: () => runEod() },
  { key: 'realtime', label: '实时行情(交易时段)', description: 'TDX 拉已缓存股票实时盘口五档，每5分钟、仅交易时段', defaultExpr: '*/5 * * * *', run: () => runRealtime() },
  { key: 'strategy_tick', label: '策略调度', description: '每5分钟按各用户配置生成预判/盘中/复盘/休市快报(交易日历闸门)', defaultExpr: '*/5 * * * *', run: () => runStrategyTick() },
];

// ---- 纯助手 ----

export function timeToExpr(hhmm: string): string {
  const m = /^([0-9]{2}):([0-9]{2})$/.exec(hhmm);
  if (!m) throw new Error('BAD_TIME');
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error('BAD_TIME');
  return `${min} ${h} * * *`;
}

export function exprToTime(expr: string): string | null {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5 || p[2] !== '*' || p[3] !== '*' || p[4] !== '*') return null;
  if (!/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return null;
  const min = Number(p[0]), h = Number(p[1]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// 仅每日 'M H * * *' 算下次运行(Asia/Shanghai);非每日返回 null。
export function nextRunAt(expr: string, nowMs: number = Date.now()): string | null {
  const t = exprToTime(expr);
  if (!t) return null;
  const [h, min] = t.split(':').map(Number);
  const bj = new Date(nowMs + 8 * 3600 * 1000); // 把北京墙钟时间放进 UTC 字段
  const curMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const tgtMin = h * 60 + min;
  const deltaDays = tgtMin > curMin ? 0 : 1;
  const bjMidnight = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  const runUtcMs = bjMidnight + deltaDays * 86400000 + tgtMin * 60000 - 8 * 3600 * 1000;
  return new Date(runUtcMs).toISOString();
}

export function effective(key: string): { expr: string; enabled: boolean } {
  const def = CRON_JOBS.find((j) => j.key === key)!;
  const o = svc.getCronConfig()[key] || {};
  return { expr: o.expr ?? def.defaultExpr, enabled: o.enabled ?? true };
}

// ---- 带追踪的执行 ----

export async function tracked(key: string, run: () => Promise<void> | void): Promise<void> {
  svc.recordCronStart(key);
  svc.jobLog(`cron:${key}`, 'info', '定时任务开始');
  const t0 = Date.now();
  try {
    await run();
    svc.recordCronFinish(key, 'ok', Date.now() - t0, null);
    svc.jobLog(`cron:${key}`, 'info', `完成（${Date.now() - t0}ms）`);
  } catch (e: any) {
    svc.recordCronFinish(key, 'error', Date.now() - t0, String(e?.message || e));
    svc.jobLog(`cron:${key}`, 'error', `失败：${String(e?.message || e)}`);
  }
}

// ---- 调度 / 管理 ----

const tasks = new Map<string, cron.ScheduledTask>();
let started = false;

function reschedule(key: string): void {
  if (!started) return; // 测试/未启动时不实际调度
  const old = tasks.get(key);
  if (old) { old.stop(); tasks.delete(key); }
  const def = CRON_JOBS.find((j) => j.key === key);
  if (!def) return;
  const { expr, enabled } = effective(key);
  if (!enabled || !cron.validate(expr)) return;
  tasks.set(key, cron.schedule(expr, () => { void tracked(key, def.run); }, { timezone: TZ }));
}

export function startCrons(): void {
  if (process.env.ENABLE_CRON === 'false') return;
  started = true;
  for (const def of CRON_JOBS) reschedule(def.key);
  console.log('[cron] registry started:', CRON_JOBS.map((j) => j.key).join(', '));
}

export interface CronJobView {
  key: string; label: string; description: string;
  expr: string; time: string | null; enabled: boolean; timezone: string;
  lastRunAt: string | null; lastStatus: string | null; lastDurationMs: number | null; lastError: string | null;
  nextRunAt: string | null;
}

export function listCronJobs(nowMs: number = Date.now()): { cronEnabled: boolean; jobs: CronJobView[] } {
  const cfg = svc.getCronConfig();
  const jobs = CRON_JOBS.map((def): CronJobView => {
    const o = cfg[def.key] || {};
    const expr = o.expr ?? def.defaultExpr;
    const enabled = o.enabled ?? true;
    const st = svc.getCronStatus(def.key);
    return {
      key: def.key, label: def.label, description: def.description,
      expr, time: exprToTime(expr), enabled, timezone: TZ,
      lastRunAt: st?.last_run_at ?? null, lastStatus: st?.last_status ?? null,
      lastDurationMs: st?.last_duration_ms ?? null, lastError: st?.last_error ?? null,
      nextRunAt: enabled ? nextRunAt(expr, nowMs) : null,
    };
  });
  return { cronEnabled: process.env.ENABLE_CRON !== 'false', jobs };
}

export function applyCronChange(key: string, input: { time?: string; enabled?: boolean }): void {
  if (!CRON_JOBS.find((j) => j.key === key)) throw new Error('UNKNOWN_JOB');
  const cfg = svc.getCronConfig();
  const o = { ...(cfg[key] || {}) };
  if (input.time !== undefined) o.expr = timeToExpr(input.time); // 非法 time 抛 BAD_TIME
  if (input.enabled !== undefined) o.enabled = input.enabled;
  cfg[key] = o;
  svc.setCronConfig(cfg);
  reschedule(key);
}

export function runCronNow(key: string): void {
  const def = CRON_JOBS.find((j) => j.key === key);
  if (!def) throw new Error('UNKNOWN_JOB');
  if (svc.getCronStatus(key)?.last_status === 'running') throw new Error('ALREADY_RUNNING');
  void tracked(key, def.run); // fire-and-forget
}
