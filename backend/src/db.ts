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

    CREATE TABLE IF NOT EXISTS login_logs (
      id TEXT PRIMARY KEY,
      username TEXT,
      user_id TEXT,
      ip TEXT,
      success INTEGER NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_login_logs_time ON login_logs (created_at);

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

    CREATE TABLE IF NOT EXISTS index_daily (
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
      started_at DATETIME,
      finished_at DATETIME,
      last_success_at DATETIME,
      started_by TEXT,
      error TEXT,
      cancel_requested INTEGER DEFAULT 0,
      source_breakdown TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );


    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log_job ON sync_log (job, id);

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

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions (user_id, kind);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);

    CREATE TABLE IF NOT EXISTS news_content_log (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, source TEXT, published_at TEXT,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, adopted INTEGER DEFAULT 0, adopted_at DATETIME,
      UNIQUE(title, published_at)
    );
    CREATE TABLE IF NOT EXISTS news_title_log (
      id TEXT PRIMARY KEY, content_id TEXT, title TEXT NOT NULL, source TEXT, published_at TEXT,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_news_title_collected ON news_title_log (collected_at);
    CREATE INDEX IF NOT EXISTS idx_news_content_adopted ON news_content_log (adopted, collected_at);
    CREATE TABLE IF NOT EXISTS trade_calendar (
      date TEXT PRIMARY KEY      -- 'YYYY-MM-DD'，仅存 A 股交易日（全局共享）
    );
    CREATE TABLE IF NOT EXISTS realtime_quote (
      code TEXT PRIMARY KEY,
      price REAL, open REAL, high REAL, low REAL, prev_close REAL, volume REAL,
      bid1 REAL, bid1_vol REAL, bid2 REAL, bid2_vol REAL, bid3 REAL, bid3_vol REAL,
      bid4 REAL, bid4_vol REAL, bid5 REAL, bid5_vol REAL,
      ask1 REAL, ask1_vol REAL, ask2 REAL, ask2_vol REAL, ask3 REAL, ask3_vol REAL,
      ask4 REAL, ask4_vol REAL, ask5 REAL, ask5_vol REAL,
      time TEXT, source TEXT, fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
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
  const sycols = db.prepare('PRAGMA table_info(sync_status)').all() as { name: string }[];
  if (sycols.length) {
    const add = (c: string, ddl: string) => { if (!sycols.some((x) => x.name === c)) db.exec(`ALTER TABLE sync_status ADD COLUMN ${ddl}`); };
    add('started_at', 'started_at DATETIME');
    add('finished_at', 'finished_at DATETIME');
    add('last_success_at', 'last_success_at DATETIME');
    add('started_by', 'started_by TEXT');
    add('error', 'error TEXT');
    add('cancel_requested', 'cancel_requested INTEGER DEFAULT 0');
    add('source_breakdown', 'source_breakdown TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, ts DATETIME DEFAULT CURRENT_TIMESTAMP, level TEXT, message TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sync_log_job ON sync_log (job, id)');
  // Dedup data_sources: keep one row per base_url (idempotent)
  const dsHas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='data_sources'").get();
  if (dsHas) db.exec(`DELETE FROM data_sources WHERE id NOT IN (SELECT MIN(rowid) FROM data_sources GROUP BY base_url)`);
  // news dual-log tables (idempotent for old DBs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS news_content_log (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, source TEXT, published_at TEXT,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP, adopted INTEGER DEFAULT 0, adopted_at DATETIME,
      UNIQUE(title, published_at)
    );
    CREATE TABLE IF NOT EXISTS news_title_log (
      id TEXT PRIMARY KEY, content_id TEXT, title TEXT NOT NULL, source TEXT, published_at TEXT,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_news_title_collected ON news_title_log (collected_at);
    CREATE INDEX IF NOT EXISTS idx_news_content_adopted ON news_content_log (adopted, collected_at);
  `);
  // --- admin 共享 AI 模型 + 配额 ---
  const aiCols = db.prepare('PRAGMA table_info(ai_configs)').all() as { name: string }[];
  if (!aiCols.some((c) => c.name === 'shared')) db.exec('ALTER TABLE ai_configs ADD COLUMN shared INTEGER DEFAULT 0');
  if (!aiCols.some((c) => c.name === 'share_max_tokens')) db.exec('ALTER TABLE ai_configs ADD COLUMN share_max_tokens INTEGER DEFAULT 0');
  if (!aiCols.some((c) => c.name === 'share_period_seconds')) db.exec('ALTER TABLE ai_configs ADD COLUMN share_period_seconds INTEGER DEFAULT 0');

  const raCols = db.prepare('PRAGMA table_info(ai_role_assignments)').all() as { name: string }[];
  if (raCols.length && !raCols.some((c) => c.name === 'shared_config_id')) {
    db.exec('ALTER TABLE ai_role_assignments ADD COLUMN shared_config_id TEXT');
  }

  db.exec(`CREATE TABLE IF NOT EXISTS shared_ai_optout (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, config_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, config_id)
  )`);
  const plCols = db.prepare("PRAGMA table_info('plugins')").all() as { name: string }[];
  if (plCols.length && !plCols.some((c) => c.name === 'shared')) {
    db.exec('ALTER TABLE plugins ADD COLUMN shared INTEGER DEFAULT 0');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS shared_plugin_optout (
    user_id TEXT NOT NULL,
    plugin_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, plugin_key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS shared_ai_usage (
    config_id TEXT NOT NULL, user_id TEXT NOT NULL,
    calls INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, window_start INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (config_id, user_id)
  )`);
  // 定时任务运行追踪（nightly/早晚会原本无任何记录）
  db.exec(`CREATE TABLE IF NOT EXISTS cron_status (
    key TEXT PRIMARY KEY,
    last_run_at DATETIME,
    last_status TEXT,
    last_duration_ms INTEGER,
    last_error TEXT,
    run_count INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS daily_strategy (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    phase TEXT NOT NULL,
    content TEXT,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_daily_strategy_user_date ON daily_strategy (user_id, date, phase)');
  const dsCols = db.prepare('PRAGMA table_info(daily_strategy)').all() as { name: string }[];
  if (dsCols.length && !dsCols.some((c) => c.name === 'updated_at')) {
    db.exec('ALTER TABLE daily_strategy ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
  }
  const dscCols = db.prepare('PRAGMA table_info(daily_strategy_config)').all() as { name: string }[];
  if (dscCols.length && !dscCols.some((c) => c.name === 'updated_at')) {
    db.exec('ALTER TABLE daily_strategy_config ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS daily_strategy_config (
    user_id TEXT PRIMARY KEY,
    prejudge_time TEXT DEFAULT '08:30',
    intraday_interval INTEGER DEFAULT 60,
    review_time TEXT DEFAULT '15:30',
    holiday_brief_time TEXT DEFAULT '09:00',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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
