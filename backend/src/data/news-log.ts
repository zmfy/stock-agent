import { getDb } from '../db';
import { v4 as uuidv4 } from 'uuid';

export interface CollectItem { title: string; content?: string; source?: string; published_at?: string }

export function recordCollected(items: CollectItem[]): Array<{ content_id: string; title: string }> {
  const db = getDb();
  const out: Array<{ content_id: string; title: string }> = [];
  const findC = db.prepare("SELECT id FROM news_content_log WHERE title = ? AND IFNULL(published_at,'') = IFNULL(?,'')");
  const insC = db.prepare('INSERT INTO news_content_log (id, title, content, source, published_at) VALUES (?, ?, ?, ?, ?)');
  const updC = db.prepare('UPDATE news_content_log SET content = COALESCE(?, content), source = COALESCE(?, source) WHERE id = ?');
  const insT = db.prepare('INSERT INTO news_title_log (id, content_id, title, source, published_at) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction((rows: CollectItem[]) => {
    for (const n of rows) {
      if (!n.title) continue;
      const existing = findC.get(n.title, n.published_at ?? '') as { id: string } | undefined;
      let cid: string;
      if (existing) { cid = existing.id; updC.run(n.content ?? null, n.source ?? null, cid); }
      else { cid = uuidv4(); insC.run(cid, n.title, n.content ?? null, n.source ?? null, n.published_at ?? null); }
      insT.run(uuidv4(), cid, n.title, n.source ?? null, n.published_at ?? null);
      out.push({ content_id: cid, title: n.title });
    }
  });
  tx(items);
  return out;
}

export function listTitleLog(limit = 30): Array<{ id: string; content_id: string; title: string; source: string; collected_at: string; adopted: number }> {
  return getDb().prepare(
    `SELECT t.id, t.content_id, t.title, t.source, t.collected_at, COALESCE(c.adopted, 0) AS adopted
     FROM news_title_log t LEFT JOIN news_content_log c ON c.id = t.content_id
     ORDER BY t.collected_at DESC, t.rowid DESC LIMIT ?`
  ).all(limit) as any[];
}

export function getContent(contentId: string): { id: string; title: string; content: string; source: string; published_at: string; collected_at: string; adopted: number } | null {
  return (getDb().prepare('SELECT * FROM news_content_log WHERE id = ?').get(contentId) as any) ?? null;
}

export function markAdopted(contentIds: string[]): void {
  if (!contentIds.length) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE news_content_log SET adopted = 1, adopted_at = CURRENT_TIMESTAMP WHERE id = ?');
  const tx = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(id); });
  tx(contentIds);
}

export function purgeOldLogs(): void {
  const db = getDb();
  db.prepare("DELETE FROM news_title_log WHERE collected_at < datetime('now','-1 year')").run();
  db.prepare("DELETE FROM news_content_log WHERE adopted = 1 AND collected_at < datetime('now','-3 months')").run();
  db.prepare("DELETE FROM news_content_log WHERE adopted = 0 AND collected_at < datetime('now','-7 days')").run();
}

// 自某时间点(含)以来采集的新闻标题(按 content_id 去重，取最早一次)，给「策略预判」按「上一交易日以来」取窗口用。
export function newsTitlesSince(sinceIso: string, limit = 80): Array<{ content_id: string; title: string; collected_at: string }> {
  return getDb()
    .prepare(
      `SELECT content_id, title, MIN(collected_at) AS collected_at
       FROM news_title_log
       WHERE collected_at >= ?
       GROUP BY content_id
       ORDER BY MIN(collected_at) DESC
       LIMIT ?`,
    )
    .all(sinceIso, limit) as Array<{ content_id: string; title: string; collected_at: string }>;
}
