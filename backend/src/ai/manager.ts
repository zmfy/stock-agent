import { ApiStyle } from './providers';

export interface ChatConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

// Trim a trailing slash so we can safely append paths.
function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

const IS_TEST = process.env.NODE_ENV === 'test';
// Space out outbound LLM calls so bursts (早会/晚会/选股的多 agent) don't trip provider rate limits (429).
const MIN_INTERVAL_MS = IS_TEST ? 0 : Number(process.env.AI_MIN_INTERVAL_MS) || 700;
const MAX_RETRIES = IS_TEST ? 0 : Number(process.env.AI_MAX_RETRIES) || 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialize all LLM calls through one chain with a minimum spacing between starts.
let lastStart = 0;
let chain: Promise<unknown> = Promise.resolve();
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastStart + MIN_INTERVAL_MS - Date.now());
    if (wait) await sleep(wait);
    lastStart = Date.now();
    return fn();
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run as Promise<T>;
}

interface HttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

// Retry on 429 / 5xx with exponential backoff (+jitter), honoring a Retry-After header.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const err = e as HttpError;
      const retryable = err.status === 429 || (typeof err.status === 'number' && err.status >= 500 && err.status < 600);
      if (retryable && attempt < MAX_RETRIES) {
        const backoff = err.retryAfterMs ?? 600 * 2 ** attempt + Math.floor(((attempt * 137) % 300));
        await sleep(backoff);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

async function send(url: string, headers: Record<string, string>, body: unknown, pick: (data: any) => string): Promise<string> {
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    let txt = '';
    try {
      txt = await resp.text();
    } catch {
      /* ignore */
    }
    const err: HttpError = new Error(`HTTP ${resp.status} ${resp.statusText}${txt ? ` — ${txt.slice(0, 300)}` : ''}`);
    err.status = resp.status;
    const ra = resp.headers?.get?.('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (isFinite(secs)) err.retryAfterMs = secs * 1000;
    }
    throw err;
  }
  const data: any = await resp.json();
  return pick(data);
}

// Unified chat primitive across provider API styles. Returns the model's text reply.
// Calls are throttled + retried (429/5xx) so heavy multi-agent flows don't hit rate limits.
export async function chat(style: ApiStyle, config: ChatConfig, prompt: string, maxTokens = 64): Promise<string> {
  const base = trimUrl(config.baseUrl);
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  let pick: (data: any) => string;

  if (style === 'anthropic') {
    url = `${base}/v1/messages`;
    headers = { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' };
    body = { model: config.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    pick = (d) => d?.content?.[0]?.text ?? '';
  } else if (style === 'ollama') {
    url = `${base}/api/chat`;
    headers = { 'Content-Type': 'application/json' };
    body = { model: config.model, messages: [{ role: 'user', content: prompt }], stream: false };
    pick = (d) => d?.message?.content ?? '';
  } else {
    // openai-compatible (deepseek / qwen / openai / minimax)
    url = `${base}/chat/completions`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` };
    body = { model: config.model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: maxTokens };
    pick = (d) => d?.choices?.[0]?.message?.content ?? '';
  }

  return schedule(() => withRetry(() => send(url, headers, body, pick)));
}
