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
