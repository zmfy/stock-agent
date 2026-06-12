import { isTradingDay } from '../data/trade-calendar';
import { inTradingSession } from '../data/service';
import { eligibleUserIds } from '../meetings/service';
import { ScheduleConfig, StrategyPhase, getScheduleConfig, beijingDate, hasStrategy, getLatestIntraday } from './service';
import { generatePrejudge, generateIntraday, generateReview, generateHoliday } from './generate';

export interface TickState {
  hasPrejudge: boolean;
  hasReview: boolean;
  hasHoliday: boolean;
  lastIntradayMs: number | null;
}

function toMins(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function beijingMins(nowMs: number): number {
  const bj = new Date(nowMs + 8 * 3600 * 1000);
  return bj.getUTCHours() * 60 + bj.getUTCMinutes();
}

export function dueJobs(cfg: ScheduleConfig, nowMs: number, isTradingToday: boolean, inSession: boolean, state: TickState): StrategyPhase[] {
  const mins = beijingMins(nowMs);
  const due: StrategyPhase[] = [];
  if (!isTradingToday) {
    if (mins >= toMins(cfg.holidayBriefTime) && !state.hasHoliday) due.push('holiday');
    return due;
  }
  if (mins >= toMins(cfg.prejudgeTime) && !state.hasPrejudge) due.push('prejudge');
  if (inSession && cfg.intradayInterval > 0 && (state.lastIntradayMs == null || nowMs - state.lastIntradayMs >= cfg.intradayInterval * 60000)) {
    due.push('intraday');
  }
  if (mins >= toMins(cfg.reviewTime) && !state.hasReview) due.push('review');
  return due;
}

type Gen = (uid: string) => Promise<unknown>;
export interface TickDeps {
  now?: number;
  eligibleUserIds?: () => string[];
  generators?: Record<StrategyPhase, Gen>;
}
const DEFAULT_GENERATORS: Record<StrategyPhase, Gen> = {
  prejudge: (u) => generatePrejudge(u),
  intraday: (u) => generateIntraday(u),
  review: (u) => generateReview(u),
  holiday: (u) => generateHoliday(u),
};

function parseUtc(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(String(ts).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
}

export async function runStrategyTick(deps: TickDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now();
  const users = (deps.eligibleUserIds ?? eligibleUserIds)();
  if (!users.length) return;
  const date = beijingDate(now);
  const trading = isTradingDay(date);
  const session = inTradingSession(now);
  const gens = deps.generators ?? DEFAULT_GENERATORS;
  for (const uid of users) {
    const cfg = getScheduleConfig(uid);
    const state: TickState = {
      hasPrejudge: hasStrategy(uid, date, 'prejudge'),
      hasReview: hasStrategy(uid, date, 'review'),
      hasHoliday: hasStrategy(uid, date, 'holiday'),
      lastIntradayMs: parseUtc(getLatestIntraday(uid, date)?.created_at),
    };
    for (const phase of dueJobs(cfg, now, trading, session, state)) {
      try {
        await gens[phase](uid);
      } catch (e) {
        console.error(`[strategy_tick] ${phase} failed for ${uid}:`, (e as Error).message);
      }
    }
  }
}
