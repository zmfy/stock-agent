import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cron-'));

const { eodDaysForRun } = require('./shared-data');
const db = require('../db').getDb();

it('首次（quote_daily 空）→ 365 天', () => {
  expect(eodDaysForRun()).toBe(365);
});

it('已有数据 → 增量（>=2 且 <365）', () => {
  db.prepare(
    "INSERT OR IGNORE INTO quote_daily (code,date,close,source,fetched_at) VALUES ('600519','2026-06-01',1,'tx',CURRENT_TIMESTAMP)"
  ).run();
  const d = eodDaysForRun();
  expect(d).toBeGreaterThanOrEqual(2);
  expect(d).toBeLessThan(365);
});
