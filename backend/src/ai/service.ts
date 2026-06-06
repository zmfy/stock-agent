import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getProvider } from './providers';
import { encryptSecret, decryptSecret } from '../utils/crypto';

interface AiConfigRow {
  id: string;
  user_id: string;
  provider: string;
  api_key_enc: string | null;
  base_url: string;
  model: string;
  is_active: number;
  updated_at: string;
}

export interface PublicAiConfig {
  provider: string;
  base_url: string;
  model: string;
  is_active: number;
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
    is_active: r.is_active,
    apiKeySet: !!r.api_key_enc,
    apiKeyMasked: mask(r.api_key_enc),
  }));
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

export function activate(userId: string, provider: string): void {
  const def = getProvider(provider);
  if (!def) throw new Error('UNKNOWN_PROVIDER');
  const existing = row(userId, provider);
  if (!existing) throw new Error('NOT_CONFIGURED');
  if (def.needsApiKey && !existing.api_key_enc) throw new Error('API_KEY_REQUIRED');
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('UPDATE ai_configs SET is_active = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE ai_configs SET is_active = 1 WHERE id = ?').run(existing.id);
  });
  tx();
}

export function deleteConfig(userId: string, provider: string): void {
  getDb().prepare('DELETE FROM ai_configs WHERE user_id = ? AND provider = ?').run(userId, provider);
}

export interface ResolvedConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function getActiveConfig(userId: string): ResolvedConfig | null {
  const r = getDb()
    .prepare('SELECT * FROM ai_configs WHERE user_id = ? AND is_active = 1')
    .get(userId) as AiConfigRow | undefined;
  if (!r) return null;
  return { provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptSecret(r.api_key_enc ?? '') };
}

export function getDecrypted(userId: string, provider: string): ResolvedConfig | null {
  const r = row(userId, provider);
  if (!r) return null;
  return { provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptSecret(r.api_key_enc ?? '') };
}
