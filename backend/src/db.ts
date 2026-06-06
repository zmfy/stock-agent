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
