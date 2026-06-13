# 聊天泡泡显示重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让聊天室 AI 泡泡显示「结论/重点」而非铺垫（全文进详细弹层），并把所有泡泡里的个股变成可点链接进入个股聊天室。

**Architecture:** 后端给策略生成内容打「首行 `结论：`」标记、暴露个股字典端点；前端用 `splitConclusion` 纯函数切结论、`useStockLinkify` 本地字典匹配器把代码/股名 chip 化、`StockText` 统一渲染（linkify+裁剪）、`ConclusionBubble` 复用「结论+详细 或 回退裁剪」，HomeView 按房间接入。

**Tech Stack:** Express/TS + better-sqlite3 + jest（后端）；Vue 3 + Vite（前端，无 test runner → `vue-tsc --noEmit` 把关）。

Spec：`docs/superpowers/specs/2026-06-13-chat-bubble-redesign-design.md`。

测试命令：后端 `cd backend && npm test`（当前 343 绿）；前端 `cd frontend && npx vue-tsc --noEmit`（应 exit 0）。

> **约定**：本仓库**仅当用户说「提交」时才 commit**。各 Task 的「Commit」步骤先**写好但不执行**，等用户统一说「提交」时再按这些 message 落库。实现时把每个 Commit 步骤视为「准备好 commit message，等放行」。

---

## 文件结构（改动地图）

**后端**
- Modify `backend/src/strategy/generate.ts` — 4 个 prompt 加「首行 `结论：` 」要求。
- Modify `backend/src/strategy/generate.test.ts` — 断言 prompt 含结论要求。
- Modify `backend/src/data/service.ts` — 加 `getStockDict()`。
- Modify `backend/src/routes/data.ts` — 加 `GET /stocks/dict`。
- Modify `backend/src/routes/data.test.ts` — 测 dict 端点。
- Modify `backend/src/screen/service.test.ts`（若不存在则 Create）— 断言讨论含 `🧠 来财推荐：` 锚点。

**前端**
- Create `frontend/src/utils/conclusion.ts` — `splitConclusion` 纯函数。
- Modify `frontend/src/api/data.ts` — 加 `stocksDict()`。
- Create `frontend/src/composables/useStockLinkify.ts` — 字典加载 + `tokenize`。
- Create `frontend/src/components/StockText.vue` — linkify + 可选裁剪。
- Create `frontend/src/components/ConclusionBubble.vue` — 结论+详细 / 回退裁剪。
- Modify `frontend/src/views/HomeView.vue` — provide openStock；消息/daily/screen/core_principle/stock 接入。

---

## Task 1: 后端策略生成首行「结论：」标记 + 测试

**Files:**
- Modify: `backend/src/strategy/generate.ts:26-37`（4 个 prompt 函数）
- Test: `backend/src/strategy/generate.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `backend/src/strategy/generate.test.ts` 的 `describe('generators 落库到正确 phase', …)` 末尾（`休市快报` 用例之后、`});` 之前）追加：

```ts
  it('四类生成 prompt 均要求首行输出「结论：」', async () => {
    const p1 = recordingAi(); await gen.generatePrejudge(U, { aiCall: p1.aiCall, fetchNews: async () => {}, now: NOON });
    const p2 = recordingAi(); await gen.generateIntraday(U, { aiCall: p2.aiCall, now: NOON });
    const p3 = recordingAi(); await gen.generateReview(U, { aiCall: p3.aiCall, now: NOON });
    const p4 = recordingAi(); await gen.generateHoliday(U, { aiCall: p4.aiCall, fetchNews: async () => {}, now: NOON });
    for (const p of [p1, p2, p3, p4]) {
      expect(p.prompts.join('\n')).toContain('结论：');
    }
  });
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest strategy/generate -i -t "首行输出"`。Expected: FAIL（prompt 不含「结论：」）。

- [ ] **Step 3: 实现** — 在 `backend/src/strategy/generate.ts` 的 4 个 prompt 函数返回串里，各加一行结论要求。改法如下（在每个模板的「请用中文给出…」收尾句**之前**插入要求句）：

`prejudgePrompt` 末尾 `请用中文给出简洁、可执行的预判：` 改为：
```ts
请先用一行输出「结论：<一句话方向与重点，≤40字>」，再换行给出简洁、可执行的预判（方向/板块/风险）：`;
```

