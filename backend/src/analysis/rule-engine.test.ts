import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-re-'));

const { evaluateGates } = require('./rule-engine');
const { BASELINE_V3 } = require('../rulebook/baseline-v3');

// Turn the baseline seed gates into Gate rows (add id/version_id/sort_order).
const gates = BASELINE_V3.gates.map((g: any, i: number) => ({ ...g, id: `g${i}`, version_id: 'v', sort_order: i }));

// 瑞丰光电-like: weak ROE, high PE, ok PB/PS, trend up; cold market.
const ruifeng = {
  code: '300241', name: '瑞丰光电', date: '2026-06-05',
  roe_ttm: 1.28, pe: 80, pb: 2.3, ps: 2.8, net_profit: 65945900, turnover_rate: 16.13,
  ma20: 7.75, ma60: 7.5, year_high: 8.28, close: 8.18,
  limit_up_count: 39, limit_down_count: 18, sse_ma20_slope: 0,
  _missing: [],
};

describe('rule-engine evaluateGates', () => {
  const ev = evaluateGates(ruifeng, gates);
  const byKey = Object.fromEntries(ev.gateResults.map((r: any) => [r.gate_key, r]));

  it('ROE 1.28 fails the >=10 veto', () => {
    expect(byKey.roe_ttm.status).toBe('fail');
  });
  it('PE 80 fails the 0<pe<60 between gate', () => {
    expect(byKey.pe.status).toBe('fail');
  });
  it('PB 2.3 passes <5, PS 2.8 passes <8', () => {
    expect(byKey.pb.status).toBe('pass');
    expect(byKey.ps.status).toBe('pass');
  });
  it('trend gate: ma20(7.75) > ma60(7.5) passes', () => {
    expect(byKey.ma_trend.status).toBe('pass');
  });
  it('A system veto fails (roe + pe)', () => {
    expect(ev.aVeto.passed).toBe(false);
    expect(ev.aVeto.failed).toEqual(expect.arrayContaining(['roe_ttm', 'pe']));
  });
  it('B emotion gate fails: limit_up 39 (<50) and limit_down 18 (>=10)', () => {
    expect(byKey.limit_up_count.status).toBe('fail');
    expect(byKey.limit_down_count.status).toBe('fail');
    expect(ev.bEmotion.passed).toBe(false);
  });
  it('missing field -> unknown, not a veto fail', () => {
    const ev2 = evaluateGates({ ...ruifeng, roe_ttm: null }, gates);
    const roe = ev2.gateResults.find((r: any) => r.gate_key === 'roe_ttm');
    expect(roe.status).toBe('unknown');
    // still fails A veto because pe also fails; but roe itself is unknown not fail
    expect(ev2.aVeto.failed).not.toContain('roe_ttm');
  });
});
