import cron from 'node-cron';
import * as data from '../data/service';
import * as meetings from '../meetings/service';

async function runMeetings(kind: 'morning' | 'evening'): Promise<void> {
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

// 早会 08:00、晚会 16:45（北京时间）。ENABLE_CRON=false 关闭。
export function startMeetingsCron(): void {
  if (process.env.ENABLE_CRON === 'false') return;
  cron.schedule('0 8 * * *', () => runMeetings('morning'), { timezone: 'Asia/Shanghai' });
  cron.schedule('45 16 * * *', () => runMeetings('evening'), { timezone: 'Asia/Shanghai' });
  console.log('[cron] meetings scheduled: morning 08:00, evening 16:45 Asia/Shanghai');
}

export { runMeetings };
