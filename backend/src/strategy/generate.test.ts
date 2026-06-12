import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-strat-gen-'));

const { getDb } = require('../db');
const svc = require('./service');
const gen = require('./generate');

const U = 'u1';
beforeEach(() => {
  getDb().exec('DELETE FROM daily_strategy; DELETE FROM daily_strategy_config; DELETE FROM news_title_log; DELETE FROM news_content_log;');
});

function recordingAi(reply = '核心结论') {
  const prompts: string[] = [];
  const aiCall = async (p: string) => { prompts.push(p); return reply; };
  return { aiCall, prompts };
}
const D = '2026-06-10';
const NOON = Date.UTC(2026, 5, 10, 4, 0, 0);

describe('generators 落库到正确 phase', () => {
  it('预判 → daily_strategy.phase=prejudge', async () => {
    const { aiCall } = recordingAi('今日偏多，关注券商');
    await gen.generatePrejudge(U, { aiCall, fetchNews: async () => {}, now: Date.UTC(2026, 5, 10, 0, 0, 0) });
    expect(svc.getStrategy(U, D, 'prejudge')?.content).toContain('今日偏多');
  });
  it('盘中 → 累积 intraday', async () => {
    const { aiCall } = recordingAi('盘中：放量上行');
    await gen.generateIntraday(U, { aiCall, now: NOON });
    await gen.generateIntraday(U, { aiCall, now: NOON });
    expect(svc.getIntradayTimeline(U, D)).toHaveLength(2);
  });
  it('复盘 → phase=review，且 prompt 含当天预判 + 盘中', async () => {
    svc.recordStrategy(U, 'prejudge', '【预判】偏多', {}, D);
    svc.recordStrategy(U, 'intraday', '【盘中】券商冲高', {}, D);
    const { aiCall, prompts } = recordingAi('复盘：预判方向对，券商兑现');
    await gen.generateReview(U, { aiCall, now: Date.UTC(2026, 5, 10, 8, 0, 0) });
    expect(svc.getStrategy(U, D, 'review')?.content).toContain('复盘');
    const joined = prompts.join('\n');
    expect(joined).toContain('偏多');
    expect(joined).toContain('券商冲高');
  });
  it('休市快报 → phase=holiday', async () => {
    const { aiCall } = recordingAi('节假日消息面：xxx；可能受影响板块：旅游');
    await gen.generateHoliday(U, { aiCall, fetchNews: async () => {}, now: NOON });
    expect(svc.getStrategy(U, D, 'holiday')?.content).toContain('受影响板块');
  });
});

describe('预判新闻窗口=自上一交易日以来(覆盖节后)', () => {
  it('预判 prompt 含上一交易日之后采集的新闻标题', async () => {
    const cid = 'c1';
    getDb().prepare("INSERT INTO news_content_log (id, title, content, source, collected_at) VALUES (?, '节前重大利好', '正文', 'test', datetime('now','-1 day'))").run(cid);
    getDb().prepare("INSERT INTO news_title_log (id, content_id, title, source, collected_at) VALUES ('t1', ?, '节前重大利好', 'test', datetime('now','-1 day'))").run(cid);
    const { aiCall, prompts } = recordingAi('预判');
    await gen.generatePrejudge(U, { aiCall, fetchNews: async () => {}, now: Date.now() });
    expect(prompts.join('\n')).toContain('节前重大利好');
  });
});
