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

describe('meetings service', () => {
  it('generateMorning is a multi-agent discussion; core synthesis prompt carries market + rulebook', async () => {
    const roles: string[] = [];
    let corePrompt = '';
    const m = await svc.generateMorning(USER, {
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
    await svc.generateMorning(USER, { aiCall: async () => '更新后的早会' });
    expect(svc.getTodayContent(USER, 'morning')).toContain('更新后的早会');
  });

  it('eligibleUserIds includes a user with rulebook (model required) ', () => {
    // USER has rulebook but no AI model configured -> not eligible
    expect(svc.eligibleUserIds()).not.toContain(USER);
  });
});
