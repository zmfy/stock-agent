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

  it('activate switches the active provider and getActiveConfig returns the decrypted key', () => {
    svc.activate(A, 'deepseek');
    const active = svc.getActiveConfig(A);
    expect(active.provider).toBe('deepseek');
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
});
