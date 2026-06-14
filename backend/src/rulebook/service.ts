import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { BASELINE_V3, Baseline, SeedGate, SeedSoftRule } from './baseline-v3';
import { getTemplate } from './templates';
import { composeTemplates } from './compose';
import { FullRulebook, Gate, RulebookVersion, SoftRule } from '../types';
import { summarizeChangeReason, reasonAiCall } from './memory';
import { getMessages } from '../chat/service';

interface VersionPayload {
  versionLabel: string;
  persona: string;
  note?: string;
  parentVersionId?: string | null;
  author?: 'user' | 'agent';
  gates: SeedGate[];
  softRules: SeedSoftRule[];
  positionRules: Record<string, unknown>;
}

function insertGate(versionId: string, g: SeedGate, sort: number): void {
  getDb()
    .prepare(
      `INSERT INTO gates (id, version_id, system, gate_key, label, field, op, threshold, threshold2, ref_field, unit, veto, exception_channel, teach, sort_order)
       VALUES (@id,@version_id,@system,@gate_key,@label,@field,@op,@threshold,@threshold2,@ref_field,@unit,@veto,@exception_channel,@teach,@sort_order)`
    )
    .run({
      id: uuidv4(),
      version_id: versionId,
      system: g.system,
      gate_key: g.gate_key,
      label: g.label,
      field: g.field,
      op: g.op,
      threshold: g.threshold,
      threshold2: g.threshold2,
      ref_field: g.ref_field,
      unit: g.unit,
      veto: g.veto,
      exception_channel: null,
      teach: g.teach,
      sort_order: sort,
    });
}

