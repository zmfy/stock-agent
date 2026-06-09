import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mgr-'));

const { chat } = require('./manager');

function mockFetch(impl: any) {
  (global as any).fetch = jest.fn(impl);
}

describe('ai/manager chat', () => {
  afterEach(() => jest.restoreAllMocks());

  it('openai style: posts to /chat/completions with Bearer and parses choices', async () => {
    let captured: any = {};
    mockFetch((url: string, init: any) => {
      captured = { url, init };
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) });
    });
    const reply = await chat('openai', { baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', apiKey: 'k' }, 'hi');
    expect(reply).toBe('OK');
    expect(captured.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(captured.init.headers.Authorization).toBe('Bearer k');
  });

  it('anthropic style: posts to /v1/messages with x-api-key and parses content', async () => {
    let captured: any = {};
    mockFetch((url: string, init: any) => {
      captured = { url, init };
      return Promise.resolve({ ok: true, json: async () => ({ content: [{ text: 'OK' }] }) });
    });
    const reply = await chat('anthropic', { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001', apiKey: 'k' }, 'hi');
    expect(reply).toBe('OK');
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured.init.headers['x-api-key']).toBe('k');
    expect(captured.init.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('throws on a non-2xx response', async () => {
    mockFetch(() => Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' }));
    await expect(
      chat('openai', { baseUrl: 'https://x/v1', model: 'm', apiKey: 'bad' }, 'hi')
    ).rejects.toThrow(/401/);
  });
});

const mgr = require('./manager');
const { getDb } = require('../db');
const usage = require('./usage');
const MCFG = 'mgrcfg';

describe('extractUsage', () => {
  it('parses openai/anthropic/ollama shapes', () => {
    expect(mgr.extractUsage('openai', { usage: { total_tokens: 10 } })).toBe(10);
    expect(mgr.extractUsage('anthropic', { usage: { input_tokens: 3, output_tokens: 4 } })).toBe(7);
    expect(mgr.extractUsage('ollama', { prompt_eval_count: 2, eval_count: 6 })).toBe(8);
    expect(mgr.extractUsage('openai', {})).toBe(0);
  });
});

describe('chat usage accounting', () => {
  beforeAll(() => {
    getDb()
      .prepare('INSERT INTO ai_configs (id, user_id, provider, model, base_url, enabled, shared, share_max_tokens, share_period_seconds) VALUES (?,?,?,?,?,1,1,0,0)')
      .run(MCFG, 'adm', 'deepseek', 'deepseek-chat', '');
  });
  afterEach(() => jest.restoreAllMocks());

  it('records tokens to shared_ai_usage when account given', async () => {
    mockFetch(() => Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 42 } }) }));
    const text = await mgr.chat('openai', { baseUrl: 'http://x', model: 'm', apiKey: 'k' }, 'p', 64, { userId: 'uZ', configId: MCFG });
    expect(text).toBe('hi');
    expect(usage.currentConfigUsage(MCFG, 0)).toBe(42);
  });
  it('does not record when no account', async () => {
    mockFetch(() => Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'yo' } }], usage: { total_tokens: 5 } }) }));
    await mgr.chat('openai', { baseUrl: 'http://x', model: 'm', apiKey: 'k' }, 'p');
    expect(usage.currentConfigUsage(MCFG, 0)).toBe(42); // unchanged
  });
  it('accounting failure never breaks chat (unknown configId)', async () => {
    mockFetch(() => Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } }) }));
    const text = await mgr.chat('openai', { baseUrl: 'http://x', model: 'm', apiKey: 'k' }, 'p', 64, { userId: 'uZ', configId: 'no-such-cfg' });
    expect(text).toBe('ok');
  });
});