`intradayPrompt` 末尾 `请用中文给出简洁的盘中小结（这一时点）：` 改为：
```ts
请先用一行输出「结论：<一句话当下研判，≤40字>」，再换行给出简洁的盘中小结（这一时点）：`;
```

`reviewPrompt` 末尾 `请用中文给出复盘（哪些对/错、为什么、下次怎么调整）：` 改为：
```ts
请先用一行输出「结论：<一句话复盘定论，≤40字>」，再换行给出复盘（哪些对/错、为什么、下次怎么调整）：`;
```

`holidayPrompt` 末尾 `请用中文给出简洁的休市快报：` 改为：
```ts
请先用一行输出「结论：<一句话消息面/受影响板块要点，≤40字>」，再换行给出简洁的休市快报：`;
```

- [ ] **Step 4: 运行确认通过** — `cd backend && npx jest strategy/generate -i`。Expected: PASS（含新用例，6+1 例全绿）。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/strategy/generate.ts backend/src/strategy/generate.test.ts
git commit -m "feat(strategy): 四类生成首行输出「结论：」一句话重点(供泡泡显示)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端选股讨论结论锚点回归测试

**Files:**
- Test: `backend/src/screen/service.test.ts`（已存在则在内追加；不存在则 Create）

> 选股讨论 `discussScreen` 的来财段已以 `🧠 来财推荐：` 单独成行（`backend/src/screen/service.ts:54`），无需改实现，仅加一条回归测试锁住该锚点（`splitConclusion` 规则 2 依赖它）。

- [ ] **Step 1: 确认测试文件是否存在** — `ls backend/src/screen/service.test.ts`。

- [ ] **Step 2a（文件已存在）: 在其末尾追加用例**：

```ts
describe('选股讨论结论锚点', () => {
  it('discussScreen 输出含「🧠 来财推荐：」单独成行', async () => {
    const svc = require('./service');
    const aiCall = async (_p: string, role: string) => `（${role}）`;
    const out = await svc.discussScreen('u-anchor', '测试范围',
      [{ code: '600519', name: '贵州茅台', aPass: true, bPass: false, passed: 1, total: 1, failed: [], reason: '入选' }],
      aiCall);
    expect(out).toContain('\n🧠 来财推荐：\n');
  });
});
```
> 注：`discussScreen` 是否为导出函数请先确认（`grep -n "discussScreen" backend/src/screen/service.ts`）。若**未导出**，本任务改为：在 `runScreen` 的现有测试里断言返回 `discussion` 含 `🧠 来财推荐：`；若该文件无 runScreen 测试脚手架，则跳到 Step 2b 新建。

- [ ] **Step 2b（文件不存在）: 新建 `backend/src/screen/service.test.ts`**：
```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-screen-'));

const svc = require('./service');

describe('选股讨论结论锚点', () => {
  it('discussScreen 输出含「🧠 来财推荐：」单独成行', async () => {
    if (typeof svc.discussScreen !== 'function') return; // 未导出则跳过（由 runScreen 测试覆盖）
    const aiCall = async (_p: string, role: string) => `（${role}）`;
    const out = await svc.discussScreen('u-anchor', '测试范围',
      [{ code: '600519', name: '贵州茅台', aPass: true, bPass: false, passed: 1, total: 1, failed: [], reason: '入选' }],
      aiCall);
    expect(out).toContain('\n🧠 来财推荐：\n');
  });
});
```
> 若 `discussScreen` 未导出，给它加 `export`（`backend/src/screen/service.ts` 把 `async function discussScreen` 改为 `export async function discussScreen`）——这是测试可见性的最小改动，不影响调用方。

- [ ] **Step 3: 运行确认通过** — `cd backend && npx jest screen/service -i`。Expected: PASS。

- [ ] **Step 4: Commit（待放行）**
```bash
git add backend/src/screen/service.ts backend/src/screen/service.test.ts
git commit -m "test(screen): 锁住选股讨论「🧠 来财推荐：」结论锚点

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端个股字典端点 `GET /api/data/stocks/dict` + 测试

