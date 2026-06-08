import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

// 渲染会话/纪要文本为 markdown HTML（详情弹层用）。内容来自用户自己的 AI，风险低；失败则退回转义纯文本。
export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text ?? '', { async: false }) as string;
  } catch {
    return escapeHtml(text ?? '');
  }
}
