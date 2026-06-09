import { getDb } from '../db';

// 固定窗口起点(unix 秒)。period<=0 表示不重置(终身)。nowMs 可注入以便测试。
export function currentWindow(periodSeconds: number, nowMs: number = Date.now()): number {
  if (!periodSeconds || periodSeconds <= 0) return 0;
  const sec = Math.floor(nowMs / 1000);
  return Math.floor(sec / periodSeconds) * periodSeconds;
}

function periodOf(configId: string): number {
  const r = getDb().prepare('SELECT share_period_seconds AS p FROM ai_configs WHERE id = ?').get(configId) as { p: number } | undefined;
  return r?.p ?? 0;
}

// 窗口感知 UPSERT：跨窗口则重置。调用方自行 try/catch（记账失败不应影响聊天）。
export function recordSharedUsage(configId: string, userId: string, tokens: number, nowMs: number = Date.now()): void {
  const db = getDb();
  const cur = currentWindow(periodOf(configId), nowMs);
  const row = db
    .prepare('SELECT calls, total_tokens, window_start FROM shared_ai_usage WHERE config_id = ? AND user_id = ?')
    .get(configId, userId) as { calls: number; total_tokens: number; window_start: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO shared_ai_usage (config_id, user_id, calls, total_tokens, window_start) VALUES (?,?,1,?,?)').run(configId, userId, tokens, cur);
  } else if (row.window_start !== cur) {
    db.prepare('UPDATE shared_ai_usage SET calls = 1, total_tokens = ?, window_start = ?, updated_at = CURRENT_TIMESTAMP WHERE config_id = ? AND user_id = ?').run(tokens, cur, configId, userId);
  } else {
    db.prepare('UPDATE shared_ai_usage SET calls = calls + 1, total_tokens = total_tokens + ?, updated_at = CURRENT_TIMESTAMP WHERE config_id = ? AND user_id = ?').run(tokens, configId, userId);
  }
}

// 当前窗口内、该模型每个用户的用量（JOIN users 取用户名）。
export function getUsageForConfig(
  configId: string,
  periodSeconds: number,
  nowMs: number = Date.now()
): Array<{ userId: string; username: string; calls: number; total_tokens: number }> {
  const cur = currentWindow(periodSeconds, nowMs);
  return getDb()
    .prepare(
      `SELECT s.user_id AS userId, COALESCE(u.username,'?') AS username, s.calls AS calls, s.total_tokens AS total_tokens
       FROM shared_ai_usage s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.config_id = ? AND s.window_start = ? ORDER BY s.total_tokens DESC`
    )
    .all(configId, cur) as Array<{ userId: string; username: string; calls: number; total_tokens: number }>;
}

// 当前窗口内该模型全局合计 token。
export function currentConfigUsage(configId: string, periodSeconds: number, nowMs: number = Date.now()): number {
  const cur = currentWindow(periodSeconds, nowMs);
  const r = getDb()
    .prepare('SELECT COALESCE(SUM(total_tokens),0) AS t FROM shared_ai_usage WHERE config_id = ? AND window_start = ?')
    .get(configId, cur) as { t: number };
  return r?.t ?? 0;
}

export function resetConfigUsage(configId: string): void {
  getDb().prepare('DELETE FROM shared_ai_usage WHERE config_id = ?').run(configId);
}
