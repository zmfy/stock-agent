import path from 'path';
import os from 'os';
import fs from 'fs';

describe('getDb', () => {
  beforeAll(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-db-'));
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
});
