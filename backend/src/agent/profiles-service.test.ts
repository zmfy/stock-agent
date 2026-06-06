import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-profiles-'));

const svc = require('./profiles-service');
const A = 'u-A';
const B = 'u-B';

describe('agent profiles', () => {
  it('lists 5 roles with defaults when unset', () => {
    const list = svc.listProfiles(A);
    expect(list.map((p: any) => p.role)).toEqual(['core', 'data', 'analysis', 'qualitative', 'review']);
    expect(list.every((p: any) => p.persona.length > 0)).toBe(true);
    expect(list.find((p: any) => p.role === 'core').label).toBe('主 agent');
  });

  it('setProfile persists and getCorePersona reflects it; per-user isolated', () => {
    svc.setProfile(A, 'core', '我是激进短线主 agent');
    expect(svc.getCorePersona(A)).toBe('我是激进短线主 agent');
    expect(svc.getCorePersona(B)).not.toBe('我是激进短线主 agent'); // B still default
  });

  it('generateSubAgents (mocked AI) drafts and persists the 4 sub personas', async () => {
    const fakeAI = async () =>
      JSON.stringify({ data: '快取数子助手', analysis: '严谨分析子助手', qualitative: '研报归纳子助手', review: '复盘子助手' });
    const out = await svc.generateSubAgents(A, { aiCall: fakeAI });
    expect(out.map((o: any) => o.role).sort()).toEqual(['analysis', 'data', 'qualitative', 'review']);
    const list = svc.listProfiles(A);
    expect(list.find((p: any) => p.role === 'analysis').persona).toBe('严谨分析子助手');
    expect(list.find((p: any) => p.role === 'analysis').generated).toBe(true);
  });

  it('falls back to default persona when AI returns garbage', async () => {
    const out = await svc.generateSubAgents(B, { aiCall: async () => '不是JSON' });
    expect(out.find((o: any) => o.role === 'data').persona.length).toBeGreaterThan(0);
  });
});
