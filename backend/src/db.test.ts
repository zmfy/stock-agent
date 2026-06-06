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
});
