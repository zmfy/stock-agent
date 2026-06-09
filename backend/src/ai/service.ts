import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getProvider } from './providers';
import { ROLES, getRole, tierOf, searchOrder } from './roles';
import { chat } from './manager';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { currentConfigUsage } from './usage';

interface AiConfigRow {
  id: string;
  user_id: string;
  provider: string;
  api_key_enc: string | null;
  base_url: string;
  model: string;
  is_active: number;
  enabled: number;
  updated_at: string;
  shared?: number;
  share_max_tokens?: number;
  share_period_seconds?: number;
}

export interface PublicAiConfig {
  provider: string;
  base_url: string;
  model: string;
  enabled: number;
  apiKeySet: boolean;
  apiKeyMasked: string;
  shared: number;
  shareMaxTokens: number;
  sharePeriodSeconds: number;
}

function mask(enc: string | null): string {
  if (!enc) return '';
  const plain = decryptSecret(enc);
  if (!plain) return '';
  return plain.length > 8 ? `${plain.slice(0, 4)}****${plain.slice(-4)}` : '****';
}

function row(userId: string, provider: string): AiConfigRow | undefined {
  return getDb()
    .prepare('SELECT * FROM ai_configs WHERE user_id = ? AND provider = ?')
    .get(userId, provider) as AiConfigRow | undefined;
}

export function listConfigs(userId: string): PublicAiConfig[] {
  const rows = getDb()
    .prepare('SELECT * FROM ai_configs WHERE user_id = ? ORDER BY provider')
    .all(userId) as AiConfigRow[];
  return rows.map((r) => ({
    provider: r.provider,
    base_url: r.base_url,
    model: r.model,
    enabled: r.enabled,
    apiKeySet: !!r.api_key_enc,
    apiKeyMasked: mask(r.api_key_enc),
    shared: r.shared ?? 0,
    shareMaxTokens: r.share_max_tokens ?? 0,
    sharePeriodSeconds: r.share_period_seconds ?? 0,
  }));
}

export function setEnabled(userId: string, provider: string, enabled: boolean): void {
  getDb()
    .prepare('UPDATE ai_configs SET enabled = ? WHERE user_id = ? AND provider = ?')
    .run(enabled ? 1 : 0, userId, provider);
}

