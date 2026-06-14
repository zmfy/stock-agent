// 从 LLM 文本里稳健地抽取一个 JSON 对象。
// 处理：推理模型 <think>…</think>、markdown ```json 围栏、正文里夹带的花括号、
// 多个 JSON 块、尾逗号——比「首{到末}」直接 slice 稳健得多。
export function extractJsonObject(text: string): any | null {
  let s = (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/```[a-zA-Z]*/g, '').replace(/```/g, ''); // 去掉 markdown 代码围栏标记
  // 扫描出所有「括号平衡」的顶层 {...} 候选（跳过字符串内的花括号）。
  const candidates: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(s.slice(i, j + 1));
          i = j; // 从该对象之后继续找下一个顶层对象
          break;
        }
      }
    }
  }
  // 优先用最长的候选（补丁/策略 JSON 通常是最大的那个对象）；带尾逗号兜底。
  candidates.sort((a, b) => b.length - a.length);
  for (const cand of candidates) {
    try {
      return JSON.parse(cand);
    } catch {
      try {
        return JSON.parse(cand.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        /* 试下一个候选 */
      }
    }
  }
  return null;
}
