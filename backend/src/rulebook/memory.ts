import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';

export interface ReasonInput {
  persona: string;
  discussion: string;
  changeDesc: string;
  aiCall: (prompt: string) => Promise<string>;
}

/** Shared AI-call helper for "reason summary" usage in service.ts and propose-service.ts. */
export async function reasonAiCall(userId: string, prompt: string): Promise<string> {
  const cfg = getModelForRole(userId, 'review') || getModelForRole(userId, 'core');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
  return chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 4000, acct);
}

export async function summarizeChangeReason(input: ReasonInput): Promise<string> {
  const prompt =
    `你是${input.persona || '股票助手'}。用户刚刚调整了核心选股/操作原则。\n` +
    `本次变更：${input.changeDesc}\n` +
    (input.discussion ? `相关讨论：\n${input.discussion}\n` : '') +
    `请用一句话（不超过60字）总结"用户为什么要这么改"，只输出这句话。`;
  try {
    const out = (await input.aiCall(prompt)).trim();
    return out || input.changeDesc;
  } catch {
    return input.changeDesc;
  }
}
