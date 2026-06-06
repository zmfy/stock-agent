import cron from 'node-cron';
import { getDb } from '../db';
import * as data from '../data/service';

// Pick a user whose enabled akshare-data plugin we can use to refresh shared market data.
// Market data is global, so any admin/user with the sidecar enabled works; default to the admin.
function pickRefreshUserId(): string | null {
  const row = getDb()
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

async function runNightly(): Promise<void> {
  const userId = pickRefreshUserId();
  if (!userId) return;
  try {
    const market = await data.refreshMarket(userId);
    const codes = data.listCachedCodes();
    for (const code of codes) {
      await data.refreshStock(userId, code).catch(() => {});
    }
    console.log(`[cron] nightly refresh done — market=${market}, codes=${codes.length}`);
  } catch (e) {
    console.error('[cron] nightly refresh failed', e);
  }
}

// Start the post-close (23:00 Asia/Shanghai) refresh. Disabled when ENABLE_CRON=false.
export function startNightlyCron(): void {
  if (process.env.ENABLE_CRON === 'false') return;
  cron.schedule('0 23 * * *', runNightly, { timezone: 'Asia/Shanghai' });
  console.log('[cron] nightly data refresh scheduled for 23:00 Asia/Shanghai');
}

export { runNightly };