export function saveConfig(
  userId: string,
  provider: string,
  input: { apiKey?: string; baseUrl: string; model: string }
): void {
  const def = getProvider(provider);
  if (!def) throw new Error('UNKNOWN_PROVIDER');
  if (!input.model) throw new Error('MODEL_REQUIRED');

  const existing = row(userId, provider);

  // Keep the existing key when the incoming one is blank or a masked placeholder.
  let apiKeyEnc = existing?.api_key_enc ?? null;
  const incoming = input.apiKey;
  if (incoming && !incoming.includes('****')) {
    apiKeyEnc = encryptSecret(incoming);
  }

  if (def.needsApiKey && !apiKeyEnc) throw new Error('API_KEY_REQUIRED');

  const db = getDb();
  if (existing) {
    db.prepare(
      'UPDATE ai_configs SET api_key_enc = ?, base_url = ?, model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(apiKeyEnc, input.baseUrl, input.model, existing.id);
  } else {
    db.prepare(
      'INSERT INTO ai_configs (id, user_id, provider, api_key_enc, base_url, model, is_active) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(uuidv4(), userId, provider, apiKeyEnc, input.baseUrl, input.model);
  }
  ensureCoreDefault(userId);
}

// The main agent (core) model is user-selected; default it to the FIRST-added usable
// config if the user hasn't pinned one. Never auto-changed by auto-assign.
export function ensureCoreDefault(userId: string): void {
  const a = getRoleAssignment(userId, 'core');
  if (a && a.mode === 'manual' && a.provider) return; // user already chose
  const rows = getDb()
    .prepare('SELECT provider, api_key_enc FROM ai_configs WHERE user_id = ? AND enabled = 1 ORDER BY rowid')
    .all(userId) as { provider: string; api_key_enc: string | null }[];
  const first = rows.find((r) => {
    const def = getProvider(r.provider);
    return def && (!def.needsApiKey || !!r.api_key_enc);
  });
  if (first) setRoleAssignment(userId, 'core', { mode: 'manual', provider: first.provider });
}

export function deleteConfig(userId: string, provider: string): void {
  const db = getDb();
  db.prepare('DELETE FROM ai_configs WHERE user_id = ? AND provider = ?').run(userId, provider);
  // Reset any manual role pins that referenced this provider back to auto.
  db.prepare("UPDATE ai_role_assignments SET mode = 'auto', provider = NULL, model = NULL WHERE user_id = ? AND provider = ?").run(userId, provider);
}

export interface ResolvedConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  scope?: 'self' | 'shared';
  ref?: string;
  ownerConfigId?: string;
}

export function getDecrypted(userId: string, provider: string): ResolvedConfig | null {
  const r = row(userId, provider);
  if (!r) return null;
  return { provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptSecret(r.api_key_enc ?? '') };
}

// ---- shared (admin) pool ----

// admin 的「可用」共享配置（已剔除全局超限的），用于解析池。
export function sharedConfigs(nowMs: number = Date.now()): ResolvedConfig[] {
  const rows = getDb()
    .prepare(`SELECT c.* FROM ai_configs c JOIN users u ON u.id = c.user_id
              WHERE u.role = 'admin' AND c.shared = 1 AND c.enabled = 1`)
    .all() as AiConfigRow[];
  return rows
    .filter((r) => {
      const def = getProvider(r.provider);
      if (!def || (def.needsApiKey && !r.api_key_enc)) return false;
      const cap = r.share_max_tokens ?? 0;
      if (cap > 0 && currentConfigUsage(r.id, r.share_period_seconds ?? 0, nowMs) >= cap) return false; // 全局超限→对所有人停用
      return true;
    })
    .map((r) => ({
      provider: r.provider,
      baseUrl: r.base_url,
      model: r.model,
      apiKey: decryptSecret(r.api_key_enc ?? ''),
      scope: 'shared' as const,
      ref: 'shared:' + r.id,
      ownerConfigId: r.id,
    }));
}

function optoutSet(userId: string): Set<string> {
  const rows = getDb().prepare('SELECT config_id FROM shared_ai_optout WHERE user_id = ?').all(userId) as { config_id: string }[];
  return new Set(rows.map((r) => r.config_id));
}

export function sharedConfigsForUser(userId: string, nowMs: number = Date.now()): ResolvedConfig[] {
  const out = optoutSet(userId);
  return sharedConfigs(nowMs).filter((c) => !out.has(c.ownerConfigId!));
}

// ---- enabled pool + role routing ----

// All enabled, usable configs for this user: own (scope=self) first, then admin-shared (scope=shared).
export function enabledConfigs(userId: string): ResolvedConfig[] {
  const rows = getDb()
    .prepare('SELECT * FROM ai_configs WHERE user_id = ? AND enabled = 1 ORDER BY provider')
    .all(userId) as AiConfigRow[];
  const self = rows
    .filter((r) => {
      const def = getProvider(r.provider);
      return def && (!def.needsApiKey || !!r.api_key_enc);
    })
    .map((r) => ({
      provider: r.provider,
      baseUrl: r.base_url,
      model: r.model,
      apiKey: decryptSecret(r.api_key_enc ?? ''),
      scope: 'self' as const,
      ref: 'self:' + r.provider,
    }));
  return [...self, ...sharedConfigsForUser(userId)];
}

interface RoleAssignmentRow {
  role: string;
  mode: 'manual' | 'auto';
  provider: string | null;
  model: string | null;
  shared_config_id?: string | null;
}

export function getRoleAssignment(userId: string, role: string): RoleAssignmentRow | undefined {
  return getDb()
    .prepare('SELECT role, mode, provider, model, shared_config_id FROM ai_role_assignments WHERE user_id = ? AND role = ?')
    .get(userId, role) as RoleAssignmentRow | undefined;
}

export function setRoleAssignment(
  userId: string,
  role: string,
  input: { mode: 'manual' | 'auto'; provider?: string | null; model?: string | null; sharedConfigId?: string | null }
): void {
  if (!getRole(role)) throw new Error('UNKNOWN_ROLE');
  let provider: string | null = null;
  let model: string | null = null;
  let sharedConfigId: string | null = null;

  if (input.mode === 'manual') {
    if (input.sharedConfigId) {
      const sc = sharedConfigsForUser(userId).find((c) => c.ownerConfigId === input.sharedConfigId);
      if (!sc) throw new Error('NOT_ENABLED');
      sharedConfigId = input.sharedConfigId;
      model = sc.model;
    } else {
      if (!input.provider) throw new Error('PROVIDER_REQUIRED');
      const cfg = row(userId, input.provider);
      if (!cfg || !cfg.enabled) throw new Error('NOT_ENABLED');
      const def = getProvider(input.provider);
      if (def?.needsApiKey && !cfg.api_key_enc) throw new Error('API_KEY_REQUIRED');
      provider = input.provider;
      model = input.model ?? null;
    }
  }

  const db = getDb();
  const existing = getRoleAssignment(userId, role);
  if (existing) {
    db.prepare('UPDATE ai_role_assignments SET mode = ?, provider = ?, model = ?, shared_config_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = ?')
      .run(input.mode, provider, model, sharedConfigId, userId, role);
  } else {
    db.prepare('INSERT INTO ai_role_assignments (id, user_id, role, mode, provider, model, shared_config_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), userId, role, input.mode, provider, model, sharedConfigId);
  }
}

// Resolve which model a task role should use. Manual pin first, else auto by tier,
// else fall back to the 'core' role, else null if nothing usable is enabled.
export function getModelForRole(userId: string, role: string): ResolvedConfig | null {
  const def = getRole(role);
  if (!def) return null;
  const pool = enabledConfigs(userId);

  const a = getRoleAssignment(userId, role);
  if (a && a.mode === 'manual') {
    if (a.shared_config_id) {
      const cfg = pool.find((c) => c.ownerConfigId === a.shared_config_id);
      if (cfg) return cfg;
    } else if (a.provider) {
      const cfg = pool.find((c) => c.scope !== 'shared' && c.provider === a.provider);
      if (cfg) return { ...cfg, model: a.model || cfg.model };
    }
  }

  if (pool.length) {
    for (const tier of searchOrder(def.prefer)) {
      const hit = pool.find((c) => tierOf(c.model) === tier);
      if (hit) return hit;
    }
    return pool[0];
  }

  if (role !== 'core') return getModelForRole(userId, 'core');
  return null;
}

// Back-compat: the agent's main brain.
export function getActiveConfig(userId: string): ResolvedConfig | null {
  return getModelForRole(userId, 'core');
}

function pickProviderByTier(pool: ResolvedConfig[], prefer: ReturnType<typeof getRole>): string | null {
  const p = prefer?.prefer ?? 'balanced';
  for (const tier of searchOrder(p)) {
    const hit = pool.find((c) => tierOf(c.model) === tier);
    if (hit) return hit.provider;
  }
  return pool[0]?.provider ?? null;
}

// The main agent assigns a model to each task role from the enabled pool.
// Tries an AI decision; falls back to deterministic tier matching. Persists manual pins.
export async function autoAssignRoles(
  userId: string,
  opts: { aiCall?: (prompt: string) => Promise<string> } = {}
): Promise<void> {
  const pool = enabledConfigs(userId);
  if (!pool.length) throw new Error('NO_MODEL');

  // Only sub-agents — the main (core) model is user-selected and must not be changed here.
  const subRoles = ROLES.filter((r) => r.key !== 'core');
  const models = pool.map((c) => `${c.provider}(模型 ${c.model}，定位 ${tierOf(c.model)})`).join('；');
  const rolesList = subRoles.map((r) => `${r.key}（${r.label}，偏好 ${r.prefer}）`).join('；');
  const prompt = `你是主操盘 agent，请把现有可用模型分配给各【子 agent】任务：数据/校验类用快/省的，分析/复盘用强的，软料用均衡。\n可用模型：${models}。\n任务：${rolesList}。\n只输出 JSON：{${subRoles.map((r) => `"${r.key}":"provider名"`).join(',')}}`;

  let mapping: Record<string, string> = {};
  try {
    const cfg = getModelForRole(userId, 'core');
    let raw = '';
    if (opts.aiCall) raw = await opts.aiCall(prompt);
    else if (cfg) raw = await chat(getProvider(cfg.provider)?.apiStyle || 'openai', { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 400);
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) mapping = JSON.parse(raw.slice(s, e + 1));
  } catch {
    mapping = {};
  }

  for (const r of subRoles) {
    let provider = mapping[r.key];
    if (!provider || !pool.find((c) => c.provider === provider)) provider = pickProviderByTier(pool, getRole(r.key))!;
    if (provider) setRoleAssignment(userId, r.key, { mode: 'manual', provider });
  }
}

// Role assignments + their resolved provider/model (no keys) for the UI.
export function listRoleAssignments(userId: string): Array<{
  role: string;
  label: string;
  hint: string;
  mode: 'manual' | 'auto';
  pinnedProvider: string | null;
  pinnedModel: string | null;
  resolvedProvider: string | null;
  resolvedModel: string | null;
}> {
  return ROLES.map((r) => {
    const a = getRoleAssignment(userId, r.key);
    const resolved = getModelForRole(userId, r.key);
    return {
      role: r.key,
      label: r.label,
      hint: r.hint,
      mode: a?.mode ?? 'auto',
      pinnedProvider: a?.provider ?? null,
      pinnedModel: a?.model ?? null,
      resolvedProvider: resolved?.provider ?? null,
      resolvedModel: resolved?.model ?? null,
    };
  });
}

// ---- admin 共享模型：切共享/配额、per-user opt-out、展示 ----

export function setShared(userId: string, provider: string, input: { shared: boolean; maxTokens?: number; periodSeconds?: number }): void {
  const cfg = row(userId, provider);
  if (!cfg) throw new Error('NOT_FOUND');
  getDb()
    .prepare('UPDATE ai_configs SET shared = ?, share_max_tokens = ?, share_period_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND provider = ?')
    .run(input.shared ? 1 : 0, Math.max(0, Math.floor(input.maxTokens ?? 0)), Math.max(0, Math.floor(input.periodSeconds ?? 0)), userId, provider);
}

export function setSharedOptout(userId: string, configId: string, enabled: boolean): void {
  const db = getDb();
  if (enabled) {
    db.prepare('DELETE FROM shared_ai_optout WHERE user_id = ? AND config_id = ?').run(userId, configId);
  } else {
    db.prepare('INSERT OR IGNORE INTO shared_ai_optout (id, user_id, config_id) VALUES (?, ?, ?)').run(uuidv4(), userId, configId);
  }
}

// 展示用：列出所有 admin 共享模型(含已超限的，标 over)，无 key。
export function listSharedForUser(
  userId: string,
  nowMs: number = Date.now()
): Array<{
  configId: string;
  provider: string;
  model: string;
  label: string;
  enabledForMe: boolean;
  quota: { cap: number; used: number; remaining: number | null; periodSeconds: number; over: boolean };
}> {
  const rows = getDb()
    .prepare(`SELECT c.* FROM ai_configs c JOIN users u ON u.id = c.user_id
              WHERE u.role = 'admin' AND c.shared = 1 AND c.enabled = 1 ORDER BY c.provider`)
    .all() as AiConfigRow[];
  const out = optoutSet(userId);
  return rows
    .filter((r) => {
      const def = getProvider(r.provider);
      return def && (!def.needsApiKey || !!r.api_key_enc);
    })
    .map((r) => {
      const cap = r.share_max_tokens ?? 0;
      const period = r.share_period_seconds ?? 0;
      const used = currentConfigUsage(r.id, period, nowMs);
      return {
        configId: r.id,
        provider: r.provider,
        model: r.model,
        label: `共享·${r.model}`,
        enabledForMe: !out.has(r.id),
        quota: { cap, used, remaining: cap > 0 ? Math.max(0, cap - used) : null, periodSeconds: period, over: cap > 0 && used >= cap },
      };
    });
}
