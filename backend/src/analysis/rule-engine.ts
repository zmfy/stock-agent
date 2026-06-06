import { Gate, GateEvaluation, GateResult, StockSnapshot } from '../types';

// Deterministically evaluate one gate against the snapshot. NO AI — numbers never lie here.
function evalGate(snapshot: Record<string, any>, gate: Gate): GateResult['status'] {
  const actual = snapshot[gate.field];
  if (gate.op === 'gt_field') {
    const ref = gate.ref_field ? snapshot[gate.ref_field] : null;
    if (actual === null || actual === undefined || ref === null || ref === undefined) return 'unknown';
    return actual > ref ? 'pass' : 'fail';
  }
  if (actual === null || actual === undefined) return 'unknown';
  const t = gate.threshold;
  switch (gate.op) {
    case '>=':
      return t !== null && actual >= t ? 'pass' : 'fail';
    case '>':
      return t !== null && actual > t ? 'pass' : 'fail';
    case '<=':
      return t !== null && actual <= t ? 'pass' : 'fail';
    case '<':
      return t !== null && actual < t ? 'pass' : 'fail';
    case 'between':
      return t !== null && gate.threshold2 !== null && actual > t && actual < gate.threshold2 ? 'pass' : 'fail';
    default:
      return 'unknown';
  }
}

export function evaluateGates(snapshot: StockSnapshot, gates: Gate[]): GateEvaluation {
  const snap = snapshot as unknown as Record<string, any>;
  const gateResults: GateResult[] = gates.map((g) => ({
    gate_key: g.gate_key,
    label: g.label,
    system: g.system,
    field: g.field,
    op: g.op,
    threshold: g.threshold,
    threshold2: g.threshold2,
    ref_field: g.ref_field,
    unit: g.unit,
    veto: g.veto,
    actual: g.op === 'gt_field' ? snap[g.field] ?? null : snap[g.field] ?? null,
    status: evalGate(snap, g),
    teach: g.teach,
  }));

  // A veto fails if any A-system veto gate is an outright 'fail' (unknown is surfaced, not a veto fail).
  const aFailed = gateResults.filter((r) => r.system === 'A' && r.veto === 1 && r.status === 'fail').map((r) => r.gate_key);
  const bFailed = gateResults.filter((r) => r.system === 'B' && r.veto === 1 && r.status === 'fail').map((r) => r.gate_key);

  return {
    gateResults,
    aVeto: { passed: aFailed.length === 0, failed: aFailed },
    bEmotion: { passed: bFailed.length === 0, failed: bFailed },
  };
}
