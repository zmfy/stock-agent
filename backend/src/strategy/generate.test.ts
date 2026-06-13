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
  it('四类生成 prompt 均要求首行输出「结论：」', async () => {
    const p1 = recordingAi(); await gen.generatePrejudge(U, { aiCall: p1.aiCall, fetchNews: async () => {}, now: NOON });
    const p2 = recordingAi(); await gen.generateIntraday(U, { aiCall: p2.aiCall, now: NOON });
    const p3 = recordingAi(); await gen.generateReview(U, { aiCall: p3.aiCall, now: NOON });
    const p4 = recordingAi(); await gen.generateHoliday(U, { aiCall: p4.aiCall, fetchNews: async () => {}, now: NOON });
    for (const p of [p1, p2, p3, p4]) {
      expect(p.prompts.join('\n')).toContain('结论：');
    }
  });
});

describe('预判新闻窗口=自上一交易日以来(覆盖节后)', () => {
  // now 钉死在 NOON(北京 2026-06-10 周三)→ 无日历兜底下 lastTradingDayBefore='2026-06-09'(周二)，
  // 窗口起点 '2026-06-09 00:00:00'。新闻 collected_at 也用固定值，避免依赖真实时钟造成 flaky。
  it('预判 prompt 含上一交易日之后采集的新闻标题', async () => {
    const cid = 'c1';
    getDb().prepare("INSERT INTO news_content_log (id, title, content, source, collected_at) VALUES (?, '节前重大利好', '正文', 'test', '2026-06-09 12:00:00')").run(cid);
    getDb().prepare("INSERT INTO news_title_log (id, content_id, title, source, collected_at) VALUES ('t1', ?, '节前重大利好', 'test', '2026-06-09 12:00:00')").run(cid);
    const { aiCall, prompts } = recordingAi('预判');
    await gen.generatePrejudge(U, { aiCall, fetchNews: async () => {}, now: NOON });
    expect(prompts.join('\n')).toContain('节前重大利好');
  });

  // 窗口边界：上一交易日之前(更早)采集的新闻不应进入预判窗口。
  it('预判 prompt 不含上一交易日之前的旧新闻', async () => {
    const cid = 'c2';
    getDb().prepare("INSERT INTO news_content_log (id, title, content, source, collected_at) VALUES (?, '陈年旧闻', '正文', 'test', '2026-06-01 12:00:00')").run(cid);
    getDb().prepare("INSERT INTO news_title_log (id, content_id, title, source, collected_at) VALUES ('t2', ?, '陈年旧闻', 'test', '2026-06-01 12:00:00')").run(cid);
    const { aiCall, prompts } = recordingAi('预判');
    await gen.generatePrejudge(U, { aiCall, fetchNews: async () => {}, now: NOON });
    expect(prompts.join('\n')).not.toContain('陈年旧闻');
  });
});
