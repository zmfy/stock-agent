import { createHash } from 'crypto';
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
const BASE_INTERVAL_MS = IS_TEST ? 0 : Number(process.env.AI_MIN_INTERVAL_MS) || 700;
const MAX_INTERVAL_MS = IS_TEST ? 0 : Number(process.env.AI_MAX_INTERVAL_MS) || 8000;
const RELAX_STEP_MS = 150;
const MAX_RETRIES = IS_TEST ? 0 : Number(process.env.AI_MAX_RETRIES) || 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Per-key adaptive throttle: same key (e.g. the admin-shared key hit by many users) is
// serialized + spaced; different keys run in parallel. On 429 widen that key's interval
// (AIMD), relax on success — self-tunes to the provider's real rate limit to avoid 429.
interface KeyState {
  chain: Promise<unknown>;
  lastStart: number;
  interval: number;
}
const keyStates = new Map<string, KeyState>();
function keyState(id: string): KeyState {
  let st = keyStates.get(id);
  if (!st) {
    st = { chain: Promise.resolve(), lastStart: 0, interval: BASE_INTERVAL_MS };
    keyStates.set(id, st);
  }
  return st;
}
function widen(id: string): void {
  const st = keyState(id);
  st.interval = Math.min(MAX_INTERVAL_MS, Math.max(BASE_INTERVAL_MS, st.interval) * 2);
}
function relax(id: string): void {
  const st = keyState(id);
  st.interval = Math.max(BASE_INTERVAL_MS, st.interval - RELAX_STEP_MS);
}

function keyIdOf(style: ApiStyle, config: ChatConfig): string {
  return createHash('sha256').update(`${style}|${config.baseUrl}|${config.apiKey}`).digest('hex');
}

// Serialize one key's calls through its own chain with a minimum spacing between starts.
function schedule<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const st = keyState(id);
  const run = st.chain.then(async () => {
    const wait = Math.max(0, st.lastStart + st.interval - Date.now());
    if (wait) await sleep(wait);
    st.lastStart = Date.now();
    return fn();
  });
  st.chain = run.then(
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
// On 429 widen the key's interval; on success relax it (AIMD).
async function withRetry<T>(keyId: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await fn();
      relax(keyId);
      return r;
    } catch (e) {
      const err = e as HttpError;
      const retryable = err.status === 429 || (typeof err.status === 'number' && err.status >= 500 && err.status < 600);
      if (err.status === 429) widen(keyId);
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

// 解析 provider 返回的 token usage（取不到则 0）。
export function extractUsage(style: ApiStyle, data: any): number {
  try {
    if (style === 'anthropic') return (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0);
    if (style === 'ollama') return (data?.prompt_eval_count || 0) + (data?.eval_count || 0);
    return data?.usage?.total_tokens || 0;
  } catch {
    return 0;
  }
}

async function send(url: string, headers: Record<string, string>, body: unknown, pick: (data: any) => string): Promise<{ text: string; data: any }> {
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
  return { text: pick(data), data };
}

// Unified chat primitive across provider API styles. Returns the model's text reply.
// Calls are throttled (per-key adaptive) + retried (429/5xx) so heavy multi-agent flows don't hit rate limits.
// `account` (set only when using an admin-shared model) records token usage to that shared config.
export async function chat(
  style: ApiStyle,
  config: ChatConfig,
  prompt: string,
  maxTokens = 64,
  account?: { userId: string; configId: string }
): Promise<string> {
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

  const keyId = keyIdOf(style, config);
  const { text, data } = await schedule(keyId, () => withRetry(keyId, () => send(url, headers, body, pick)));
  if (account) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { recordSharedUsage } = require('./usage');
      recordSharedUsage(account.configId, account.userId, extractUsage(style, data));
    } catch {
      /* 记账失败绝不影响聊天 */
    }
  }
  return text;
}
