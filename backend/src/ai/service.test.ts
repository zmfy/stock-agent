import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-aisvc-'));

const svc = require('./service');
const A = 'user-A';
const B = 'user-B';

describe('ai/service (per-user)', () => {
  it('saves a config; list masks the key and never exposes raw', () => {
    svc.saveConfig(A, 'deepseek', { apiKey: 'sk-abcdefgh1234', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    const list = svc.listConfigs(A);
    expect(list).toHaveLength(1);
    expect(list[0].apiKeySet).toBe(true);
    expect(list[0].apiKeyMasked).toBe('sk-a****1234');
    expect(JSON.stringify(list)).not.toContain('sk-abcdefgh1234');
    // but internal resolver can decrypt
    expect(svc.getDecrypted(A, 'deepseek').apiKey).toBe('sk-abcdefgh1234');
  });

  it('re-saving with a masked key keeps the original key', () => {
    svc.saveConfig(A, 'deepseek', { apiKey: 'sk-a****1234', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' });
    expect(svc.getDecrypted(A, 'deepseek').apiKey).toBe('sk-abcdefgh1234'); // unchanged
    expect(svc.getDecrypted(A, 'deepseek').model).toBe('deepseek-reasoner'); // model updated
  });

  it('configs are isolated per user', () => {
    expect(svc.listConfigs(B)).toHaveLength(0);
    svc.saveConfig(B, 'qwen', { apiKey: 'qkey12345678', baseUrl: 'https://x/v1', model: 'qwen-plus' });
    expect(svc.listConfigs(A).map((c: any) => c.provider)).toEqual(['deepseek']);
    expect(svc.listConfigs(B).map((c: any) => c.provider)).toEqual(['qwen']);
  });

  it('getActiveConfig (core, auto) resolves to the enabled model with its decrypted key', () => {
    const active = svc.getActiveConfig(A); // only deepseek enabled so far
    expect(active.provider).toBe('deepseek');
    expect(active.model).toBe('deepseek-reasoner');
    expect(active.apiKey).toBe('sk-abcdefgh1234');
  });

  it('rejects unknown provider and missing key', () => {
    expect(() => svc.saveConfig(A, 'nope', { baseUrl: 'x', model: 'm' })).toThrow('UNKNOWN_PROVIDER');
    expect(() => svc.saveConfig(A, 'openai', { baseUrl: 'x', model: 'gpt-4o' })).toThrow('API_KEY_REQUIRED');
  });

  it('ollama needs no api key', () => {
    svc.saveConfig(A, 'ollama', { baseUrl: 'http://localhost:11434', model: 'qwen2.5' });
    expect(svc.listConfigs(A).find((c: any) => c.provider === 'ollama').apiKeySet).toBe(false);
  });

  // From here A's enabled pool = deepseek (deepseek-reasoner=strong) + ollama (qwen2.5=balanced)
  it('auto routing: analysis prefers strong, data prefers fast/balanced', () => {
    expect(svc.getModelForRole(A, 'analysis').provider).toBe('deepseek'); // strong
    expect(svc.getModelForRole(A, 'data').provider).toBe('ollama'); // no fast -> balanced beats strong
  });

  it('a manual pin overrides auto, and reverting to auto restores routing', () => {
    svc.setRoleAssignment(A, 'data', { mode: 'manual', provider: 'deepseek' });
    expect(svc.getModelForRole(A, 'data').provider).toBe('deepseek');
    svc.setRoleAssignment(A, 'data', { mode: 'auto' });
    expect(svc.getModelForRole(A, 'data').provider).toBe('ollama');
  });

  it('disabling a provider removes it from the pool', () => {
    svc.setEnabled(A, 'ollama', false);
    expect(svc.getModelForRole(A, 'data').provider).toBe('deepseek'); // only deepseek left
    svc.setEnabled(A, 'ollama', true);
  });

  it('manual pin to a disabled provider falls back to auto', () => {
    svc.setRoleAssignment(A, 'analysis', { mode: 'manual', provider: 'ollama' });
    svc.setEnabled(A, 'ollama', false);
    expect(svc.getModelForRole(A, 'analysis').provider).toBe('deepseek'); // ollama gone -> auto
    svc.setEnabled(A, 'ollama', true);
  });

  it('listRoleAssignments returns all 7 roles with resolved models', () => {
    const roles = svc.listRoleAssignments(A);
    expect(roles.map((r: any) => r.role)).toEqual(['core', 'data', 'analysis', 'qualitative', 'review', 'validation', 'ai_helper']);
    expect(roles.every((r: any) => r.resolvedProvider)).toBe(true);
  });
});

describe('ai_helper 角色', () => {
  const roles = require('./roles');
  const profiles = require('../agent/profiles-service');
  it('ai_helper 在 ROLES 与 PROFILE_ROLES 中', () => {
    expect(roles.ROLES.some((r: any) => r.key === 'ai_helper')).toBe(true);
    expect(profiles.PROFILE_ROLES).toContain('ai_helper');
  });
  it('getModelForRole(ai_helper) 回退到 core 的解析结果', () => {
    const s = require('./service');
    expect(s.getModelForRole('u-aih', 'ai_helper')).toEqual(s.getModelForRole('u-aih', 'core'));
  });
});
