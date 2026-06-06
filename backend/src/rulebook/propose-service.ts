import { FullRulebook, Gate } from '../types';
import { SeedGate, SeedSoftRule } from './baseline-v3';
import { getActive, createVersion, activateVersion } from './service';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';

export interface ProposalPayload {
  persona: string;
  note: string;
  gates: SeedGate[];
  softRules: SeedSoftRule[];
  positionRules: Record<string, unknown>;
}

export interface RulebookDelta {
  personaChanged: boolean;
  gates: { added: string[]; removed: string[]; changed: { gate_key: string; from: any; to: any }[] };
  softRules: { added: string[]; removed: string[] };
  positionRulesChangedKeys: string[];
}

export function buildProposePrompt(active: FullRulebook, instruction: string, context: string): string {
  const cur = {
    persona: active.version.persona,
    gates: active.gates.map((g) => ({
      gate_key: g.gate_key, system: g.system, label: g.label, field: g.field, op: g.op,
      threshold: g.threshold, threshold2: g.threshold2, ref_field: g.ref_field, unit: g.unit, veto: g.veto, teach: g.teach,
    })),
    softRules: active.softRules.map((r) => ({ system: r.system, text: r.text, teach: r.teach })),
    positionRules: active.positionRules,
  };
  return `你是核心原则维护助手。当前生效的规则（JSON）：
${JSON.stringify(cur)}

用户的修改诉求与讨论：
${[context, instruction].filter(Boolean).join('\n')}

请输出【完整的】修改后规则 JSON：保留未改动的部分，只改需要改的。字段与上面完全一致，并额外加 "note"（用一句话说明本次改了什么、为什么）。
gate 的 op 只能是 ">=",">","<=","<","between","gt_field"。只输出 JSON，不要任何额外文字。`;
}

function toSeedGate(o: any): SeedGate {
  return {
    system: o.system === 'B' ? 'B' : 'A',
    gate_key: String(o.gate_key),
    label: String(o.label ?? o.gate_key),
    field: String(o.field ?? o.gate_key),
    op: o.op,
    threshold: o.threshold === null || o.threshold === undefined ? null : Number(o.threshold),
    threshold2: o.threshold2 === null || o.threshold2 === undefined ? null : Number(o.threshold2),
    ref_field: o.ref_field ?? null,
    unit: String(o.unit ?? ''),
    veto: o.veto ? 1 : 0,
    teach: String(o.teach ?? ''),
  };
}

const VALID_OPS = ['>=', '>', '<=', '<', 'between', 'gt_field'];

export function parseProposal(text: string): ProposalPayload | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  let obj: any;
  try {
    obj = JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(obj.gates)) return null;
  const gates = obj.gates.map(toSeedGate).filter((g: SeedGate) => g.gate_key && VALID_OPS.includes(g.op));
  if (!gates.length) return null;
  const softRules: SeedSoftRule[] = Array.isArray(obj.softRules)
    ? obj.softRules.map((r: any) => ({ system: r.system === 'B' ? 'B' : 'A', text: String(r.text ?? ''), teach: String(r.teach ?? '') })).filter((r: SeedSoftRule) => r.text)
    : [];
  return {
    persona: String(obj.persona ?? ''),
    note: String(obj.note ?? '规则调整'),
    gates,
    softRules,
    positionRules: typeof obj.positionRules === 'object' && obj.positionRules ? obj.positionRules : {},
  };
}

