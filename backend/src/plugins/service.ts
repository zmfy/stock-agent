import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { CATALOG, getCatalogPlugin, PluginKind, Transport } from './catalog';

interface PluginRow {
  id: string;
  user_id: string;
  plugin_key: string;
  kind: PluginKind;
  label: string | null;
  source: 'builtin' | 'custom';
  transport: Transport | null;
  config: string | null;
  enabled: number;
  created_at: string;
}

export interface PluginView {
  key: string;
  kind: PluginKind;
  label: string;
  description: string;
  recommended: boolean;
  source: 'builtin' | 'custom';
  transport: Transport | null;
  enabled: boolean;
  config: Record<string, unknown>;
  configHint?: string;
}

function parse(json: string | null): Record<string, unknown> {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

function rowFor(userId: string, key: string): PluginRow | undefined {
  return getDb()
    .prepare('SELECT * FROM plugins WHERE user_id = ? AND plugin_key = ?')
    .get(userId, key) as PluginRow | undefined;
}

// Merged view: every catalog plugin (with the user's enabled/config state) + custom rows.
export function listForUser(userId: string): PluginView[] {
  const rows = getDb()
    .prepare('SELECT * FROM plugins WHERE user_id = ?')
    .all(userId) as PluginRow[];
  const byKey = new Map(rows.map((r) => [r.plugin_key, r]));

  const builtins: PluginView[] = CATALOG.map((def) => {
    const r = byKey.get(def.key);
    return {
      key: def.key,
      kind: def.kind,
      label: def.label,
      description: def.description,
      recommended: !!def.recommended,
      source: 'builtin',
      transport: def.transport ?? null,
      // Default ON: built-ins are enabled unless the user explicitly stored a row turning it off.
      enabled: r ? !!r.enabled : true,
      config: r && r.config ? parse(r.config) : def.defaultConfig,
      configHint: def.configHint,
    };
  });

  const customs: PluginView[] = rows
    .filter((r) => r.source === 'custom')
    .map((r) => ({
      key: r.plugin_key,
      kind: r.kind,
      label: r.label || r.plugin_key,
      description: '自定义插件',
      recommended: false,
      source: 'custom',
      transport: r.transport,
      enabled: !!r.enabled,
      config: parse(r.config),
    }));

  return [...builtins, ...customs];
}

export function setEnabled(
  userId: string,
  key: string,
  enabled: boolean,
  config?: Record<string, unknown>
): void {
  const def = getCatalogPlugin(key);
  const existing = rowFor(userId, key);
  if (!def && !existing) throw new Error('UNKNOWN_PLUGIN');

  const db = getDb();
  if (existing) {
    const cfg = config !== undefined ? JSON.stringify(config) : existing.config;
    db.prepare('UPDATE plugins SET enabled = ?, config = ? WHERE id = ?').run(enabled ? 1 : 0, cfg, existing.id);
  } else if (def) {
    const cfg = JSON.stringify(config ?? def.defaultConfig);
    db.prepare(
      'INSERT INTO plugins (id, user_id, plugin_key, kind, label, source, transport, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), userId, key, def.kind, def.label, 'builtin', def.transport ?? null, cfg, enabled ? 1 : 0);
  }
}

export function addCustom(
  userId: string,
  input: { key: string; label: string; kind: PluginKind; transport?: Transport | null; config: Record<string, unknown> }
): void {
  if (getCatalogPlugin(input.key) || rowFor(userId, input.key)) throw new Error('DUPLICATE_KEY');
  getDb()
    .prepare(
      'INSERT INTO plugins (id, user_id, plugin_key, kind, label, source, transport, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
    )
    .run(
      uuidv4(),
      userId,
      input.key,
      input.kind,
      input.label,
      'custom',
      input.transport ?? null,
      JSON.stringify(input.config ?? {})
    );
}

export function updateConfig(userId: string, key: string, config: Record<string, unknown>): void {
  const def = getCatalogPlugin(key);
  const existing = rowFor(userId, key);
  if (!def && !existing) throw new Error('UNKNOWN_PLUGIN');
  if (existing) {
    getDb().prepare('UPDATE plugins SET config = ? WHERE id = ?').run(JSON.stringify(config), existing.id);
  } else if (def) {
    // built-ins are default-ON, so a config-override row keeps enabled = 1
    getDb()
      .prepare(
        'INSERT INTO plugins (id, user_id, plugin_key, kind, label, source, transport, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
      )
      .run(uuidv4(), userId, key, def.kind, def.label, 'builtin', def.transport ?? null, JSON.stringify(config));
  }
}

// Delete the user's row for a plugin. Custom -> gone. Built-in -> reverts to default (ON).
// (To turn a built-in OFF, use setEnabled(false), which persists an enabled=0 row.)
export function remove(userId: string, key: string): void {
  const existing = rowFor(userId, key);
  if (!existing) return;
  getDb().prepare('DELETE FROM plugins WHERE id = ?').run(existing.id);
}

export interface EnabledCapabilities {
  mcp: Array<{ key: string; label: string; transport: Transport | null; config: Record<string, unknown> }>;
  skills: Array<{ key: string; label: string; config: Record<string, unknown> }>;
}

// What Plan 5/6 read to actually connect MCP servers / apply skills.
export function getEnabledCapabilities(userId: string): EnabledCapabilities {
  const enabled = listForUser(userId).filter((p) => p.enabled);
  return {
    mcp: enabled.filter((p) => p.kind === 'mcp').map((p) => ({ key: p.key, label: p.label, transport: p.transport, config: p.config })),
    skills: enabled.filter((p) => p.kind === 'skill').map((p) => ({ key: p.key, label: p.label, config: p.config })),
  };
}

// Turn enabled skills + their config into a system-prompt directive snippet,
// so the skills actually change how the agent thinks (not just registered).
export function skillDirectives(userId: string): string {
  const skills = getEnabledCapabilities(userId).skills;
  const lines: string[] = [];
  for (const s of skills) {
    const c = s.config || {};
    if (s.key === 'sequential-thinking') {
      const steps = Number(c.max_steps) || 6;
      const trigger = String(c.trigger || '复杂问题');
      const when = trigger === '总是' ? '' : trigger === '从不' ? null : '遇到复杂问题时，';
      if (when !== null) {
        lines.push(
          c.show_steps
            ? `· 分步推理：${when}请把推理拆成不超过 ${steps} 步并在回复中简要展示关键步骤，再给结论。`
            : `· 分步推理：${when}请在内部分步推理（不超过 ${steps} 步）后再给结论，回复只呈现结论与要点。`
        );
      }
    } else if (s.key === 'research') {
      const parts: string[] = [];
      if (c.clarify_before_conclusion) {
        const n = Number(c.max_followup_questions) || 2;
        parts.push(`下结论前，若关键前提不明确，先提出最多 ${n} 个澄清问题`);
      }
      if (c.list_assumptions) parts.push('给出结论后，列出你依赖的关键假设与不确定点');
      if (parts.length) lines.push(`· 探索：${parts.join('；')}。`);
    } else if (s.key === 'memory') {
      const capture = Array.isArray(c.capture) && c.capture.length ? (c.capture as string[]).join('、') : '市场观察、操作习惯、教训';
      lines.push(`· 记忆：主动复用并延续历史的【${capture}】，讨论时如与过去观察/教训相关请点出来。`);
    }
  }
  return lines.length ? `已启用的能力（请遵循）：\n${lines.join('\n')}` : '';
}
