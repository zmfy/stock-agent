import { ref } from 'vue';
import { dataApi } from '../api/data';

export type Seg = { type: 'text'; s: string } | { type: 'stock'; code: string; name: string };

// 误识高风险股名（与常用词撞车的短名），命中则不做 chip。初始为空，按需补充。
const STOCK_NAME_STOPLIST = new Set<string>([]);

const LS_KEY = 'sa_stock_dict';
const ready = ref(false);

let codeToName = new Map<string, string>();
let nameToCode = new Map<string, string>();
let namesByFirst = new Map<string, string[]>(); // 首字 → 该字开头的股名(按长度降序)
let started = false;

function build(items: [string, string][]) {
  codeToName = new Map();
  nameToCode = new Map();
  namesByFirst = new Map();
  for (const [code, name] of items) {
    codeToName.set(code, name);
    if (name && name.length >= 2 && !STOCK_NAME_STOPLIST.has(name)) nameToCode.set(name, code);
  }
  for (const name of nameToCode.keys()) {
    const f = name[0];
    const list = namesByFirst.get(f);
    if (list) list.push(name);
    else namesByFirst.set(f, [name]);
  }
  for (const list of namesByFirst.values()) list.sort((a, b) => b.length - a.length);
  ready.value = true;
}

async function ensureLoaded(): Promise<void> {
  if (started) return;
  started = true;
  // 1) localStorage 暖启动：先用缓存即时构建
  let cachedVersion = '';
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const c = JSON.parse(raw) as { version: string; items: [string, string][] };
      cachedVersion = c.version;
      build(c.items);
    }
  } catch { /* 忽略损坏缓存 */ }
  // 2) 拉最新，version 变了才重建并刷新缓存
  try {
    const cur = await dataApi.stocksDict();
    if (cur.version !== cachedVersion) {
      build(cur.items);
      try { localStorage.setItem(LS_KEY, JSON.stringify(cur)); } catch { /* 配额满则忽略 */ }
    }
  } catch {
    // 拉取失败：若也无缓存，则字典为空，tokenize 退化为仅识 6 位代码（无名显代码）
    ready.value = true;
  }
}

const CODE_PREFIXED = /^(?:sh|sz|bj)?(\d{6})/i;

// 把文本切成 text/stock 段。左到右扫描，代码优先、股名最长优先。
export function tokenize(text: string): Seg[] {
  const segs: Seg[] = [];
  if (!text) return segs;
  let buf = '';
  const flush = () => { if (buf) { segs.push({ type: 'text', s: buf }); buf = ''; } };
  const n = text.length;
  let i = 0;
  while (i < n) {
    // 代码（可带 sh/sz/bj 前缀），需两侧非数字，且代码在字典中
    const cm = CODE_PREFIXED.exec(text.slice(i, i + 9));
    if (cm) {
      const code = cm[1];
      const prev = text[i - 1];
      const after = text[i + cm[0].length];
      const prevDigit = !!prev && /\d/.test(prev);
      const afterDigit = !!after && /\d/.test(after);
      if (!prevDigit && !afterDigit && codeToName.has(code)) {
        flush();
        segs.push({ type: 'stock', code, name: codeToName.get(code) || '' });
        i += cm[0].length;
        continue;
      }
    }
    // 股名（最长优先，仅查同首字候选）
    const cands = namesByFirst.get(text[i]);
    if (cands) {
      let matched = '';
      for (const name of cands) {
        if (text.startsWith(name, i)) { matched = name; break; }
      }
      if (matched) {
        flush();
        segs.push({ type: 'stock', code: nameToCode.get(matched)!, name: matched });
        i += matched.length;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return segs;
}

export function useStockLinkify() {
  return { ready, ensureLoaded, tokenize };
}
