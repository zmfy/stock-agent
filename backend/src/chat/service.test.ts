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

describe('core_principle framing branches on rulebook presence', () => {
  const chat = require('./service');
  const rb = require('../rulebook/service');

  it('no rulebook => interview framing in prompt', async () => {
    const U = 'u-cp-interview';
    const sid = chat.createSession(U, 'core_principle', null, '核心原则探讨');
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
    const sid = chat.createSession(U, 'core_principle', null, '核心原则探讨');
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
