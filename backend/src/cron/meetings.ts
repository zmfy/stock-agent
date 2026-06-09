import * as data from '../data/service';
import * as meetings from '../meetings/service';
import { isTradingDay } from '../data/trade-calendar';

export async function runMeetings(kind: 'morning' | 'evening'): Promise<void> {
  // 休市日不自动开会（手动「生成」仍可）。
  if (!isTradingDay(meetings.today())) {
    console.log(`[cron] ${kind} 跳过：今日休市`);
    return;
  }
  const users = meetings.eligibleUserIds();
  if (!users.length) return;
  // Refresh shared market data once (use the first eligible user's data source).
  await data.refreshMarket(users[0]).catch(() => {});
  for (const userId of users) {
    try {
      if (kind === 'morning') await meetings.generateMorning(userId);
      else await meetings.generateEvening(userId);
    } catch (e) {
      console.error(`[cron] ${kind} meeting failed for ${userId}`, (e as Error).message);
    }
  }
  console.log(`[cron] ${kind} meeting done for ${users.length} user(s)`);
}
