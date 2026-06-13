import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';

// Per-user tables (carry user_id). Order matters for wipe (delete after children).
const PER_USER_TABLES = [
  'rulebook_versions',
  'ai_configs',
  'ai_role_assignments',
  'plugins',
  'agent_profiles',
  'chat_sessions',
  'reports',
  'meetings',
  'screenings',
  'data_sources',
  'shared_ai_optout',
];

// Child tables keyed by a parent that belongs to the user.
const CHILD = {
  gates: 'version_id IN (SELECT id FROM rulebook_versions WHERE user_id = ?)',
  soft_rules: 'version_id IN (SELECT id FROM rulebook_versions WHERE user_id = ?)',
  chat_messages: 'session_id IN (SELECT id FROM chat_sessions WHERE user_id = ?)',
};

export type ExportBundle = Record<string, any[]>;

// Serialize every per-user row across all tables into one bundle.
export function exportUserData(userId: string): ExportBundle {
  const db = getDb();
  const bundle: ExportBundle = {};
  for (const t of PER_USER_TABLES) {
    bundle[t] = db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(userId);
  }
  for (const [t, where] of Object.entries(CHILD)) {
    bundle[t] = db.prepare(`SELECT * FROM ${t} WHERE ${where}`).all(userId);
  }
  return bundle;
}

export function wipeUserData(userId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    for (const [t, where] of Object.entries(CHILD)) db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(userId);
    for (const t of PER_USER_TABLES) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
  });
  tx();
}

// Allowed columns per table, read from the live schema. `table` is always one of our
// trusted constants; column names are validated against this set so a tampered backup
// bundle can never inject column names into the SQL.
const colCache = new Map<string, Set<string>>();
function allowedColumns(table: string): Set<string> {
  let s = colCache.get(table);
  if (!s) {
    const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    s = new Set(rows.map((r) => r.name));
    colCache.set(table, s);
  }
  return s;
}

function insertRow(table: string, row: Record<string, any>): void {
  const allow = allowedColumns(table);
  const cols = Object.keys(row).filter((c) => allow.has(c)); // drop unknown/malicious keys
  if (!cols.length) return;
  const placeholders = cols.map(() => '?').join(',');
  getDb()
    .prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders})`)
    .run(...cols.map((c) => row[c]));
}

// Replace the user's data with a backup bundle (their own data; user_id forced to current).
export function importUserData(userId: string, bundle: ExportBundle): void {
  const db = getDb();
  const tx = db.transaction(() => {
    wipeUserData(userId);
    for (const t of PER_USER_TABLES) {
      for (const row of bundle[t] || []) insertRow(t, { ...row, user_id: userId });
    }
    for (const t of Object.keys(CHILD)) {
      for (const row of bundle[t] || []) insertRow(t, row);
    }
  });
  tx();
}

// ---- backups ----
export function createBackup(userId: string, label?: string): { id: string; label: string } {
  const id = uuidv4();
  const finalLabel = label || `备份 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
  getDb()
    .prepare('INSERT INTO backups (id, user_id, label, payload) VALUES (?, ?, ?, ?)')
    .run(id, userId, finalLabel, JSON.stringify(exportUserData(userId)));
  return { id, label: finalLabel };
}

export function listBackups(userId: string): Array<{ id: string; label: string; created_at: string; size: number }> {
  const rows = getDb()
    .prepare('SELECT id, label, created_at, length(payload) AS size FROM backups WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as any[];
  return rows;
}

export function restoreBackup(userId: string, id: string): boolean {
  const row = getDb().prepare('SELECT payload FROM backups WHERE id = ? AND user_id = ?').get(id, userId) as { payload: string } | undefined;
  if (!row) return false;
  let bundle: ExportBundle;
  try {
    bundle = JSON.parse(row.payload);
  } catch {
    return false;
  }
  importUserData(userId, bundle);
  return true;
}

export function deleteBackup(userId: string, id: string): void {
  getDb().prepare('DELETE FROM backups WHERE id = ? AND user_id = ?').run(id, userId);
}

// Reset = auto-backup then wipe everything (re-run onboarding afterwards).
export function resetUser(userId: string): { backupId: string; backupLabel: string } {
  const b = createBackup(userId, `重置前自动备份 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  wipeUserData(userId);
  return { backupId: b.id, backupLabel: b.label };
}

export function updateNickname(userId: string, nickname: string): { id: string; username: string; role: string; nickname: string | null } {
  getDb().prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, userId);
  return getDb().prepare('SELECT id, username, role, nickname FROM users WHERE id = ?').get(userId) as any;
}
