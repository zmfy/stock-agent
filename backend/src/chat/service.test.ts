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
});
