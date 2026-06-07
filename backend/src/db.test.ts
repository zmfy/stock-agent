import path from 'path';
import os from 'os';
import fs from 'fs';

describe('getDb', () => {
  beforeAll(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-db-'));
    delete process.env.REGISTRATION_MODE; // exercise the default
  });

  it('creates the users, invite_codes and settings tables', () => {
    const { getDb } = require('./db');
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'invite_codes', 'settings']));
  });

  it('returns the same singleton instance', () => {
    const { getDb } = require('./db');
    expect(getDb()).toBe(getDb());
  });

  it('defaults registration mode to invite', () => {
    const { getDb } = require('./db');
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'registration_mode'").get();
    expect(row.value).toBe('invite');
  });

  it('seeds the default admin user stock-agent', () => {
    const { getDb } = require('./db');
    const user = getDb().prepare("SELECT username, role FROM users WHERE username = 'stock-agent'").get();
    expect(user).toBeTruthy();
    expect(user.role).toBe('admin');
  });

  it('creates the rulebook tables', () => {
    const { getDb } = require('./db');
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['rulebook_versions', 'gates', 'soft_rules']));
  });

  it('creates the ai_configs table', () => {
    const { getDb } = require('./db');
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain('ai_configs');
  });

  it('creates the plugins table', () => {
    const { getDb } = require('./db');
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain('plugins');
  });

  it('creates the data-cache tables', () => {
    const { getDb } = require('./db');
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['quote_daily', 'fundamentals', 'market_sentiment']));
  });

  it('sync_status 有治理列，sync_log 表存在', () => {
    const db = require('./db').getDb();
    const cols = db.prepare('PRAGMA table_info(sync_status)').all().map((c: any) => c.name);
    for (const c of ['started_at', 'finished_at', 'last_success_at', 'started_by', 'error', 'cancel_requested', 'source_breakdown']) {
      expect(cols).toContain(c);
    }
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_log'").get();
    expect(t).toBeTruthy();
  });

  it('news_title_log / news_content_log 表存在且列齐全', () => {
    const db = require('./db').getDb();
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('news_title_log','news_content_log')").all().map((r: any) => r.name);
    expect(t).toEqual(expect.arrayContaining(['news_title_log', 'news_content_log']));
    const cc = db.prepare('PRAGMA table_info(news_content_log)').all().map((c: any) => c.name);
    expect(cc).toEqual(expect.arrayContaining(['id','title','content','source','published_at','collected_at','adopted','adopted_at']));
  });
});
