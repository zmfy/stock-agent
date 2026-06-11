import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-meetings-'));

const svc = require('./service');
const rb = require('../rulebook/service');
const data = require('../data/service');
const USER = 'u-meet';

beforeAll(() => {
  rb.instantiateBaseline(USER);
  data.cacheMarket(svc.today(), { limit_up_count: 73, limit_down_count: 11, sse_ma20_slope: -7.6 }, 'test');
});

describe('today() uses Beijing calendar day', () => {
  afterEach(() => jest.useRealTimers());
  it('returns the Beijing date even when UTC is still the previous day', () => {
    // 2026-06-07T17:00:00Z = 2026-06-08 01:00 北京 → today() 应为 06-08（而非 UTC 的 06-07）
    jest.useFakeTimers().setSystemTime(new Date('2026-06-07T17:00:00Z'));
    expect(svc.today()).toBe('2026-06-08');
  });
});

describe('meetings service', () => {
  it('generateMorning is a multi-agent discussion; core synthesis prompt carries market + rulebook', async () => {
    const roles: string[] = [];
    let corePrompt = '';
    const m = await svc.generateMorning(USER, {
      fetchNews: async () => {},
      aiCall: async (p: string, role: string) => {
        roles.push(role);
        if (role === 'core') {
          corePrompt = p;
          return '今日大盘情绪偏冷，A 系统谨慎、B 系统空仓；以防守为主。主要采纳分析师的结论。';
        }
        return `（${role} 的汇报）`;
      },
    });
    expect(m.kind).toBe('morning');
    // 四个角色都参与了讨论
    expect(roles).toEqual(['data', 'analysis', 'qualitative', 'core']);
    // 内容含各子助手分段 + 来财综合研判
    expect(m.content).toContain('数据员');
    expect(m.content).toContain('分析师');
    expect(m.content).toContain('情绪面');
    expect(m.content).toContain('来财综合研判');
    expect(m.content).toContain('防守');
    // 综合（core）prompt 带大盘数据与规则版本
    expect(corePrompt).toContain('涨停 73');
    expect(corePrompt).toContain('V3.0');
    // 讨论过程留痕到 data
    expect(JSON.parse(m.data).discussion.core).toContain('防守');
  });

  it('generateEvening is a multi-agent review; core synthesis references the morning (forecast) content', async () => {
    const roles: string[] = [];
    let corePrompt = '';
    const e = await svc.generateEvening(USER, {
      fetchNews: async () => {},
      aiCall: async (p: string, role: string) => {
        roles.push(role);
        if (role === 'core') corePrompt = p;
        return `（${role}）复盘要点`;
      },
    });
    expect(e.kind).toBe('evening');
    expect(roles).toEqual(['data', 'analysis', 'review', 'core']);
    expect(e.content).toContain('晚会复盘');
    expect(e.content).toContain('来财复盘结论');
    expect(corePrompt).toContain('防守'); // 早会内容（含板块预测）被带入复盘
  });

  it('getToday returns both; getTodayContent returns text', () => {
    const t = svc.getToday(USER);
    expect(t.morning).toBeTruthy();
    expect(t.evening).toBeTruthy();
    expect(svc.getTodayContent(USER, 'morning')).toContain('防守');
  });

  it('regenerating the same day upserts (no duplicate)', async () => {
    await svc.generateMorning(USER, { fetchNews: async () => {}, aiCall: async () => '更新后的早会' });
    expect(svc.getTodayContent(USER, 'morning')).toContain('更新后的早会');
  });

  it('eligibleUserIds includes a user with rulebook (model required) ', () => {
    // USER has rulebook but no AI model configured -> not eligible
    expect(svc.eligibleUserIds()).not.toContain(USER);
  });

  it('generateMorning 采集新闻入双日志，来财 __ADOPT__ 标记采用并存 adopted_news', async () => {
    const m = require('./service');
    const nl = require('../data/news-log');
    require('../data/sources-service').ensureSeedGlobal?.();
    const recs = nl.recordCollected([{ title: '新能源爆发', content: 'c1', source: 'em', published_at: 'p1' }, { title: '银行走弱', content: 'c2', source: 'em', published_at: 'p2' }]);
    // buildNewsWithIds orders by collected_at DESC, rowid DESC — both inserted in same tx,
    // so rowid of '银行走弱' > rowid of '新能源爆发', meaning N1 = '银行走弱', N2 = '新能源爆发'.
    const aiCall = async (_p: string, role: string) => role === 'core' ? '今日新能源板块占优。\n__ADOPT__ N2' : `[${role}]`;
    const r = await m.generateMorning('u1', { aiCall, fetchNews: async () => {} });
    const parsedData = JSON.parse(r.data);
    expect(parsedData.adopted_news.map((x: any) => x.title)).toContain('新能源爆发');
    expect(r.content).not.toContain('__ADOPT__');
  });

  // 放在最后：本用例会注入 trade_calendar/新闻并重生成早会，避免污染依赖早会内容的其它用例。
  it('morning meeting news window = since last trading day (covers closed-day accumulation, excludes older)', async () => {
    const db = require('../db').getDb();
    const now = new Date();
    const bj = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const prev = new Date(now); prev.setUTCDate(prev.getUTCDate() - 2);
    // 注入日历：今天与两天前为交易日 → lastTradingDayBefore(today)=两天前=since
    const insCal = db.prepare('INSERT OR IGNORE INTO trade_calendar (date) VALUES (?)');
    insCal.run(bj(now)); insCal.run(bj(prev));
    // 注入新闻：一条今天采集(应保留)，一条 10 天前采集(应排除)
    const old = new Date(now); old.setUTCDate(old.getUTCDate() - 10);
    const insNews = db.prepare('INSERT OR IGNORE INTO news_content_log (id, title, content, source, published_at, collected_at) VALUES (?, ?, ?, ?, ?, ?)');
    insNews.run('nw-recent', '休市期间重磅财经新闻RECENT', 'x', 'test', '2026-06-06', now.toISOString());
    insNews.run('nw-old', '十天前旧闻OLD', 'x', 'test', '2026-05-20', old.toISOString());

    let dataPrompt = '';
    await svc.generateMorning(USER, {
      fetchNews: async () => {},
      aiCall: async (p: string, role: string) => { if (role === 'data') dataPrompt = p; return `（${role}）`; },
    });
    expect(dataPrompt).toContain('自上个交易日');
    expect(dataPrompt).toContain('休市期间重磅财经新闻RECENT');
    expect(dataPrompt).not.toContain('十天前旧闻OLD');
  });
});

