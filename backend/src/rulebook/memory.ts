export interface ReasonInput {
  persona: string;
  discussion: string;
  changeDesc: string;
  aiCall: (prompt: string) => Promise<string>;
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
