import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-usage-'));

const { getDb } = require('../db');
const u = require('./usage');

const ADMIN = 'admin-1';
const CFG = 'cfg-1';

beforeAll(() => {
  getDb()
    .prepare(
      'INSERT INTO ai_configs (id, user_id, provider, model, base_url, enabled, shared, share_max_tokens, share_period_seconds) VALUES (?,?,?,?,?,1,1,1000,?)'
    )
    .run(CFG, ADMIN, 'deepseek', 'deepseek-chat', '', 5 * 3600);
  getDb().prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run('uX', 'alice', 'x', 'user');
});

describe('currentWindow', () => {
  it('period 0 => 0 (never reset)', () => expect(u.currentWindow(0)).toBe(0));
  it('period>0 => floored bucket', () => {
    const now = 1_000_000; // seconds
    expect(u.currentWindow(3600, now * 1000)).toBe(Math.floor(now / 3600) * 3600);
  });
});

describe('recordSharedUsage + getUsageForConfig', () => {
  it('accumulates within window and resets across windows', () => {
    u.recordSharedUsage(CFG, 'uX', 100, 10_000_000_000);
    u.recordSharedUsage(CFG, 'uX', 50, 10_000_000_000);
    const rowsA = u.getUsageForConfig(CFG, 5 * 3600, 10_000_000_000);
    expect(rowsA.find((r: any) => r.userId === 'uX')).toMatchObject({ username: 'alice', calls: 2, total_tokens: 150 });

    u.recordSharedUsage(CFG, 'uX', 7, 99_000_000_000);
    const rowsB = u.getUsageForConfig(CFG, 5 * 3600, 99_000_000_000);
    expect(rowsB.find((r: any) => r.userId === 'uX')).toMatchObject({ calls: 1, total_tokens: 7 });
  });
  it('currentConfigUsage sums current window', () => {
    expect(u.currentConfigUsage(CFG, 5 * 3600, 99_000_000_000)).toBe(7);
  });
  it('resetConfigUsage clears rows', () => {
    u.resetConfigUsage(CFG);
    expect(u.getUsageForConfig(CFG, 5 * 3600, 99_000_000_000)).toHaveLength(0);
  });
});
