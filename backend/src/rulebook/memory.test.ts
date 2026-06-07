import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cpmem-'));
const mem = require('./memory');

it('summarizeChangeReason 拼讨论+变更描述、调 aiCall', async () => {
  let seen = '';
  const aiCall = async (p: string) => { seen = p; return '因为用户认为龙头稀缺，放宽 ROE 门槛'; };
  const r = await mem.summarizeChangeReason({ persona: '来财', discussion: '用户：ROE 10 太严\n助手：可放宽', changeDesc: 'A_roe_ttm 10→8', aiCall });
  expect(r).toContain('放宽 ROE');
  expect(seen).toContain('A_roe_ttm 10→8');
  expect(seen).toContain('ROE 10 太严');
});
it('summarizeChangeReason: aiCall 失败走兜底文案', async () => {
  const r = await mem.summarizeChangeReason({ persona: '', discussion: '', changeDesc: '换入模板：价值质量', aiCall: async () => { throw new Error('x'); } });
  expect(r).toBe('换入模板：价值质量');
});