export function diffRulebooks(active: FullRulebook, p: ProposalPayload): RulebookDelta {
  const aG = new Map(active.gates.map((g) => [g.gate_key, g]));
  const bG = new Map(p.gates.map((g) => [g.gate_key, g]));
  const added = [...bG.keys()].filter((k) => !aG.has(k));
  const removed = [...aG.keys()].filter((k) => !bG.has(k));
  const changed: RulebookDelta['gates']['changed'] = [];
  for (const [k, a] of aG) {
    const b = bG.get(k);
    if (!b) continue;
    if (a.op !== b.op || a.threshold !== b.threshold || a.threshold2 !== b.threshold2 || a.veto !== b.veto) {
      changed.push({ gate_key: k, from: { op: a.op, threshold: a.threshold, threshold2: a.threshold2, veto: a.veto }, to: { op: b.op, threshold: b.threshold, threshold2: b.threshold2, veto: b.veto } });
    }
  }
  const aT = new Set(active.softRules.map((r) => r.text));
  const bT = new Set(p.softRules.map((r) => r.text));
  const prKeys = new Set([...Object.keys(active.positionRules), ...Object.keys(p.positionRules)]);
  const positionRulesChangedKeys = [...prKeys].filter((k) => JSON.stringify(active.positionRules[k]) !== JSON.stringify(p.positionRules[k]));
  return {
    personaChanged: active.version.persona !== p.persona,
    gates: { added, removed, changed },
    softRules: { added: [...bT].filter((t) => !aT.has(t)), removed: [...aT].filter((t) => !bT.has(t)) },
    positionRulesChangedKeys,
  };
}

export function magnitudeOf(d: RulebookDelta): 'major' | 'minor' {
  if (d.gates.added.length || d.gates.removed.length || d.positionRulesChangedKeys.length) return 'major';
  if (d.gates.changed.some((c) => c.from.veto !== c.to.veto)) return 'major';
  return 'minor';
}

export function nextLabel(current: string, magnitude: 'major' | 'minor'): string {
  const dot = current.match(/(\d+)\.(\d+)/);
  if (dot) {
    let maj = +dot[1];
    let min = +dot[2];
    if (magnitude === 'major') { maj += 1; min = 0; } else min += 1;
    return current.replace(dot[0], `${maj}.${min}`);
  }
  const one = current.match(/(\d+)/);
  if (one) {
    const n = +one[1];
    return current.replace(one[0], magnitude === 'major' ? `${n + 1}.0` : `${n}.1`);
  }
  return `${current} ${magnitude === 'major' ? 'v2.0' : 'v1.1'}`;
}

async function defaultAiCall(userId: string, prompt: string): Promise<string> {
  const cfg = getModelForRole(userId, 'review') || getModelForRole(userId, 'core');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  return chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 3000);
}

export interface ProposeResult {
  proposal: ProposalPayload;
  delta: RulebookDelta;
  magnitude: 'major' | 'minor';
  currentLabel: string;
  suggestedLabel: string;
}

export async function proposeChange(
  userId: string,
  instruction: string,
  opts: { context?: string; aiCall?: (p: string) => Promise<string> } = {}
): Promise<ProposeResult> {
  const active = getActive(userId);
  if (!active) throw new Error('NO_RULEBOOK');
  const prompt = buildProposePrompt(active, instruction, opts.context || '');
  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));
  const raw = await aiCall(prompt);
  const proposal = parseProposal(raw);
  if (!proposal) throw new Error('PARSE_FAILED');
  const delta = diffRulebooks(active, proposal);
  const magnitude = magnitudeOf(delta);
  return {
    proposal,
    delta,
    magnitude,
    currentLabel: active.version.version_label,
    suggestedLabel: nextLabel(active.version.version_label, magnitude),
  };
}

export function applyProposal(userId: string, proposal: ProposalPayload, versionLabel: string): FullRulebook {
  const active = getActive(userId);
  const created = createVersion(userId, {
    versionLabel,
    persona: proposal.persona || active?.version.persona || '',
    note: proposal.note || '规则调整',
    parentVersionId: active?.version.id ?? null,
    author: 'agent',
    gates: proposal.gates,
    softRules: proposal.softRules,
    positionRules: proposal.positionRules,
  });
  activateVersion(userId, created.version.id);
  return { ...created, version: { ...created.version, is_active: 1 } };
}
