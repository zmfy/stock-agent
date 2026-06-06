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

// Ask the AI for a small CHANGE PATCH (not the whole rulebook) — far more robust to parse.
export function buildProposePrompt(active: FullRulebook, instruction: string, context: string): string {
  const cur = {
    persona: active.version.persona,
    gates: active.gates.map((g) => ({ gate_key: g.gate_key, system: g.system, label: g.label, field: g.field, op: g.op, threshold: g.threshold, threshold2: g.threshold2, veto: g.veto })),
    softRules: active.softRules.map((r) => ({ system: r.system, text: r.text })),
  };
  return `你是核心原则维护助手。当前生效规则（仅供参考）：
${JSON.stringify(cur)}

用户的修改诉求与讨论：
${[context, instruction].filter(Boolean).join('\n')}

请只输出一个【改动补丁】JSON（只写需要变的部分，不要重复整份规则），结构：
{
 "note":"一句话说明改了什么、为什么",
 "persona":"（可选）新人设，不改则省略",
 "gate_updates":[{"gate_key":"已存在门槛的key","threshold":数值,"op":"可选","threshold2":可选,"veto":可选0或1}],
 "gates_add":[{"system":"A","gate_key":"唯一key","label":"名称","field":"数据字段","op":">=|>|<=|<|between|gt_field","threshold":数值或null,"threshold2":null,"ref_field":null,"unit":"","veto":1,"teach":"一句话"}],
 "gates_remove":["要删除的gate_key"],
 "soft_add":[{"system":"A","text":"软判断","teach":"教学"}],
 "soft_remove":["要删除的软判断原文"],
 "position_patch":{}
}
没有的字段省略或给空数组。只输出 JSON，不要解释或思考过程。`;
}

interface Patch {
  note?: string;
  persona?: string;
  gate_updates?: any[];
  gates_add?: any[];
  gates_remove?: string[];
  soft_add?: any[];
  soft_remove?: string[];
  position_patch?: Record<string, unknown>;
}

const VALID_OPS = ['>=', '>', '<=', '<', 'between', 'gt_field'];

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

export function parsePatch(text: string): Patch | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1)) as Patch;
  } catch {
    return null;
  }
}

// Apply a patch onto the active rulebook to produce a full proposal payload.
export function applyPatch(active: FullRulebook, patch: Patch): ProposalPayload {
  const gates: SeedGate[] = active.gates.map((g) => ({
    system: g.system, gate_key: g.gate_key, label: g.label, field: g.field, op: g.op,
    threshold: g.threshold, threshold2: g.threshold2, ref_field: g.ref_field, unit: g.unit, veto: g.veto, teach: g.teach,
  }));
  // updates
  for (const u of patch.gate_updates || []) {
    const g = gates.find((x) => x.gate_key === u.gate_key);
    if (!g) continue;
    if (u.op && VALID_OPS.includes(u.op)) g.op = u.op;
    if ('threshold' in u) g.threshold = num(u.threshold);
    if ('threshold2' in u) g.threshold2 = num(u.threshold2);
    if ('veto' in u) g.veto = u.veto ? 1 : 0;
  }
  // removes
  const rm = new Set(patch.gates_remove || []);
  let next = gates.filter((g) => !rm.has(g.gate_key));
  // adds
  for (const a of patch.gates_add || []) {
    if (!a.gate_key || !VALID_OPS.includes(a.op)) continue;
    next.push({
      system: a.system || 'A', gate_key: String(a.gate_key), label: String(a.label ?? a.gate_key), field: String(a.field ?? a.gate_key),
      op: a.op, threshold: num(a.threshold), threshold2: num(a.threshold2), ref_field: a.ref_field ?? null, unit: String(a.unit ?? ''), veto: a.veto ? 1 : 0, teach: String(a.teach ?? ''),
    });
  }

  const softRemove = new Set(patch.soft_remove || []);
  const softRules: SeedSoftRule[] = active.softRules
    .filter((r) => !softRemove.has(r.text))
    .map((r) => ({ system: r.system, text: r.text, teach: r.teach }));
  for (const sa of patch.soft_add || []) {
    if (sa?.text) softRules.push({ system: sa.system || 'A', text: String(sa.text), teach: String(sa.teach ?? '') });
  }

  return {
    persona: patch.persona ? String(patch.persona) : active.version.persona,
    note: patch.note ? String(patch.note) : '规则调整',
    gates: next,
    softRules,
    positionRules: { ...active.positionRules, ...(patch.position_patch || {}) },
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
  return chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 4000);
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
  const patch = parsePatch(raw);
  if (!patch) throw new Error('PARSE_FAILED');
  const proposal = applyPatch(active, patch);
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
