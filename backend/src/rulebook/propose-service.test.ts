import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-propose-'));

const ps = require('./propose-service');
const rb = require('./service');
const USER = 'u-prop';

beforeAll(() => {
  rb.instantiateBaseline(USER); // V3.0
});

// Build an AI response = the active rulebook serialized with a mutation applied.
function aiReturning(mutate: (cur: any) => void) {
  return async () => {
    const active = rb.getActive(USER);
    const cur = {
      persona: active.version.persona,
      note: 'test change',
      gates: active.gates.map((g: any) => ({
        gate_key: g.gate_key, system: g.system, label: g.label, field: g.field, op: g.op,
        threshold: g.threshold, threshold2: g.threshold2, ref_field: g.ref_field, unit: g.unit, veto: g.veto, teach: g.teach,
      })),
      softRules: active.softRules.map((r: any) => ({ system: r.system, text: r.text, teach: r.teach })),
      positionRules: active.positionRules,
    };
    mutate(cur);
    return JSON.stringify(cur);
  };
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
      aiCall: aiReturning((cur) => {
        cur.gates.find((g: any) => g.gate_key === 'roe_ttm').threshold = 8;
      }),
    });
    expect(r.magnitude).toBe('minor');
    expect(r.suggestedLabel).toBe('V3.1');
    const roe = r.delta.gates.changed.find((c: any) => c.gate_key === 'roe_ttm');
    expect(roe.from.threshold).toBe(10);
    expect(roe.to.threshold).toBe(8);
  });

  it('removing a gate => major, suggested V4.0', async () => {
    const r = await ps.proposeChange(USER, '去掉市销率门槛', {
      aiCall: aiReturning((cur) => {
        cur.gates = cur.gates.filter((g: any) => g.gate_key !== 'ps');
      }),
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
      aiCall: aiReturning((cur) => {
        cur.gates.find((g: any) => g.gate_key === 'roe_ttm').threshold = 8;
      }),
    });
    const applied = ps.applyProposal(USER, r.proposal, r.suggestedLabel);
    expect(applied.version.version_label).toBe('V3.1');
    expect(applied.version.author).toBe('agent');
    expect(applied.version.is_active).toBe(1);
    const active = rb.getActive(USER);
    expect(active.version.id).toBe(applied.version.id);
    expect(active.gates.find((g: any) => g.gate_key === 'roe_ttm').threshold).toBe(8);
    // old V3.0 retained in history
    expect(rb.listVersions(USER).some((v: any) => v.version_label === 'V3.0')).toBe(true);
  });
});
