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
      nickname TEXT,
      agreed_at DATETIME,
      disclaimer_version TEXT,
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
      enabled INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS ai_role_assignments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      mode TEXT DEFAULT 'auto',
      provider TEXT,
      model TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, role)
    );

    CREATE INDEX IF NOT EXISTS idx_rulebook_user_active ON rulebook_versions (user_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_gates_version ON gates (version_id);
    CREATE INDEX IF NOT EXISTS idx_soft_rules_version ON soft_rules (version_id);
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plugin_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT,
      source TEXT NOT NULL,
      transport TEXT,
      config TEXT,
      enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, plugin_key)
    );

    CREATE TABLE IF NOT EXISTS quote_daily (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL,
      source TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (code, date)
    );

    CREATE TABLE IF NOT EXISTS fundamentals (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      data TEXT,
      source TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (code, date)
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT,
      payload TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS data_sources (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      builtin INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 100,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS news (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      published_at TEXT,
      source TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(title, published_at)
    );

    CREATE TABLE IF NOT EXISTS stock_names (
      code TEXT PRIMARY KEY,
      name TEXT,
      py TEXT,
      industry TEXT,
      list_date TEXT,
      source TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_status (
      job TEXT PRIMARY KEY,
      state TEXT,
      total INTEGER DEFAULT 0,
      done INTEGER DEFAULT 0,
      message TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );


    CREATE TABLE IF NOT EXISTS market_sentiment (
      date TEXT PRIMARY KEY,
      limit_up_count INTEGER,
      limit_down_count INTEGER,
      sse_ma20_slope REAL,
      data TEXT,
      source TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_configs_user_active ON ai_configs (user_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_plugins_user_enabled ON plugins (user_id, enabled);
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      stock_code TEXT NOT NULL,
      stock_name TEXT,
      rulebook_version_id TEXT,
      data_date TEXT,
      ai_provider TEXT,
      ai_model TEXT,
      snapshot TEXT,
      gate_results TEXT,
      soft_findings TEXT,
      a_conclusion TEXT,
      b_conclusion TEXT,
      exception_channel TEXT,
      position_suggestion TEXT,
      one_liner TEXT,
      teach_notes TEXT,
      raw_ai_response TEXT,
      sources TEXT,
      validation TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      persona TEXT,
      generated INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, role)
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT,
      title TEXT,
      pinned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_quote_daily_code ON quote_daily (code);
    CREATE TABLE IF NOT EXISTS screenings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_note TEXT,
      results TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_reports_user ON reports (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_screenings_user ON screenings (user_id, created_at);
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      date TEXT NOT NULL,
      content TEXT,
      data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, kind, date)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions (user_id, kind);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);
  `);

  migrate();

  // Registration is invite-only by default; set REGISTRATION_MODE=open to allow self sign-up.
  const mode = process.env.REGISTRATION_MODE === 'open' ? 'open' : 'invite';
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('registration_mode', ?)
     ON CONFLICT(key) DO NOTHING`
  ).run(mode);

  seedDefaultAdmin();
}

// Add columns introduced after an earlier DB was created (SQLite has no ADD COLUMN IF NOT EXISTS).
function migrate(): void {
  const cols = db.prepare('PRAGMA table_info(ai_configs)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'enabled')) {
    db.exec('ALTER TABLE ai_configs ADD COLUMN enabled INTEGER DEFAULT 1');
  }
  const rcols = db.prepare('PRAGMA table_info(reports)').all() as { name: string }[];
  if (rcols.length && !rcols.some((c) => c.name === 'sources')) {
    db.exec('ALTER TABLE reports ADD COLUMN sources TEXT');
  }
  if (rcols.length && !rcols.some((c) => c.name === 'validation')) {
    db.exec('ALTER TABLE reports ADD COLUMN validation TEXT');
  }
  const scols = db.prepare('PRAGMA table_info(chat_sessions)').all() as { name: string }[];
  if (scols.length && !scols.some((c) => c.name === 'pinned')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN pinned INTEGER DEFAULT 0');
  }
  const sccols = db.prepare('PRAGMA table_info(screenings)').all() as { name: string }[];
  if (sccols.length && !sccols.some((c) => c.name === 'discussion')) {
    db.exec('ALTER TABLE screenings ADD COLUMN discussion TEXT');
  }
  const ucols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (ucols.length) {
    if (!ucols.some((c) => c.name === 'nickname')) db.exec('ALTER TABLE users ADD COLUMN nickname TEXT');
    if (!ucols.some((c) => c.name === 'agreed_at')) db.exec('ALTER TABLE users ADD COLUMN agreed_at DATETIME');
    if (!ucols.some((c) => c.name === 'disclaimer_version')) db.exec('ALTER TABLE users ADD COLUMN disclaimer_version TEXT');
  }
  const ncols = db.prepare('PRAGMA table_info(stock_names)').all() as { name: string }[];
  if (ncols.length) {
    if (!ncols.some((c) => c.name === 'py')) db.exec('ALTER TABLE stock_names ADD COLUMN py TEXT');
    if (!ncols.some((c) => c.name === 'industry')) db.exec('ALTER TABLE stock_names ADD COLUMN industry TEXT');
    if (!ncols.some((c) => c.name === 'list_date')) db.exec('ALTER TABLE stock_names ADD COLUMN list_date TEXT');
  }
  // index on py created after the column is guaranteed to exist
  db.exec('CREATE INDEX IF NOT EXISTS idx_stock_names_py ON stock_names (py)');
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