**Files:**
- Modify: `backend/src/data/service.ts`（加 `getStockDict`）
- Modify: `backend/src/routes/data.ts:162-166`（加路由）
- Test: `backend/src/routes/data.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `backend/src/routes/data.test.ts` 末尾（最后一个 `});` 之后）追加：

```ts
describe('GET /api/data/stocks/dict', () => {
  it('返回 {version, items[[code,name]]}，普通用户可访问', async () => {
    const { getDb } = require('../db');
    getDb().prepare("INSERT OR REPLACE INTO stock_names (code, name) VALUES ('600519','贵州茅台')").run();
    const r = await request(app).get('/api/data/stocks/dict').set(uh());
    expect(r.status).toBe(200);
    expect(typeof r.body.data.version).toBe('string');
    expect(Array.isArray(r.body.data.items)).toBe(true);
    const hit = r.body.data.items.find((it: [string, string]) => it[0] === '600519');
    expect(hit).toEqual(['600519', '贵州茅台']);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest routes/data -i -t "stocks/dict"`。Expected: FAIL（404）。

- [ ] **Step 3: 实现 service** — 在 `backend/src/data/service.ts` 末尾追加：

```ts
// 个股字典（code+name 全量），供前端聊天泡泡本地匹配个股做链接用。
export function getStockDict(): { version: string; items: [string, string][] } {
  const db = getDb();
  const rows = db
    .prepare("SELECT code, name FROM stock_names WHERE name IS NOT NULL AND name <> '' ORDER BY code")
    .all() as { code: string; name: string }[];
  const agg = db.prepare('SELECT COUNT(*) AS n, MAX(fetched_at) AS m FROM stock_names').get() as { n: number; m: string | null };
  return { version: `${agg.n}:${agg.m ?? ''}`, items: rows.map((r) => [r.code, r.name]) };
}
```

- [ ] **Step 4: 实现路由** — 在 `backend/src/routes/data.ts` 的 `/stocks/search` 路由（约 164-166 行）**之后**插入：

```ts
// GET /api/data/stocks/dict — 全量 code+name 字典（前端泡泡个股 linkify 本地匹配用）
router.get('/stocks/dict', (_req: Request, res: Response) => {
  successResponse(res, svc.getStockDict());
});
```

- [ ] **Step 5: 运行确认通过 + 回归** — `cd backend && npx jest routes/data -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 6: Commit（待放行）**
```bash
git add backend/src/data/service.ts backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(data): GET /api/data/stocks/dict 个股字典(code+name+version)供前端linkify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前端 `splitConclusion` 纯函数

**Files:**
- Create: `frontend/src/utils/conclusion.ts`

- [ ] **Step 1: 实现** — 新建 `frontend/src/utils/conclusion.ts`：

```ts
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
```

- [ ] **Step 2: 逐例核对（无 runner，人工走查）** — 对照下表心算确认（实现后可临时在浏览器 console 或删后的 scratch 里验证）：

| 输入 | summary | hasSummary |
|---|---|---|
| `"结论：今日偏多\n大盘…"` | `今日偏多` | true |
| `"结论:券商占优\n…"` | `券商占优` | true |
| `"🗣 选股讨论\n…\n🧠 来财推荐：\n茅台、宁德"` | `茅台、宁德` | true |
| `"今天大盘震荡，建议观望。"`（无标记） | `''` | false |
| `""` | `''` | false |

- [ ] **Step 3: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 4: Commit（待放行）**
```bash
git add frontend/src/utils/conclusion.ts
git commit -m "feat(fe): splitConclusion 纯函数——按「结论：/🧠 来财推荐：」切结论与全文

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 前端字典 API + `useStockLinkify` 匹配器

**Files:**
- Modify: `frontend/src/api/data.ts`
- Create: `frontend/src/composables/useStockLinkify.ts`

- [ ] **Step 1: 加 API 方法** — 在 `frontend/src/api/data.ts` 的 `dataApi` 对象里加一项（与现有 `get` 风格一致；放在 `stocks/search` 相关方法旁，若无则任意位置）：

```ts
  stocksDict: () =>
    api.get('/data/stocks/dict').then((r) => r.data.data as { version: string; items: [string, string][] }),
```
> 若 `api/data.ts` 用具名导出而非单一 `dataApi` 对象，沿用其现有模式加同名方法。

- [ ] **Step 2: 实现 composable** — 新建 `frontend/src/composables/useStockLinkify.ts`：

```ts
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
```

- [ ] **Step 3: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 4: Commit（待放行）**
```bash
git add frontend/src/api/data.ts frontend/src/composables/useStockLinkify.ts
git commit -m "feat(fe): useStockLinkify——拉个股字典(localStorage缓存)+tokenize本地匹配代码/股名

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 前端 `StockText` 组件（linkify + 可选裁剪）

**Files:**
- Create: `frontend/src/components/StockText.vue`

- [ ] **Step 1: 实现** — 新建 `frontend/src/components/StockText.vue`：

```vue
<template>
  <div class="stocktext">
    <div ref="body" class="st-body" :class="{ clamped: clamp }">
      <template v-for="(seg, idx) in segments" :key="idx">
        <button v-if="seg.type === 'stock'" class="stock-chip" @click="onStock(seg.code)">{{ seg.name ? seg.name + ' ' : '' }}{{ seg.code }}</button>
        <span v-else>{{ seg.s }}</span>
      </template>
    </div>
    <button v-if="clamp && truncated" class="clamp-more" @click="$emit('detail', text)">详细 ›</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch, inject } from 'vue';
import { useStockLinkify, type Seg } from '../composables/useStockLinkify';

const props = withDefaults(defineProps<{ text: string; clamp?: boolean }>(), { clamp: true });
defineEmits<{ (e: 'detail', text: string): void }>();

const openStock = inject<(code: string) => void>('openStock', () => {});
const { ready, ensureLoaded, tokenize } = useStockLinkify();

const body = ref<HTMLElement | null>(null);
const truncated = ref(false);

// ready 变化时重算（字典异步到位后补上 chip）
const segments = computed<Seg[]>(() => { void ready.value; return tokenize(props.text); });

function onStock(code: string) { openStock(code); }

async function measure() {
  if (!props.clamp) { truncated.value = false; return; }
  await nextTick();
  const el = body.value;
  if (!el) return;
  truncated.value = el.scrollHeight - el.clientHeight > 2;
}

onMounted(() => { ensureLoaded(); measure(); });
watch(() => [props.text, segments.value, props.clamp], measure);
</script>

<style scoped>
.st-body { white-space: pre-wrap; word-break: break-word; }
.st-body.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.stock-chip {
  display: inline; padding: 0 2px; margin: 0; border: none; background: none;
  color: var(--accent, #2a8a2a); font: inherit; cursor: pointer; border-bottom: 1px dashed currentColor;
}
.stock-chip:hover { text-decoration: none; opacity: 0.8; }
.clamp-more { margin-top: 2px; font-size: 12px; color: var(--accent, #2a8a2a); background: none; border: none; cursor: pointer; padding: 0; }
.clamp-more:hover { text-decoration: underline; }
</style>
```

- [ ] **Step 2: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: Commit（待放行）**
```bash
git add frontend/src/components/StockText.vue
git commit -m "feat(fe): StockText——个股 chip 化(注入 openStock)+可选 3 行裁剪+详细

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 前端 `ConclusionBubble` 组件（结论+详细 / 回退裁剪）

**Files:**
- Create: `frontend/src/components/ConclusionBubble.vue`

> 实现 spec E.2/E.3：有结论标记 → 显示结论(全显、linkify)+独立「详细」开全文；无标记 → StockText 3 行裁剪。

- [ ] **Step 1: 实现** — 新建 `frontend/src/components/ConclusionBubble.vue`：

```vue
<template>
  <div class="conclusion-bubble">
    <template v-if="parsed.hasSummary">
      <StockText :text="parsed.summary" :clamp="false" />
      <button class="clamp-more" @click="$emit('detail', parsed.full)">详细 ›</button>
    </template>
    <StockText v-else :text="parsed.full" @detail="$emit('detail', $event)" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import StockText from './StockText.vue';
import { splitConclusion } from '../utils/conclusion';

const props = defineProps<{ text: string }>();
defineEmits<{ (e: 'detail', text: string): void }>();

const parsed = computed(() => splitConclusion(props.text));
</script>

<style scoped>
.clamp-more { margin-top: 2px; font-size: 12px; color: var(--accent, #2a8a2a); background: none; border: none; cursor: pointer; padding: 0; }
.clamp-more:hover { text-decoration: underline; }
</style>
```

- [ ] **Step 2: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: Commit（待放行）**
```bash
git add frontend/src/components/ConclusionBubble.vue
git commit -m "feat(fe): ConclusionBubble——有结论显结论+详细,无则回退裁剪(复用 StockText)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: HomeView 接入（provide openStock + 各房间渲染）

**Files:**
- Modify: `frontend/src/views/HomeView.vue`

> 现有：`ClampText`/`MarkdownModal` 已 import；`openDetail(text)`、`detailOpen`/`detailText`、`fmtCNDate`、`needsInit`、`activeRulebook`、`messages`、`openStockCode`、`briefing` 计算属性均已存在（见 spec 背景）。

- [ ] **Step 1: import 新组件 + provide openStock** — 在 `<script setup>` import 区，`ClampText` import 旁加：
```ts
import StockText from '../components/StockText.vue';
import ConclusionBubble from '../components/ConclusionBubble.vue';
import { provide } from 'vue';
```
> 若 `provide` 已随其它 vue API 一起 import，则并入那一行，勿重复 import。

在 `openStockCode` 函数定义**之后**（约 752 行后）加：
```ts
provide('openStock', (code: string) => { void openStockCode(code); });
```
> `provide` 必须在 `setup` 同步执行期调用；放在 `openStockCode` 声明之后、任何 await 之前的顶层位置即可（函数声明会被提升，引用安全）。

- [ ] **Step 2: 普通消息泡泡改用 StockText** — 把消息列表渲染（约 184-185 行）：
```vue
                <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
                  <div class="bubble"><ClampText :text="m.content" @detail="openDetail" /></div>
```
改为（个股房 `clamp=false` 全显，其余裁剪；都 linkify）：
```vue
                <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
                  <div class="bubble"><StockText :text="m.content" :clamp="active?.kind !== 'stock'" @detail="openDetail" /></div>
```

- [ ] **Step 3: daily 各阶段块改用 ConclusionBubble** — 在 `daily-content`（约 110-134 行）里，把 4 处 `<ClampText … @detail="openDetail" />` 替换为 `<ConclusionBubble … @detail="openDetail" />`：
  - 休市：`<ConclusionBubble v-if="strategyToday.holiday" :text="strategyToday.holiday.content" @detail="openDetail" />`
  - 预判：`<ConclusionBubble v-if="strategyToday.prejudge" :text="strategyToday.prejudge.content" @detail="openDetail" />`
  - 盘中逐条：`<ConclusionBubble :text="it.content" @detail="openDetail" />`
  - 复盘：`<ConclusionBubble v-if="strategyToday.review" :text="strategyToday.review.content" @detail="openDetail" />`

- [ ] **Step 4: core_principle / screen 的 briefing 区分化** — 把 briefing 渲染行（约 161 行）：
```vue
              <div v-if="briefing" class="briefing"><ClampText :text="briefing" @detail="openDetail" /></div>
```
替换为：
```vue
              <div v-if="active?.kind === 'core_principle'" class="briefing cp-briefing">
                <template v-if="activeRulebook">
                  <div class="cp-head">
                    📜 {{ activeRulebook.version.version_label }}
                    <span v-if="activeRulebook.version.created_at" class="muted"> · 最后更换 {{ fmtCNDate(activeRulebook.version.created_at) }}</span>
                    <button class="clamp-more" @click="openDetail(briefing)">详细 ›</button>
                  </div>
                  <div class="cp-guide muted">你想优化哪一方面？例如：放宽/收紧某条门槛、增删条件、调整仓位或止损、修改人设。说出你的想法，我们讨论后，点下方「🛠 让 agent 提议修改规则」，我会给出带版本号的修改方案供你确认。</div>
                </template>
                <StockText v-else :text="briefing" :clamp="false" />
              </div>
              <div v-else-if="active?.kind === 'screen' && briefing" class="briefing">
                <ConclusionBubble :text="briefing" @detail="openDetail" />
              </div>
```
> 说明：`activeRulebook` 有值即「有当前策略」，显示版本头+时间+详细(开 buildCpBriefing 全文)+固定引导语；无策略时（`activeRulebook` 为 null，对应 `briefing` 已是访谈引导语）全显该访谈语。screen 用 ConclusionBubble 切「🧠 来财推荐：」结论。

- [ ] **Step 5: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 6: 走查（dev 跑起来人工确认）** — `cd frontend && npm run dev`，登录普通用户：
  1. 策略探讨：有策略时显示「📜 版本 · 最后更换 …」+ 详细弹层全文 + 引导语；无策略时显示访谈引导语。
  2. 操盘和复盘：各阶段显示「结论：…」一句话 + 详细开全文（若后端已重新生成带结论的内容）；旧内容无结论则 3 行裁剪。
  3. 选股讨论：入选/无入选清单照常可点；讨论显示来财推荐结论 + 详细开全过程。
  4. 个股讨论：消息全显不裁剪。
  5. 任意泡泡里出现 6 位代码或库内股名 → 变 chip，点击进对应个股房间。

- [ ] **Step 7: Commit（待放行）**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): 泡泡显结论(ConclusionBubble)/策略探讨头+引导语/个股房全显/全房间个股 chip 化

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 端到端验证（实现完成后）

1. `cd backend && npm test` → 全绿（343 + 新增）。
2. `cd frontend && npx vue-tsc --noEmit` → exit 0。
3. `npm run dev` 走查 Task 8 Step 6 的五项。
4.（可选）`docker compose up -d --build` 起容器，admin 触发一次策略生成 + 选股，确认结论标记落库、字典端点可达、chip 可点。

## 风险 / 注意

- **结论标记靠模型遵守**：模型偶尔不输出「结论：」→ `splitConclusion` 回退裁剪，不报错（已与用户确认可接受）。
- **字典体量**：约 5000 条、首次约 100KB；localStorage 暖启动 + 仅 version 变更才重建。配额满静默忽略。
- **股名误识**：最长优先 + 最短 2 字 + `STOCK_NAME_STOPLIST`；个别误/漏识可接受（已与用户确认），停用词表后续可补。
- **弹层全文不二次 chip 化**（纯文本，`MarkdownModal` 不变）——个股链接只在泡泡正文生效。
- **provide/inject 时序**：`provide('openStock', …)` 必须在 setup 同步期调用；StockText 在无 provide 上下文渲染时注入缺省 no-op，不报错。
