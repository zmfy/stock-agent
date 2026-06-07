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

// ---- Global (admin-managed) sources ----
// Sources are now ONE global set: all users read the same list; only admin writes.

const GLOBAL_OWNER = '__global__';

export function ensureSeedGlobal(): void {
  const db = getDb();
  const n = (db.prepare('SELECT COUNT(*) AS c FROM data_sources').get() as any).c;
  if (n > 0) return;
  for (const r of RECOMMENDED) {
    db.prepare('INSERT INTO data_sources (id, user_id, name, base_url, builtin, priority, enabled) VALUES (?,?,?,?,1,?,1)')
      .run(uuidv4(), GLOBAL_OWNER, r.name, r.base_url, 100);
  }
}

export function listSourcesGlobal(): any[] {
  return getDb().prepare(`SELECT * FROM data_sources GROUP BY base_url ORDER BY priority ASC, created_at ASC`).all() as any[];
}

export function primaryBaseGlobal(): string | null {
  const r = getDb().prepare(`SELECT base_url FROM data_sources WHERE enabled=1 GROUP BY base_url ORDER BY priority ASC, created_at ASC LIMIT 1`).get() as any;
  return r ? String(r.base_url).replace(/\/+$/, '') : null;
}

export function addSourceGlobal(s: { name: string; base_url: string; priority?: number }): string {
  const id = uuidv4();
  getDb().prepare('INSERT INTO data_sources (id, user_id, name, base_url, builtin, priority, enabled) VALUES (?,?,?,?,0,?,1)')
    .run(id, GLOBAL_OWNER, s.name, s.base_url.replace(/\/+$/, ''), s.priority ?? 100);
  return id;
}

export function updateSourceGlobal(id: string, patch: { name?: string; base_url?: string; enabled?: number; priority?: number }): void {
  const cur = getDb().prepare('SELECT * FROM data_sources WHERE id=?').get(id) as any;
  if (!cur) return;
  getDb().prepare('UPDATE data_sources SET name=?, base_url=?, enabled=?, priority=? WHERE id=?')
    .run(patch.name ?? cur.name, (patch.base_url ?? cur.base_url).replace(/\/+$/, ''), patch.enabled ?? cur.enabled, patch.priority ?? cur.priority, id);
}

export function deleteSourceGlobal(id: string): void {
  const cur = getDb().prepare('SELECT builtin FROM data_sources WHERE id=?').get(id) as any;
  if (cur && cur.builtin) return;
  getDb().prepare('DELETE FROM data_sources WHERE id=?').run(id);
}

export function catalogGlobal(): typeof RECOMMENDED {
  const have = new Set((getDb().prepare('SELECT base_url FROM data_sources').all() as any[]).map((r) => r.base_url));
  return RECOMMENDED.filter((r) => !have.has(r.base_url));
}
