import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_PATH = path.join(DATA_DIR, 'stock-agent.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT,
      used_by TEXT,
      used_at DATETIME,
      expires_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rulebook_versions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      version_label TEXT,
      persona TEXT,
      position_rules TEXT,
      note TEXT,
      author TEXT DEFAULT 'user',
      parent_version_id TEXT,
      is_active INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gates (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      system TEXT NOT NULL,
      gate_key TEXT NOT NULL,
      label TEXT,
      field TEXT,
      op TEXT,
      threshold REAL,
      threshold2 REAL,
      ref_field TEXT,
      unit TEXT,
      veto INTEGER DEFAULT 1,
      exception_channel TEXT,
      teach TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS soft_rules (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      system TEXT NOT NULL,
      text TEXT NOT NULL,
      teach TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ai_configs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key_enc TEXT,
      base_url TEXT,
      model TEXT,
      is_active INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider)
    );

    CREATE INDEX IF NOT EXISTS idx_rulebook_user_active ON rulebook_versions (user_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_gates_version ON gates (version_id);
    CREATE INDEX IF NOT EXISTS idx_soft_rules_version ON soft_rules (version_id);
    CREATE INDEX IF NOT EXISTS idx_ai_configs_user_active ON ai_configs (user_id, is_active);
  `);

  // Registration is invite-only by default; set REGISTRATION_MODE=open to allow self sign-up.
  const mode = process.env.REGISTRATION_MODE === 'open' ? 'open' : 'invite';
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('registration_mode', ?)
     ON CONFLICT(key) DO NOTHING`
  ).run(mode);

  seedDefaultAdmin();
}

// Seed a default admin account on first init so an invite-only system is reachable.
// Override via DEFAULT_ADMIN_USER / DEFAULT_ADMIN_PASSWORD. Change the password after first login.
function seedDefaultAdmin(): void {
  const username = process.env.DEFAULT_ADMIN_USER || 'stock-agent';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'sg123456';
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return;
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    uuidv4(),
    username,
    bcrypt.hashSync(password, 10),
    'admin'
  );
  console.log(`[db] seeded default admin user '${username}' — change the password after first login`);
}
