import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';

const BUILTIN_BASE = process.env.AKSHARE_BASE || 'http://akshare-mcp:8000';

// Recommended sources the user can one-click add. All speak our sidecar API.
// em (built-in) is full; sina/tx provide independent close prices for cross-validation.
export const RECOMMENDED: Array<{ name: string; base_url: string; note: string }> = [
  { name: 'AkShare · 东方财富（内置）', base_url: BUILTIN_BASE, note: '默认主源：基本面/行情/情绪/新闻齐全' },
  { name: 'AkShare · 新浪行情', base_url: `${BUILTIN_BASE}/sina`, note: '新浪行情收盘价，作交叉验证备用源' },
  { name: 'AkShare · 腾讯行情', base_url: `${BUILTIN_BASE}/tx`, note: '腾讯行情收盘价，作交叉验证备用源' },
];

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

// Secondary sources for cross-validation (global, excluding primary), normalized base_urls.
export function secondaryBasesGlobal(): string[] {
  const primary = primaryBaseGlobal();
  return (getDb().prepare('SELECT base_url FROM data_sources WHERE enabled=1 ORDER BY priority ASC, created_at ASC').all() as any[])
    .map((r) => String(r.base_url).replace(/\/+$/, ''))
    .filter((url) => url !== primary);
}
