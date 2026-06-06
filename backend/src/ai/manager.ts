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

// Unified chat primitive across provider API styles. Returns the model's text reply.
// Throws Error(<message>) on a non-2xx response so callers can surface the reason.
export async function chat(
  style: ApiStyle,
  config: ChatConfig,
  prompt: string,
  maxTokens = 64
): Promise<string> {
  const base = trimUrl(config.baseUrl);

  if (style === 'anthropic') {
    const resp = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(await errText(resp));
    const data: any = await resp.json();
    return data?.content?.[0]?.text ?? '';
  }

  if (style === 'ollama') {
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
    });
    if (!resp.ok) throw new Error(await errText(resp));
    const data: any = await resp.json();
    return data?.message?.content ?? '';
  }

  // openai-compatible (deepseek / qwen / openai / minimax)
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) throw new Error(await errText(resp));
  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function errText(resp: Response): Promise<string> {
  let body = '';
  try {
    body = await resp.text();
  } catch {
    /* ignore */
  }
  return `HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`;
}
