import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-synth-'));

const syn = require('./synthesize-service');
const rb = require('./service');
const chat = require('../chat/service');

const USER = 'u-synth';

function makeSession(): string {
  const sid = chat.createSession(USER, 'core_principle', null, '当前策略探讨');
  return sid;
}

describe('validateSynth', () => {
  it('keeps whitelist fields/ops, drops illegal ones, normalizes veto', () => {
    const { versionLabel, proposal } = syn.validateSynth({
      versionLabel: '我的原则 v1',
      persona: '价值党',
      gates: [
        { system: 'A', gate_key: 'roe', label: 'ROE', field: 'roe_ttm', op: '>=', threshold: '12', unit: '%', veto: 1, teach: 't' },
        { system: 'A', gate_key: 'bad', label: 'x', field: 'made_up_field', op: '>=', threshold: 1 },
        { system: 'A', gate_key: 'badop', label: 'y', field: 'pe', op: '!!', threshold: 1 },
        { system: 'B', gate_key: 'lu', label: '涨停', field: 'limit_up_count', op: '>', threshold: 40, veto: 0 },
      ],
      softRules: [{ system: 'A', text: '看现金流', teach: 'x' }, { text: '' }],
      positionRules: { single_stock_cap_pct: { A: 20 } },
    });
    expect(versionLabel).toBe('我的原则 v1');
    expect(proposal.gates.map((g: any) => g.gate_key)).toEqual(['roe', 'lu']);
    expect(proposal.gates[0].threshold).toBe(12);
    expect(proposal.gates[0].veto).toBe(1);
    expect(proposal.softRules).toHaveLength(1);
    expect(proposal.persona).toBe('价值党');
  });

  it('defaults versionLabel when missing', () => {
    const { versionLabel } = syn.validateSynth({
      gates: [{ system: 'A', gate_key: 'pe', label: 'PE', field: 'pe', op: '<', threshold: 30 }],
    });
    expect(versionLabel).toBe('我的原则 v1');
  });

  it('throws SYNTH_EMPTY when no legal gate survives', () => {
    expect(() => syn.validateSynth({ gates: [{ field: 'nope', op: '>=', gate_key: 'a' }] })).toThrow('SYNTH_EMPTY');
  });
});

describe('parseSynth', () => {
  it('extracts JSON from surrounding noise', () => {
    expect(syn.parseSynth('思考...{"versionLabel":"x","gates":[]}尾巴')).toEqual({ versionLabel: 'x', gates: [] });
  });
  it('returns null on garbage', () => {
    expect(syn.parseSynth('no json here')).toBeNull();
  });
});

describe('buildSynthesizePrompt', () => {
  it('includes the field whitelist and JSON-only instruction', () => {
    const p = syn.buildSynthesizePrompt('用户：我只买低估值高ROE的票');
    expect(p).toContain('roe_ttm');
    expect(p).toContain('limit_up_count');
    expect(p).toContain('用户：我只买低估值高ROE的票');
    expect(p).toContain('只输出一个 JSON');
  });
});

describe('synthesizeRulebook', () => {
  it('reads session conversation, calls AI, returns proposal + suggestedLabel', async () => {
    const sid = makeSession();
    chat.postMessage(USER, sid, '我只买 ROE 高于 15、PE 低于 30 的好公司', {
      aiCall: async () => ({ raw: '好的', provider: 'p', model: 'm' }),
    });
    const out = await syn.synthesizeRulebook(USER, sid, {
      aiCall: async () =>
        JSON.stringify({
          versionLabel: '价值 v1',
          persona: '价值党',
          gates: [{ system: 'A', gate_key: 'roe', label: 'ROE', field: 'roe_ttm', op: '>=', threshold: 15, veto: 1, teach: 't' }],
          softRules: [],
          positionRules: {},
        }),
    });
    expect(out.suggestedLabel).toBe('价值 v1');
    expect(out.proposal.gates).toHaveLength(1);
    expect(out.proposal.note).toBe('从访谈合成当前策略');
  });

  it('throws PARSE_FAILED on non-JSON AI output', async () => {
    const sid = makeSession();
    await expect(syn.synthesizeRulebook(USER, sid, { aiCall: async () => '我想想' })).rejects.toThrow('PARSE_FAILED');
  });
});
