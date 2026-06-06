import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getProvider } from './providers';
import { ROLES, getRole, tierOf, searchOrder } from './roles';
import { encryptSecret, decryptSecret } from '../utils/crypto';

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
}

export interface PublicAiConfig {
  provider: string;
  base_url: string;
  model: string;
  enabled: number;
  apiKeySet: boolean;
  apiKeyMasked: string;
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
}

export function getDecrypted(userId: string, provider: string): ResolvedConfig | null {
  const r = row(userId, provider);
  if (!r) return null;
  return { provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptSecret(r.api_key_enc ?? '') };
}

// ---- enabled pool + role routing ----

// All enabled, usable (has key when required) configs for this user.
export function enabledConfigs(userId: string): ResolvedConfig[] {
  const rows = getDb()
    .prepare('SELECT * FROM ai_configs WHERE user_id = ? AND enabled = 1 ORDER BY provider')
    .all(userId) as AiConfigRow[];
  return rows
    .filter((r) => {
      const def = getProvider(r.provider);
      return def && (!def.needsApiKey || !!r.api_key_enc);
    })
    .map((r) => ({ provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptSecret(r.api_key_enc ?? '') }));
}

interface RoleAssignmentRow {
  role: string;
  mode: 'manual' | 'auto';
  provider: string | null;
  model: string | null;
}

export function getRoleAssignment(userId: string, role: string): RoleAssignmentRow | undefined {
  return getDb()
    .prepare('SELECT role, mode, provider, model FROM ai_role_assignments WHERE user_id = ? AND role = ?')
    .get(userId, role) as RoleAssignmentRow | undefined;
}

export function setRoleAssignment(
  userId: string,
  role: string,
  input: { mode: 'manual' | 'auto'; provider?: string | null; model?: string | null }
): void {
  if (!getRole(role)) throw new Error('UNKNOWN_ROLE');
  if (input.mode === 'manual') {
    if (!input.provider) throw new Error('PROVIDER_REQUIRED');
    const cfg = row(userId, input.provider);
    if (!cfg || !cfg.enabled) throw new Error('NOT_ENABLED');
    const def = getProvider(input.provider);
    if (def?.needsApiKey && !cfg.api_key_enc) throw new Error('API_KEY_REQUIRED');
  }
  const db = getDb();
  const existing = getRoleAssignment(userId, role);
  const provider = input.mode === 'manual' ? input.provider! : null;
  const model = input.mode === 'manual' ? input.model ?? null : null;
  if (existing) {
    db.prepare('UPDATE ai_role_assignments SET mode = ?, provider = ?, model = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = ?')
      .run(input.mode, provider, model, userId, role);
  } else {
    db.prepare('INSERT INTO ai_role_assignments (id, user_id, role, mode, provider, model) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), userId, role, input.mode, provider, model);
  }
}

// Resolve which model a task role should use. Manual pin first, else auto by tier,
// else fall back to the 'core' role, else null if nothing usable is enabled.
export function getModelForRole(userId: string, role: string): ResolvedConfig | null {
  const def = getRole(role);
  if (!def) return null;
  const pool = enabledConfigs(userId);

  const a = getRoleAssignment(userId, role);
  if (a && a.mode === 'manual' && a.provider) {
    const cfg = pool.find((c) => c.provider === a.provider);
    if (cfg) return { ...cfg, model: a.model || cfg.model };
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
