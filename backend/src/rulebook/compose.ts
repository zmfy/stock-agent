import { Baseline, SeedGate, SeedSoftRule } from './baseline-v3';
import { getTemplate } from './templates';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function sig(g: SeedGate): string {
  return `${g.op}|${g.threshold}|${g.threshold2}|${g.ref_field}`;
}

export interface ComposeResult {
  conflict: boolean;
  conflictFields: string[];
  systems: Array<{ letter: string; key: string; label: string; gateCount: number }>;
  baseline: Baseline;
}

// Detect whether the selected templates impose different constraints on the same field.
function detectConflicts(tpls: Array<{ key: string; baseline: Baseline }>): string[] {
  const byField = new Map<string, Set<string>>();
  for (const t of tpls) {
    for (const g of t.baseline.gates) {
      if (!byField.has(g.field)) byField.set(g.field, new Set());
      byField.get(g.field)!.add(sig(g));
    }
  }
  return [...byField.entries()].filter(([, sigs]) => sigs.size > 1).map(([field]) => field);
}

// Compose selected templates (keys order = priority) into one rulebook.
// No conflict -> merged single system 'A'. Conflict -> A/B/C... one system per template.
export function composeTemplates(keys: string[]): ComposeResult {
  const tpls = keys.map((k) => ({ key: k, meta: getTemplate(k) })).filter((t) => t.meta).map((t) => ({ key: t.key, label: t.meta!.label, baseline: t.meta!.baseline }));
  if (!tpls.length) throw new Error('NO_TEMPLATES');

  if (tpls.length === 1) {
    const t = tpls[0];
    return { conflict: false, conflictFields: [], systems: [{ letter: 'A', key: t.key, label: t.label, gateCount: t.baseline.gates.length }], baseline: t.baseline };
  }

  const conflictFields = detectConflicts(tpls);
  const labels = tpls.map((t) => t.label);

  if (conflictFields.length === 0) {
    // merge into one system 'A', dedup gates by field and soft rules by text
    const seenField = new Set<string>();
    const gates: SeedGate[] = [];
    for (const t of tpls)
      for (const g of t.baseline.gates) {
        if (seenField.has(g.field)) continue;
        seenField.add(g.field);
        gates.push({ ...g, system: 'A' });
      }
    const seenText = new Set<string>();
    const softRules: SeedSoftRule[] = [];
    for (const t of tpls)
      for (const r of t.baseline.softRules) {
        if (seenText.has(r.text)) continue;
        seenText.add(r.text);
        softRules.push({ ...r, system: 'A' });
      }
    const positionRules: Record<string, unknown> = {};
    for (const t of tpls) Object.assign(positionRules, t.baseline.positionRules);
    const baseline: Baseline = {
      versionLabel: `组合·${labels.join('+')}`.slice(0, 40),
      persona: `你综合运用以下策略选股（已合并为一套，无冲突）：${labels.join('、')}。`,
      gates,
      softRules,
      positionRules,
    };
    return { conflict: false, conflictFields: [], systems: [{ letter: 'A', key: tpls.map((t) => t.key).join(','), label: labels.join('+'), gateCount: gates.length }], baseline };
  }

  // conflict -> one system per template (A/B/C…), keys order = priority
  const gates: SeedGate[] = [];
  const softRules: SeedSoftRule[] = [];
  const systems: ComposeResult['systems'] = [];
  const systemsMeta: Record<string, unknown> = {};
  tpls.forEach((t, i) => {
    const letter = LETTERS[i] || `S${i}`;
    for (const g of t.baseline.gates) gates.push({ ...g, system: letter, gate_key: `${letter}_${g.gate_key}` });
    for (const r of t.baseline.softRules) softRules.push({ ...r, system: letter });
    systemsMeta[letter] = { label: t.label, positionRules: t.baseline.positionRules };
    systems.push({ letter, key: t.key, label: t.label, gateCount: t.baseline.gates.length });
  });
  const baseline: Baseline = {
    versionLabel: `多系统·${labels.join('/')}`.slice(0, 40),
    persona: `你同时维护 ${tpls.length} 套选股系统（${systems.map((s) => `${s.letter}=${s.label}`).join('、')}），它们存在冲突、永不混用；按优先级 ${systems.map((s) => s.letter).join('>')} 依次判断今天用哪套。`,
    gates,
    softRules,
    positionRules: { system_priority: systems.map((s) => s.letter), systems: systemsMeta, conflict_fields: conflictFields },
  };
  return { conflict: true, conflictFields, systems, baseline };
}
