// 把 AI 生成内容切成「结论(泡泡) + 全文(详细弹层)」。
// 规则：① 首个非空行以「结论：/结论:」开头 → summary=该行去前缀；
//      ② 否则含「🧠 来财推荐：」或「🧠 来财综合研判：」→ summary=该标记之后整段；
//      ③ 都没有 → hasSummary=false，full=原文（调用方回退到 3 行裁剪）。
export interface Conclusion {
  summary: string;
  full: string;
  hasSummary: boolean;
}

const CORE_MARKERS = ['🧠 来财推荐：', '🧠 来财综合研判：'];

export function splitConclusion(content: string): Conclusion {
  const full = content ?? '';
  if (!full.trim()) return { summary: '', full, hasSummary: false };

  const lines = full.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx >= 0) {
    const m = /^\s*结论\s*[:：]\s*(.*)$/.exec(lines[firstIdx]);
    if (m && m[1].trim()) return { summary: m[1].trim(), full, hasSummary: true };
  }

  for (const mk of CORE_MARKERS) {
    const i = full.indexOf(mk);
    if (i >= 0) {
      const after = full.slice(i + mk.length).trim();
      if (after) return { summary: after, full, hasSummary: true };
    }
  }
  return { summary: '', full, hasSummary: false };
}
