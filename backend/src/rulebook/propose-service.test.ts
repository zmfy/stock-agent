import path from 'path';
import os from 'os';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-propose-'));

const ps = require('./propose-service');
const rb = require('./service');
const chat = require('../chat/service');
const { getDb } = require('../db');
const USER = 'u-prop';

beforeAll(() => {
  rb.instantiateBaseline(USER); // V3.0
});

// Build an AI response = a CHANGE PATCH (new robust format).
function aiPatch(patch: any) {
  return async () => JSON.stringify(patch);
}

describe('nextLabel', () => {
  it('bumps minor and major on Vx.y', () => {
    expect(ps.nextLabel('V3.0', 'minor')).toBe('V3.1');
    expect(ps.nextLabel('V3.0', 'major')).toBe('V4.0');
  });
  it('handles labels without a dotted version', () => {
    expect(ps.nextLabel('价值质量 v1', 'minor')).toBe('价值质量 v1.1');
    expect(ps.nextLabel('价值质量 v1', 'major')).toBe('价值质量 v2.0');
  });
});

describe('proposeChange', () => {
  it('threshold tweak => minor, suggested V3.1, diff shows roe change', async () => {
    const r = await ps.proposeChange(USER, '把 ROE 放宽到 8', {
      aiCall: aiPatch({ note: '放宽ROE', gate_updates: [{ gate_key: 'roe_ttm', threshold: 8 }] }),
    });
    expect(r.magnitude).toBe('minor');
    expect(r.suggestedLabel).toBe('V3.1');
    const roe = r.delta.gates.changed.find((c: any) => c.gate_key === 'roe_ttm');
    expect(roe.from.threshold).toBe(10);
    expect(roe.to.threshold).toBe(8);
  });

  it('removing a gate => major, suggested V4.0', async () => {
    const r = await ps.proposeChange(USER, '去掉市销率门槛', {
      aiCall: aiPatch({ note: '去掉PS', gates_remove: ['ps'] }),
    });
    expect(r.magnitude).toBe('major');
    expect(r.suggestedLabel).toBe('V4.0');
    expect(r.delta.gates.removed).toContain('ps');
  });

  it('PARSE_FAILED on garbage AI output', async () => {
    await expect(ps.proposeChange(USER, 'x', { aiCall: async () => '不是JSON' })).rejects.toThrow('PARSE_FAILED');
  });
});

describe('applyProposal', () => {
  it('creates + activates a new agent-authored version with the bumped label', async () => {
    const r = await ps.proposeChange(USER, '把 ROE 放宽到 8', {
      aiCall: aiPatch({ note: '放宽ROE', gate_updates: [{ gate_key: 'roe_ttm', threshold: 8 }] }),
    });
    const applied = await ps.applyProposal(USER, r.proposal, r.suggestedLabel);
    expect(applied.version.version_label).toBe('V3.1');
    expect(applied.version.author).toBe('agent');
    expect(applied.version.is_active).toBe(1);
    const active = rb.getActive(USER);
    expect(active.version.id).toBe(applied.version.id);
    expect(active.gates.find((g: any) => g.gate_key === 'roe_ttm').threshold).toBe(8);
    // old V3.0 retained in history
    expect(rb.listVersions(USER).some((v: any) => v.version_label === 'V3.0')).toBe(true);
  });

  it('applyProposal 带 sessionId 把 AI 总结的理由写进 note', async () => {
    // baseline: apply value-quality template
    await rb.applyTemplateAsVersion(USER, 'value-quality');
    // create a core_principle session
    const sid = chat.createSession(USER, 'core_principle', null, '讨论');
    // insert a user message directly so discussion is non-empty
    const db = getDb();
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
      uuidv4(), sid, 'user', '我觉得龙头稀缺，想放宽门槛'
    );
    const active = rb.getActive(USER);
    const proposal = {
      persona: active.version.persona,
      note: '机械理由',
      gates: active.gates,
      softRules: active.softRules,
      positionRules: active.positionRules,
    };
    const out = await ps.applyProposal(USER, proposal, 'V9.9', sid, async () => '因为龙头稀缺要放宽');
    expect(rb.getActive(USER).version.note).toContain('龙头稀缺');
    expect(out.version.version_label).toBe('V9.9');
  });

  it('first version (no active rulebook) creates+activates without an AI summary call', async () => {
    const NEWUSER = 'u-firstver';
    expect(rb.getActive(NEWUSER)).toBeNull();
    const sid = chat.createSession(NEWUSER, 'core_principle', null, '访谈');
    const db = getDb();
    db.prepare('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(
      uuidv4(), sid, 'user', '我只买低估值高ROE的票'
    );
    const proposal = {
      persona: '价值党',
      note: '从访谈合成核心原则',
      gates: [{ system: 'A', gate_key: 'roe_ttm', label: 'ROE', field: 'roe_ttm', op: '>=', threshold: 15, threshold2: null, ref_field: null, unit: '%', veto: 1, teach: 't' }],
      softRules: [],
      positionRules: {},
    };
    // aiCall would throw if invoked — proves the first-version path skips summarizeChangeReason even with sessionId.
    const out = await ps.applyProposal(NEWUSER, proposal, '我的原则 v1', sid, async () => {
      throw new Error('AI_SHOULD_NOT_BE_CALLED');
    });
    expect(out.version.version_label).toBe('我的原则 v1');
    expect(out.version.note).toBe('从访谈合成核心原则');
    const activeNow = rb.getActive(NEWUSER);
    expect(activeNow.version.version_label).toBe('我的原则 v1');
    expect(activeNow.gates).toHaveLength(1);
  });
});
