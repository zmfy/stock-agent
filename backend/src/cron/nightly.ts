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
  // 每天采集当天重要财经新闻入库（含休市日）——下一个交易日早会作为判断凭据。
  try { await data.refreshNews(userId); } catch { /* ignore */ }
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
