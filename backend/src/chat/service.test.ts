import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-chat-svc-'));

const USER = 'u-chat-svc';

describe('chat service', () => {
  it('core_principle 的 prompt 注入版本变更记忆', async () => {
    const svc = require('./service');
    const rb = require('../rulebook/service');
    await rb.applyTemplateAsVersion(USER, 'value-quality');   // 造一个带 note 的版本
    const sid = svc.createSession(USER, 'core_principle', null, '讨论'); // returns string id directly
    let seen = '';
    await svc.postMessage(USER, sid, '聊聊', { aiCall: async (p: string) => { seen = p; return { raw: 'ok' }; } });
    expect(seen).toContain('原则演进记忆');
  });

  it('screen 会话 prompt 注入最近选股摘要', async () => {
    const svc = require('./service');
    const sc = require('../screen/service');
    const rb = require('../rulebook/service');
    await rb.applyTemplateAsVersion(USER, 'value-quality');
    await sc.runScreen(USER, { codes: ['600519'] });
    const sid = svc.createSession(USER, 'screen', null, '选股讨论');
    let seen = '';
    await svc.postMessage(USER, sid, '为什么选它', { aiCall: async (p: string) => { seen = p; return { raw: 'ok' }; } });
    expect(seen).toContain('本次选股');
  });
});

describe('postMessage injects market context for stock target', () => {
  it('stock session prompt includes recent bars table', async () => {
    const U = 'u-mc-inject';
    const code = 'INJ01';
    const chat = require('./service');
    const { getDb } = require('../db');
    const db = getDb();
    const days = ['2026-04-01','2026-04-02','2026-04-03','2026-04-04','2026-04-07'];
    days.forEach((d, i) => db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)').run(code, d, 1,1,1, 100+i, 1, 'test'));
    const sid = chat.createSession(U, 'stock', code, `个股 ${code}`);
    let captured = '';
    await chat.postMessage(U, sid, '最近走势如何', {
      aiCall: async (p: string) => { captured = p; return { raw: 'ok', provider: 'p', model: 'm' }; },
    });
    expect(captured).toContain('日期│开│高│低│收│量');
    expect(captured).toContain(code);
  });
});

describe('postMessage injects index context for 大盘 target', () => {
  it('general chat about 大盘 includes index/sentiment block', async () => {
    const U = 'u-mc-index';
    const chat = require('./service');
    const { getDb } = require('../db');
    const db = getDb();
    for (const d of ['2026-06-01','2026-06-02','2026-06-03','2026-06-04','2026-06-05']) {
      db.prepare('INSERT OR REPLACE INTO index_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)')
        .run('000001', d, 3000,3010,2990, 3000 + Number(d.slice(-2)), 1, 'test');
      db.prepare('INSERT OR REPLACE INTO market_sentiment (date,limit_up_count,limit_down_count,sse_ma20_slope,source) VALUES (?,?,?,?,?)')
        .run(d, 50, 10, 0.1, 'test');
    }
    const sid = chat.createSession(U, 'general', null, '闲聊');
    let captured = '';
    await chat.postMessage(U, sid, '大盘最近走势如何', {
      aiCall: async (p: string) => { captured = p; return { raw: 'ok', provider: 'p', model: 'm' }; },
    });
    expect(captured).toContain('大盘');
    expect(captured).toContain('涨停');
  });
});

describe('core_principle framing branches on rulebook presence', () => {
  const chat = require('./service');
  const rb = require('../rulebook/service');

  it('no rulebook => interview framing in prompt', async () => {
    const U = 'u-cp-interview';
    const sid = chat.createSession(U, 'core_principle', null, '当前策略探讨');
    let captured = '';
    await chat.postMessage(U, sid, '我想定个原则', {
      aiCall: async (p: string) => {
        captured = p;
        return { raw: '好的，我们开始', provider: 'p', model: 'm' };
      },
    });
    expect(captured).toContain('引导式');
    expect(captured).toContain('一次只问');
    expect(captured).not.toContain('探讨核心选股/操作原则的修改');
  });

  it('has rulebook => modify framing in prompt', async () => {
    const U = 'u-cp-modify';
    rb.instantiateBaseline(U);
    const sid = chat.createSession(U, 'core_principle', null, '当前策略探讨');
    let captured = '';
    await chat.postMessage(U, sid, '把 ROE 放宽', {
      aiCall: async (p: string) => {
        captured = p;
        return { raw: '建议如下', provider: 'p', model: 'm' };
      },
    });
    expect(captured).toContain('探讨核心选股/操作原则的修改');
  });
});

describe('addAssistantNote', () => {
  it('appends an assistant message to an owned session; null for foreign session', () => {
    const chat = require('./service');
    const U = 'u-note';
    const sid = chat.createSession(U, 'screen', null, '选股');
    const m = chat.addAssistantNote(U, sid, '⚠️ 选股失败：没有可用模型');
    expect(m).toBeTruthy();
    expect(m.role).toBe('assistant');
    expect(m.content).toContain('选股失败');
    const msgs = chat.getMessages(U, sid);
    expect(msgs.some((x: any) => x.content.includes('选股失败'))).toBe(true);
    expect(chat.addAssistantNote('someone-else', sid, 'x')).toBeNull();
  });
});
