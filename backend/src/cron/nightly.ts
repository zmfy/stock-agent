import { getDb } from '../db';
import * as data from '../data/service';
import { purgeOldLogs } from '../data/news-log';
import { syncTradeCalendar } from '../data/trade-calendar';

// Pick a user whose enabled akshare-data plugin we can use to refresh shared market data.
// Market data is global, so any admin/user with the sidecar enabled works; default to the admin.
function pickRefreshUserId(): string | null {
  const row = getDb()
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export async function runNightly(): Promise<void> {
  // 新闻双日志清理（标题>1年 / 内容采用>3月·未采用>1周）——全局，无需用户
  try { purgeOldLogs(); } catch { /* ignore */ }
  const userId = pickRefreshUserId();
  if (!userId) return;
  // 每晚刷新交易日历（含本年节假日）。
  try { await syncTradeCalendar(userId); } catch { /* ignore */ }
  // 注：新闻 + 大盘情绪 + 指数日线已拆到独立的 news_sentiment 定时任务（更高频、可在「定时任务」单独调）。
  try {
    const codes = data.listCachedCodes();
    for (const code of codes) {
      await data.refreshStock(userId, code).catch(() => {});
    }
    console.log(`[cron] nightly refresh done — codes=${codes.length}`);
  } catch (e) {
    console.error('[cron] nightly refresh failed', e);
  }
}