describe('meeting prompts honor hasRulebook', () => {
  it('morning analysis: no rulebook => no A/B gate language, forbids picking stocks', () => {
    const p = svc.buildMorningAnalysisPrompt('persona', '大盘数据', '（用户尚未设定当前策略）', '数据整理', false);
    expect(p).toContain('只研判大盘');
    expect(p).toContain('不要推荐或点名任何个股');
    expect(p).not.toContain('A / B 系统今日是否开闸');
  });

  it('morning analysis: has rulebook => keeps gate language', () => {
    const p = svc.buildMorningAnalysisPrompt('persona', '大盘数据', '硬门槛：A:ROE', '数据整理', true);
    expect(p).toContain('A / B 系统今日是否开闸');
  });

  it('morning synth: no rulebook => forbids individual stocks', () => {
    const p = svc.buildMorningSynthPrompt('persona', '大盘', '（用户尚未设定当前策略）', 'd', 'a', 'q', false);
    expect(p).toContain('不要推荐或点名任何个股');
  });

  it('evening synth: no rulebook => forbids individual stocks', () => {
    const p = svc.buildEveningSynthPrompt('persona', '大盘', null, 'd', 'a', 'r', false);
    expect(p).toContain('不要推荐或点名任何个股');
  });

  it('evening review: no rulebook => no rule-tuning-by-gate language', () => {
    const p = svc.buildEveningReviewPrompt('persona', '（用户尚未设定当前策略）', 'analysis', [], false);
    expect(p).toContain('只复盘大盘与板块');
  });
});
