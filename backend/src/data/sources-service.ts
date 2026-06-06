import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';

export interface DataSource {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  builtin: number;
  priority: number;
  enabled: number;
  created_at: string;
}

const BUILTIN_BASE = process.env.AKSHARE_BASE || 'http://akshare-mcp:8000';

// Recommended sources the user can one-click add. All speak our sidecar API.
// em (built-in) is full; sina/tx provide independent close prices for cross-validation.
export const RECOMMENDED: Array<{ name: string; base_url: string; note: string }> = [
  { name: 'AkShare · 东方财富（内置）', base_url: BUILTIN_BASE, note: '默认主源：基本面/行情/情绪/新闻齐全' },
  { name: 'AkShare · 新浪行情', base_url: `${BUILTIN_BASE}/sina`, note: '新浪行情收盘价，作交叉验证备用源' },
  { name: 'AkShare · 腾讯行情', base_url: `${BUILTIN_BASE}/tx`, note: '腾讯行情收盘价，作交叉验证备用源' },
];

// Seed the recommended built-in source on first use.
function ensureSeed(userId: string): void {
  const db = getDb();
  const has = db.prepare('SELECT 1 FROM data_sources WHERE user_id = ? LIMIT 1').get(userId);
  if (!has) {
    db.prepare('INSERT INTO data_sources (id, user_id, name, base_url, builtin, priority, enabled) VALUES (?, ?, ?, ?, 1, 0, 1)').run(
      uuidv4(),
      userId,
      '内置 AkShare 数据源（推荐）',
      BUILTIN_BASE
    );
  }
}

export function listSources(userId: string): DataSource[] {
  ensureSeed(userId);
  return getDb().prepare('SELECT * FROM data_sources WHERE user_id = ? ORDER BY priority, created_at').all(userId) as DataSource[];
}

// Enabled sources in priority order; primary = first.
export function resolveSources(userId: string): DataSource[] {
  return listSources(userId).filter((s) => s.enabled);
}

export function primaryBase(userId: string): string | null {
  return resolveSources(userId)[0]?.base_url?.replace(/\/+$/, '') ?? null;
}

// Secondary sources (for cross-validation), normalized base urls.
export function secondaryBases(userId: string): string[] {
  return resolveSources(userId)
    .slice(1)
    .map((s) => s.base_url.replace(/\/+$/, ''));
}

export function addSource(userId: string, input: { name: string; baseUrl: string; priority?: number }): void {
  getDb()
    .prepare('INSERT INTO data_sources (id, user_id, name, base_url, builtin, priority, enabled) VALUES (?, ?, ?, ?, 0, ?, 1)')
    .run(uuidv4(), userId, input.name, input.baseUrl.replace(/\/+$/, ''), input.priority ?? 100);
}

export function updateSource(
  userId: string,
  id: string,
  input: { name?: string; baseUrl?: string; enabled?: boolean; priority?: number }
): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM data_sources WHERE id = ? AND user_id = ?').get(id, userId) as DataSource | undefined;
  if (!row) throw new Error('NOT_FOUND');
  db.prepare('UPDATE data_sources SET name = ?, base_url = ?, enabled = ?, priority = ? WHERE id = ?').run(
    input.name ?? row.name,
    (input.baseUrl ?? row.base_url).replace(/\/+$/, ''),
    input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
    input.priority ?? row.priority,
    id
  );
}

// Recommended sources the user hasn't added yet.
export function catalog(userId: string): Array<{ name: string; base_url: string; note: string }> {
  const have = new Set(listSources(userId).map((s) => s.base_url.replace(/\/+$/, '')));
  return RECOMMENDED.filter((r) => !have.has(r.base_url.replace(/\/+$/, '')));
}

export function deleteSource(userId: string, id: string): void {
  const row = getDb().prepare('SELECT builtin FROM data_sources WHERE id = ? AND user_id = ?').get(id, userId) as
    | { builtin: number }
    | undefined;
  if (!row) return;
  if (row.builtin) throw new Error('BUILTIN'); // built-in can be disabled, not deleted
  getDb().prepare('DELETE FROM data_sources WHERE id = ?').run(id);
}