function insertSoftRule(versionId: string, r: SeedSoftRule, sort: number): void {
  getDb()
    .prepare(
      `INSERT INTO soft_rules (id, version_id, system, text, teach, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(uuidv4(), versionId, r.system, r.text, r.teach, sort);
}

function loadFull(version: RulebookVersion): FullRulebook {
  const db = getDb();
  const gates = db
    .prepare('SELECT * FROM gates WHERE version_id = ? ORDER BY system, sort_order')
    .all(version.id) as Gate[];
  const softRules = db
    .prepare('SELECT * FROM soft_rules WHERE version_id = ? ORDER BY system, sort_order')
    .all(version.id) as SoftRule[];
  let positionRules: Record<string, unknown> = {};
  try {
    positionRules = version.position_rules ? JSON.parse(version.position_rules) : {};
  } catch {
    positionRules = {};
  }
  return { version, gates, softRules, positionRules };
}

// Create a version row + its gate/soft rows in one transaction. Returns the version id.
function writeVersion(
  userId: string,
  payload: VersionPayload,
  isActive: number
): string {
  const db = getDb();
  const versionId = uuidv4();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO rulebook_versions (id, user_id, version_label, persona, position_rules, note, author, parent_version_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      versionId,
      userId,
      payload.versionLabel,
      payload.persona,
      JSON.stringify(payload.positionRules ?? {}),
      payload.note ?? '',
      payload.author ?? 'user',
      payload.parentVersionId ?? null,
      isActive
    );
    payload.gates.forEach((g, i) => insertGate(versionId, g, i));
    payload.softRules.forEach((r, i) => insertSoftRule(versionId, r, i));
  });
  tx();
  return versionId;
}

function instantiateFrom(userId: string, b: Baseline, note: string): FullRulebook {
  const versionId = writeVersion(
    userId,
    {
      versionLabel: b.versionLabel,
      persona: b.persona,
      note,
      parentVersionId: null,
      author: 'user',
      gates: b.gates,
      softRules: b.softRules,
      positionRules: b.positionRules,
    },
    1
  );
  return getVersionRaw(userId, versionId)!;
}

export function instantiateBaseline(userId: string): FullRulebook {
  return instantiateFrom(userId, BASELINE_V3, '导入 V3.0 双系统基线');
}

// Instantiate from a named template; with no/unknown key, default to the V3 dual-system baseline.
// (V3 is removed from the selectable template picker, but remains the canonical default.)
export function instantiateTemplate(userId: string, templateKey?: string): FullRulebook {
  const tpl = templateKey ? getTemplate(templateKey) : undefined;
  if (tpl) return instantiateFrom(userId, tpl.baseline, `导入模板：${tpl.label}`);
  return instantiateFrom(userId, BASELINE_V3, '导入 V3.0 双系统基线');
}

// Compose multiple templates (keys order = priority) and switch to the result.
export async function applyComposedTemplates(
  userId: string,
  keys: string[],
  sessionId?: string,
  aiCall?: (p: string) => Promise<string>
): Promise<FullRulebook> {
  const composed = composeTemplates(keys);
  const active = getActive(userId);
  const changeDesc = composed.conflict
    ? `组合多套系统（${composed.systems.map((s) => s.letter + '=' + s.label).join('、')}）`
    : `合并模板：${composed.systems[0]?.label}`;
  let note = changeDesc;
  if (sessionId) {
    const discussion = getMessages(userId, sessionId)
      .map((m: any) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
      .join('\n');
    note = await summarizeChangeReason({
      persona: active?.version.persona || '',
      discussion,
      changeDesc,
      aiCall: aiCall || ((p) => reasonAiCall(userId, p)),
    });
  }
  const created = createVersion(userId, {
    versionLabel: composed.baseline.versionLabel,
    persona: composed.baseline.persona,
    note,
    parentVersionId: active?.version.id ?? null,
    author: 'user',
    gates: composed.baseline.gates,
    softRules: composed.baseline.softRules,
    positionRules: composed.baseline.positionRules,
  });
  activateVersion(userId, created.version.id);
  return { ...created, version: { ...created.version, is_active: 1 } };
}

// Switch the active rulebook to a template: create a NEW version from it and activate.
export async function applyTemplateAsVersion(
  userId: string,
  templateKey: string,
  sessionId?: string,
  aiCall?: (p: string) => Promise<string>
): Promise<FullRulebook> {
  const tpl = getTemplate(templateKey);
  if (!tpl) throw new Error('UNKNOWN_TEMPLATE');
  const active = getActive(userId);
  const changeDesc = `换入模板：${tpl.label}`;
  let note = changeDesc;
  if (sessionId) {
    const discussion = getMessages(userId, sessionId)
      .map((m: any) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
      .join('\n');
    note = await summarizeChangeReason({
      persona: active?.version.persona || '',
      discussion,
      changeDesc,
      aiCall: aiCall || ((p) => reasonAiCall(userId, p)),
    });
  }
  const created = createVersion(userId, {
    versionLabel: tpl.baseline.versionLabel,
    persona: tpl.baseline.persona,
    note,
    parentVersionId: active?.version.id ?? null,
    author: 'user',
    gates: tpl.baseline.gates,
    softRules: tpl.baseline.softRules,
    positionRules: tpl.baseline.positionRules,
  });
  activateVersion(userId, created.version.id);
  return { ...created, version: { ...created.version, is_active: 1 } };
}

export function getActive(userId: string): FullRulebook | null {
  const version = getDb()
    .prepare('SELECT * FROM rulebook_versions WHERE user_id = ? AND is_active = 1')
    .get(userId) as RulebookVersion | undefined;
  return version ? loadFull(version) : null;
}

export function listVersions(userId: string): RulebookVersion[] {
  return getDb()
    .prepare('SELECT * FROM rulebook_versions WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as RulebookVersion[];
}

export function listVersionHistory(userId: string, limit = 5): Array<{ version_label: string; created_at: string; note: string }> {
  return getDb()
    .prepare('SELECT version_label, created_at, note FROM rulebook_versions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit) as any[];
}

function getVersionRaw(userId: string, versionId: string): FullRulebook | null {
  const version = getDb()
    .prepare('SELECT * FROM rulebook_versions WHERE id = ? AND user_id = ?')
    .get(versionId, userId) as RulebookVersion | undefined;
  return version ? loadFull(version) : null;
}

export function getVersion(userId: string, versionId: string): FullRulebook | null {
  return getVersionRaw(userId, versionId);
}

export function hasAnyVersion(userId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM rulebook_versions WHERE user_id = ? LIMIT 1').get(userId);
  return !!row;
}

export function createVersion(userId: string, payload: VersionPayload): FullRulebook {
  const versionId = writeVersion(userId, { ...payload, author: payload.author ?? 'user' }, 0);
  return getVersionRaw(userId, versionId)!;
}

// 清空当前策略：取消所有版本的激活（变成「无当前策略」=空策略）。版本记录保留，可再激活恢复。
export function clearActive(userId: string): void {
  getDb().prepare('UPDATE rulebook_versions SET is_active = 0 WHERE user_id = ?').run(userId);
}

export function activateVersion(userId: string, versionId: string): void {
  const db = getDb();
  const target = db
    .prepare('SELECT id FROM rulebook_versions WHERE id = ? AND user_id = ?')
    .get(versionId, userId);
  if (!target) throw new Error('NOT_FOUND');
  const tx = db.transaction(() => {
    db.prepare('UPDATE rulebook_versions SET is_active = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE rulebook_versions SET is_active = 1 WHERE id = ?').run(versionId);
  });
  tx();
}

export interface RulebookDiff {
  personaChanged: boolean;
  gates: {
    added: string[]; // gate_key
    removed: string[];
    changed: { gate_key: string; from: Partial<Gate>; to: Partial<Gate> }[];
  };
  softRules: { added: string[]; removed: string[] };
  positionRulesChangedKeys: string[];
}

export function diffVersions(userId: string, aId: string, bId: string): RulebookDiff | null {
  const a = getVersionRaw(userId, aId);
  const b = getVersionRaw(userId, bId);
  if (!a || !b) return null;

  const aGates = new Map(a.gates.map((g) => [g.gate_key, g]));
  const bGates = new Map(b.gates.map((g) => [g.gate_key, g]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: RulebookDiff['gates']['changed'] = [];
  for (const key of bGates.keys()) if (!aGates.has(key)) added.push(key);
  for (const key of aGates.keys()) if (!bGates.has(key)) removed.push(key);
  for (const [key, ag] of aGates) {
    const bg = bGates.get(key);
    if (!bg) continue;
    if (ag.op !== bg.op || ag.threshold !== bg.threshold || ag.threshold2 !== bg.threshold2 || ag.veto !== bg.veto) {
      changed.push({
        gate_key: key,
        from: { op: ag.op, threshold: ag.threshold, threshold2: ag.threshold2, veto: ag.veto },
        to: { op: bg.op, threshold: bg.threshold, threshold2: bg.threshold2, veto: bg.veto },
      });
    }
  }

  const aTexts = new Set(a.softRules.map((r) => r.text));
  const bTexts = new Set(b.softRules.map((r) => r.text));
  const softAdded = [...bTexts].filter((t) => !aTexts.has(t));
  const softRemoved = [...aTexts].filter((t) => !bTexts.has(t));

  const prKeys = new Set([...Object.keys(a.positionRules), ...Object.keys(b.positionRules)]);
  const positionRulesChangedKeys = [...prKeys].filter(
    (k) => JSON.stringify(a.positionRules[k]) !== JSON.stringify(b.positionRules[k])
  );

  return {
    personaChanged: a.version.persona !== b.version.persona,
    gates: { added, removed, changed },
    softRules: { added: softAdded, removed: softRemoved },
    positionRulesChangedKeys,
  };
}

// 真实交易系统 = positionRules.single_trade_risk_pct 里风险>0 的系统；无配置的系统(如 C)为零仓位/复盘。
export function tradeableSystems(positionRules: any): string[] {
  const risk = (positionRules && positionRules.single_trade_risk_pct) || {};
  return Object.keys(risk).filter((k) => Number(risk[k]) > 0).sort();
}
