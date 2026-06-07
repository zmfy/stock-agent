import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cronmeet-'));

const { getDb } = require('../db');
const meetings = require('../meetings/service');
const { runMeetings } = require('./meetings');

const todayBJ = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

describe('meetings cron skips on market-closed days', () => {
  afterEach(() => jest.restoreAllMocks());

  it('skips (does not look up users) when today is NOT a trading day', async () => {
    // 注入一个不含今天的日历 → 今天休市
    getDb().prepare('INSERT OR IGNORE INTO trade_calendar (date) VALUES (?)').run('2020-01-02');
    getDb().prepare('DELETE FROM trade_calendar WHERE date = ?').run(todayBJ());
    const spy = jest.spyOn(meetings, 'eligibleUserIds');
    await runMeetings('morning');
    expect(spy).not.toHaveBeenCalled(); // 休市 → 在查用户前就返回
  });

  it('proceeds (looks up users) when today IS a trading day', async () => {
    getDb().prepare('INSERT OR IGNORE INTO trade_calendar (date) VALUES (?)').run(todayBJ());
    const spy = jest.spyOn(meetings, 'eligibleUserIds').mockReturnValue([]); // 无 eligible 用户即返回
    await runMeetings('morning');
    expect(spy).toHaveBeenCalled();
  });
});
