# 聊天注入个股/大盘行情(动态窗口+按需取数) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让聊天里的「来财」能回答数据问题(昨天收盘价、近半年走势、大盘近期),靠"解析时间范围+目标→按需取数→注入 prompt"实现。

**Architecture:** 不改 `chat()` 单轮结构。新增 `chat/market-context.ts`(意图解析 + 组装 + 编排),`data/service.ts` 加本地取数/按需取数,sidecar 加取指数日线,新 `index_daily` 表。`postMessage` 在 `extraContext` 处调用编排器注入。先做 A(个股),再做 B(大盘)。

**Tech Stack:** 后端 TypeScript + Express + better-sqlite3 + Jest;sidecar Python(mootdx/FastAPI);前端无改动。

**测试命令:** 后端 `cd backend && npm test`(当前 220 绿);sidecar 容器内 `docker exec -w /app stock-agent-akshare-mcp-1 python tdx_test.py` + 实连自检。

---

## File Structure
- `backend/src/chat/market-context.ts`(新)— `parseTimeWindow`、`detectTarget`、`buildStockContext`、`buildIndexContext`、`buildMarketInjection`(异步编排)。
- `backend/src/data/service.ts`(改)— `getRecentBars`、`ensureStockBars`、`getRecentIndexBars`、`ensureIndexBars`、`cacheIndexBars`、`getMarketSentimentSeries`、`getStockSnapshot` 深度修、`findStockCodeInText`。
- `backend/src/data/sidecar.ts`(改)— `fetchIndexBars`。
- `backend/src/db.ts`(改)— `index_daily` 表。
- `backend/src/chat/service.ts`(改)— `postMessage` 注入。
- `sidecar/tdx.py`、`sidecar/main.py`(改)— 取指数日线 + `/index/{code}`。
- 各 `*.test.ts`。

---

# Part A — 个股动态窗口 + snapshot 深度修

## Task A1: `getRecentBars` 本地取数

**Files:**
- Modify: `backend/src/data/service.ts`
- Test: `backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试(追加到 `service.test.ts`)**

先看 `service.test.ts` 顶部如何 require(`const svc = require('./service')` 等)与如何建表/塞数据(它已有 `cacheQuotes`/直接 INSERT 的用例)。沿用同款写:

```ts
describe('getRecentBars', () => {
  it('returns recent bars ascending, capped at n, empty for unknown', () => {
    const db = getDb();
    const code = 'BARS01';
    for (const d of ['2026-06-01','2026-06-02','2026-06-03','2026-06-04']) {
      db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)')
        .run(code, d, 1, 2, 0.5, Number(d.slice(-2)), 100, 'test');
    }
    const bars = svc.getRecentBars(code, 3);
    expect(bars.map((b: any) => b.date)).toEqual(['2026-06-02','2026-06-03','2026-06-04']); // 升序、取最近3
    expect(bars[2].close).toBe(4);
    expect(svc.getRecentBars('NOPE', 5)).toEqual([]);
  });
});
```
(若 `getDb` 未在该文件 require,补 `const { getDb } = require('./../db')` 与现有风格一致——参考文件已有 import。)

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest data/service -i -t "getRecentBars"`
Expected: FAIL — `svc.getRecentBars is not a function`。

- [ ] **Step 3: 实现 `getRecentBars`(加在 `recentCloses` 附近)**

```ts
export interface Bar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export function getRecentBars(code: string, n: number): Bar[] {
  const rows = getDb()
    .prepare('SELECT date, open, high, low, close, volume FROM quote_daily WHERE code = ? ORDER BY date DESC LIMIT ?')
    .all(code, n) as Bar[];
  return rows.reverse(); // DESC 取最近 n 条后反转为升序
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx jest data/service -i -t "getRecentBars"`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): getRecentBars 取本地近 N 日线(升序)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A2: 意图解析 `parseTimeWindow` + `detectTarget`

**Files:**
- Create: `backend/src/chat/market-context.ts`
- Modify: `backend/src/data/service.ts`(加 `findStockCodeInText`)
- Test: `backend/src/chat/market-context.test.ts`

- [ ] **Step 1: 加 `findStockCodeInText`(`data/service.ts`)**

在 `searchStocks` 附近新增——找出现在消息文本里的「精确股票名」对应代码(name 是 message 的子串;偏好更长的名字):

```ts
// 文本里出现的「精确股票名」→ code(name 是 message 子串；多个则取最长名优先）。
export function findStockCodeInText(message: string): string | null {
  const row = getDb()
    .prepare("SELECT code FROM stock_names WHERE INSTR(?, name) > 0 ORDER BY LENGTH(name) DESC LIMIT 1")
    .get(message) as { code: string } | undefined;
  return row?.code ?? null;
}
```

- [ ] **Step 2: 写失败测试 `backend/src/chat/market-context.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mctx-'));

const mc = require('./market-context');
const svc = require('../data/service');
const { getDb } = require('../db');

describe('parseTimeWindow', () => {
  it('maps time phrases to trading-day counts, defaults 30, caps 500', () => {
    expect(mc.parseTimeWindow('昨天收盘价多少')).toBe(5);
    expect(mc.parseTimeWindow('近半年走势如何')).toBe(120);
    expect(mc.parseTimeWindow('最近一年呢')).toBe(250);
    expect(mc.parseTimeWindow('这只票怎么样')).toBe(30);     // 无时间词→默认
    expect(mc.parseTimeWindow('近三月')).toBe(66);
    expect(mc.parseTimeWindow('近十年的走势')).toBe(500);     // 超大→截 500（两年480在上限内，"十年"无匹配则默认30；见实现）
  });
});

describe('detectTarget', () => {
  beforeAll(() => {
    svc.cacheName('600519', '贵州茅台');
    svc.cacheName('000001', '平安银行');
  });
  it('detects index by 大盘/上证, sz/cyb keywords', () => {
    expect(mc.detectTarget('大盘近期怎么样', null)).toEqual({ kind: 'index', code: '000001' });
    expect(mc.detectTarget('深成指走势', null)).toEqual({ kind: 'index', code: '399001' });
    expect(mc.detectTarget('创业板指如何', null)).toEqual({ kind: 'index', code: '399006' });
  });
  it('detects stock by 6-digit known code or exact name', () => {
    expect(mc.detectTarget('600519 昨天收盘', null)).toEqual({ kind: 'stock', code: '600519' });
    expect(mc.detectTarget('贵州茅台近半年走势', null)).toEqual({ kind: 'stock', code: '600519' });
  });
  it('falls back to session stock, else null', () => {
    expect(mc.detectTarget('它最近怎么样', '600519')).toEqual({ kind: 'stock', code: '600519' });
    expect(mc.detectTarget('讲个笑话', null)).toBeNull();
  });
});
```

> 注:`parseTimeWindow('近十年的走势')`——「十年」不在映射表里,按"无匹配→默认 30";但用例写成 500 是想测上限。**改用一个真超上限的短语测上限**:把该断言改为 `expect(mc.parseTimeWindow('近两年走势')).toBe(480)`(480≤500,正常),并额外不单独测 500 截断(480 已是最大映射;`min(N,500)` 由实现保证)。请按此写(删掉"近十年→500"那条,换成"近两年→480")。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd backend && npx jest chat/market-context -i`
Expected: FAIL — 模块不存在。

- [ ] **Step 4: 实现 `backend/src/chat/market-context.ts`(本任务只做解析两函数)**

```ts
import { getCachedName, findStockCodeInText } from '../data/service';

export const RECENT_BARS_N = 30;
export const MAX_BARS_N = 500;

export type Target = { kind: 'stock'; code: string } | { kind: 'index'; code: string };

// 中文时间词 → 交易日数。顺序从长到短匹配，避免「近一月」被「一」误伤。
const TIME_RULES: Array<[RegExp, number]> = [
  [/两年|近两年|过去两年/, 480],
  [/一年|近一年|今年以来|过去一年/, 250],
  [/半年|近半年|六个月|6个月/, 120],
  [/三月|近三月|一季度|季度|三个月|3个月/, 66],
  [/两月|近两月|两个月/, 44],
  [/一月|近一月|本月|一个月|近30天|30天/, 22],
  [/两周|半个月|半月/, 10],
  [/一周|近一周|上周|本周|近7天|7天/, 5],
  [/昨天|今天|前天|这几天|最近几天|近几天/, 5],
];

export function parseTimeWindow(message: string): number {
  for (const [re, n] of TIME_RULES) {
    if (re.test(message)) return Math.min(n, MAX_BARS_N);
  }
  return RECENT_BARS_N;
}

const INDEX_RULES: Array<[RegExp, string]> = [
  [/深成指|深证成指|深证/, '399001'],
  [/创业板指|创业板/, '399006'],
  [/大盘|上证|沪指|A股|a股|指数/, '000001'],
];

export function detectTarget(message: string, sessionRefId: string | null): Target | null {
  for (const [re, code] of INDEX_RULES) {
    if (re.test(message)) return { kind: 'index', code };
  }
  const m = message.match(/\d{6}/);
  if (m && getCachedName(m[0])) return { kind: 'stock', code: m[0] };
  const byName = findStockCodeInText(message);
  if (byName) return { kind: 'stock', code: byName };
  if (sessionRefId) return { kind: 'stock', code: sessionRefId };
  return null;
}
```

> 注意 INDEX_RULES 顺序:深证/创业板在前,上证/「指数」兜底在后,避免「深成指」先被泛词命中。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && npx jest chat/market-context -i`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add backend/src/chat/market-context.ts backend/src/chat/market-context.test.ts backend/src/data/service.ts
git commit -m "feat(chat): 意图解析 parseTimeWindow + detectTarget（+findStockCodeInText）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A3: `ensureStockBars` 按需取数 + `buildStockContext` 组装

**Files:**
- Modify: `backend/src/data/service.ts`、`backend/src/chat/market-context.ts`
- Test: `backend/src/data/service.test.ts`、`backend/src/chat/market-context.test.ts`

- [ ] **Step 1: 写 `ensureStockBars` 失败测试(`service.test.ts`)**

```ts
describe('ensureStockBars', () => {
  it('uses local when enough & fresh; otherwise fetches via injected fetcher and caches', async () => {
    const code = 'ENS01';
    // 本地只有 2 根，不足 5 → 应触发抓取
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)').run(code, '2026-05-30', 1,1,1,9, 1, 'test');
    let fetched = 0;
    const fetcher = async (_code: string, n: number) => {
      fetched++;
      return [
        { code, date: '2026-06-01', open: 1, high: 1, low: 1, close: 10, volume: 1 },
        { code, date: '2026-06-02', open: 1, high: 1, low: 1, close: 11, volume: 1 },
        { code, date: '2026-06-03', open: 1, high: 1, low: 1, close: 12, volume: 1 },
        { code, date: '2026-06-04', open: 1, high: 1, low: 1, close: 13, volume: 1 },
        { code, date: '2026-06-05', open: 1, high: 1, low: 1, close: 14, volume: 1 },
      ].slice(0, n);
    };
    const bars = await svc.ensureStockBars('u1', code, 5, { fetcher });
    expect(fetched).toBe(1);
    expect(bars.length).toBeGreaterThanOrEqual(5);
    // 再次调用：本地已够 → 不再抓
    const bars2 = await svc.ensureStockBars('u1', code, 5, { fetcher });
    expect(fetched).toBe(1);
    expect(bars2.length).toBeGreaterThanOrEqual(5);
  });
});
```

> 用「注入 fetcher」让单测不触网。生产路径默认 fetcher 走 sidecar(见实现)。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest data/service -i -t "ensureStockBars"`
Expected: FAIL。

- [ ] **Step 3: 实现 `ensureStockBars`(`data/service.ts`)**

```ts
// 默认抓取器：走 sidecar 取 n 日线并缓存。
async function defaultBarFetcher(userId: string, code: string, n: number): Promise<Bar[]> {
  const base = resolveSidecarBase(userId);
  if (!base) return [];
  const res = await fetchQuotes(base, code, n);
  if (res && res.rows.length) cacheQuotes(res.rows, res.source ?? 'tdx');
  return res?.rows.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })) ?? [];
}

// 本地够(≥n)就用本地；不足则用 fetcher 抓取并缓存后再读本地。fetcher 可注入(测试)。
export async function ensureStockBars(
  userId: string,
  code: string,
  n: number,
  opts: { fetcher?: (code: string, n: number) => Promise<Bar[] | QuoteRow[]> } = {}
): Promise<Bar[]> {
  const local = getRecentBars(code, n);
  if (local.length >= n) return local;
  try {
    if (opts.fetcher) {
      const rows = await opts.fetcher(code, n);
      const qrows: QuoteRow[] = (rows as any[]).map((r) => ({ code, date: String(r.date), open: r.open ?? null, high: r.high ?? null, low: r.low ?? null, close: r.close ?? null, volume: r.volume ?? null }));
      if (qrows.length) cacheQuotes(qrows, 'test');
    } else {
      await defaultBarFetcher(userId, code, n);
    }
  } catch {
    /* 安静降级 */
  }
  return getRecentBars(code, n);
}
```

> "够新"判断:本任务先用"够数(≥n)"作为命中本地的条件(简单、可靠);精细的"最新日期是否最近交易日"留作可选增强,不在本任务范围(YAGNI——cron 每天补最近数据,够数基本意味着够新)。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx jest data/service -i -t "ensureStockBars"`
Expected: PASS。

- [ ] **Step 5: 写 `buildStockContext` 失败测试(`market-context.test.ts`)**

```ts
describe('buildStockContext', () => {
  it('renders snapshot head + OHLC table + range note; empty when no data', () => {
    const snap = { code: '600519', name: '贵州茅台', close: 1600, ma20: 1550, ma60: 1500, pe: 30, pb: 9, roe_ttm: 28, year_high: 1800 };
    const bars = [
      { date: '2026-06-03', open: 1580, high: 1610, low: 1570, close: 1600, volume: 1000 },
      { date: '2026-06-04', open: 1600, high: 1620, low: 1590, close: 1610, volume: 1100 },
    ];
    const out = mc.buildStockContext('600519', snap, bars);
    expect(out).toContain('600519');
    expect(out).toContain('贵州茅台');
    expect(out).toContain('2026-06-04');
    expect(out).toContain('1610');
    expect(out).toContain('最近 2 个交易日');
    expect(mc.buildStockContext('X', null, [])).toBe('');
  });
});
```

- [ ] **Step 6: 跑确认失败 → 实现 `buildStockContext`(`market-context.ts`)**

```ts
import { Bar } from '../data/service'; // Bar 类型从 service 导出（A1 已定义）
import { StockSnapshot } from '../types';

function n2(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : (Math.round(x * 100) / 100).toString();
}

export function buildStockContext(code: string, snapshot: StockSnapshot | null, bars: Bar[]): string {
  if (!bars.length && !snapshot) return '';
  const head = snapshot
    ? `【${code} ${snapshot.name ?? ''}】现价 ${n2(snapshot.close)}｜MA20 ${n2(snapshot.ma20)}｜MA60 ${n2(snapshot.ma60)}｜PE ${n2(snapshot.pe)}｜PB ${n2(snapshot.pb)}｜ROE ${n2(snapshot.roe_ttm)}%｜年内高 ${n2(snapshot.year_high)}`
    : `【${code}】`;
  const tableHead = '日期│开│高│低│收│量';
  const rows = bars.map((b) => `${b.date}│${n2(b.open)}│${n2(b.high)}│${n2(b.low)}│${n2(b.close)}│${n2(b.volume)}`);
  const note = bars.length
    ? `以上为 ${code} 最近 ${bars.length} 个交易日日线(截至 ${bars[bars.length - 1].date});更早数据本地暂未提供。这些数字系统已算好，请勿臆造窗口外数据。`
    : '本地暂无该股历史行情，可在「数据」页同步后再问。';
  return [head, tableHead, ...rows, note].join('\n');
}
```

Run failing test then: `cd backend && npx jest chat/market-context -i -t "buildStockContext"` → PASS。

> A1 需把 `Bar` 接口 `export`(上面已 `export interface Bar`)。确认 `market-context.ts` 能 `import { Bar } from '../data/service'`。

- [ ] **Step 7: 全量回归 + 提交**

Run: `cd backend && npx tsc --noEmit && npm test`(全绿)。

```bash
git add backend/src/data/service.ts backend/src/data/service.test.ts backend/src/chat/market-context.ts backend/src/chat/market-context.test.ts
git commit -m "feat: ensureStockBars 按需取数 + buildStockContext 组装

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A4: 修 `getStockSnapshot` 深度坑

**Files:**
- Modify: `backend/src/data/service.ts`
- Test: `backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试(`service.test.ts`)**

注入 `refreshStock` 不易(内部函数),改为**行为断言**:本地只有 10 根时,`getStockSnapshot` 应尝试深取(通过 mock sidecar 或断言触发条件)。最简做法:抽出纯判定函数 `shouldDeepFetch(code, haveFund)` 并测它。

```ts
describe('getStockSnapshot depth gate', () => {
  it('shouldDeepFetch true when local closes < 60', () => {
    const code = 'DEP01';
    const db = getDb();
    for (let i = 0; i < 10; i++) {
      db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,close,source) VALUES (?,?,?,?)').run(code, `2026-05-${(i+1).toString().padStart(2,'0')}`, 5, 'test');
    }
    expect(svc.shouldDeepFetch(code)).toBe(true);   // 只有 10 根 < 60
  });
  it('shouldDeepFetch false when local closes >= 60', () => {
    const code = 'DEP02';
    const db = getDb();
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,close,source) VALUES (?,?,?,?)').run(code, d, 5, 'test');
    }
    expect(svc.shouldDeepFetch(code)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `cd backend && npx jest data/service -i -t "depth gate"`
Expected: FAIL — `svc.shouldDeepFetch is not a function`。

- [ ] **Step 3: 实现 `shouldDeepFetch` + 接入 `getStockSnapshot` + `refreshStock` 提深**

新增导出函数:
```ts
// 本地行情深度不足 60 根 → 需要深取（保证 ma60/year_high 准）。
export function shouldDeepFetch(code: string): boolean {
  return recentCloses(code, 60).length < 60;
}
```

在 `getStockSnapshot` 里把:
```ts
  const haveQuotes = recentCloses(code, 1).length > 0;
  const haveFund = !!latestFundamentals(code);
  if (!haveQuotes || !haveFund) {
    await refreshStock(userId, code, []).catch(() => {});
  }
```
改为:
```ts
  const haveFund = !!latestFundamentals(code);
  if (shouldDeepFetch(code) || !haveFund) {
    await refreshStock(userId, code, []).catch(() => {});
  }
```

在 `refreshStock` 里把 `fetchQuotes(base, code, 120)` 改为 `fetchQuotes(base, code, 250)`(让 year_high 也准)。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd backend && npx jest data/service -i -t "depth gate"`(PASS),`npm test`(全绿)。

> 回归注意:若已有 `getStockSnapshot` 测试依赖"本地有 1 根就不刷新"的旧行为,可能因新逻辑触发刷新而走 sidecar。检查这些测试是否注入了 sidecar mock 或 `resolveSidecarBase` 返回空(返回空时 `refreshStock` 直接 return,不影响)。如有失败,按"无 base 时安静跳过"语义修正测试期望。

- [ ] **Step 5: 提交**

```bash
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "fix(data): getStockSnapshot 本地<60根即深取，refreshStock 取250根（修 ma60/year_high 被10天盖住）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A5: `buildMarketInjection` 编排 + 接入 `postMessage`(个股)

**Files:**
- Modify: `backend/src/chat/market-context.ts`、`backend/src/chat/service.ts`
- Test: `backend/src/chat/service.test.ts`

- [ ] **Step 1: 实现 `buildMarketInjection`(`market-context.ts`)**

```ts
import { ensureStockBars, getStockSnapshot } from '../data/service';

// 编排：据消息解析目标+窗口 → 取数 → 组装。本任务只处理 stock 分支（index 分支在 Part B 接入）。
export async function buildMarketInjection(
  userId: string,
  sessionKind: string,
  sessionRefId: string | null,
  message: string
): Promise<string> {
  const refId = sessionKind === 'stock' ? sessionRefId : null;
  const target = detectTarget(message, refId);
  if (!target) return '';
  const n = parseTimeWindow(message);
  try {
    if (target.kind === 'stock') {
      const bars = await ensureStockBars(userId, target.code, n);
      const snap = await getStockSnapshot(userId, target.code).catch(() => null);
      return buildStockContext(target.code, snap, bars);
    }
    return ''; // index：Part B 实现
  } catch {
    return '';
  }
}
```

- [ ] **Step 2: 写集成失败测试(`chat/service.test.ts`)**

```ts
describe('postMessage injects market context for stock target', () => {
  it('stock session prompt includes recent bars table', async () => {
    const U = 'u-mc-inject';
    const code = 'INJ01';
    const db = getDb();
    for (let i = 1; i <= 35; i++) {
      const d = `2026-04-${i.toString().padStart(2,'0')}`.slice(0,10);
      db.prepare('INSERT OR REPLACE INTO quote_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)')
        .run(code, `2026-04-${(i%28+1).toString().padStart(2,'0')}`, 1,1,1, 100+i, 1, 'test');
    }
    const sid = chat.createSession(U, 'stock', code, `个股 ${code}`);
    let captured = '';
    await chat.postMessage(U, sid, '最近走势如何', {
      aiCall: async (p: string) => { captured = p; return { raw: 'ok', provider: 'p', model: 'm' }; },
    });
    expect(captured).toContain('日期│开│高│低│收│量');
    expect(captured).toContain(code);
  });
});
```
(若 35 条造数日期有重复不影响断言——只验证表头与 code 出现。可简化为塞 5 条不同日期。请按需调整为干净的 5-30 条不同日期数据。)

- [ ] **Step 3: 跑确认失败**

Run: `cd backend && npx jest chat/service -i -t "injects market context"`
Expected: FAIL（prompt 不含行情表头）。

- [ ] **Step 4: 接入 `postMessage`(`chat/service.ts`)**

在 `postMessage` 现有 `extraContext` 各 `if (!extra && ...)` 分支**之后**、构造 `framing`/`prompt` **之前**,加:

```ts
  // 行情数据注入（个股/大盘，动态窗口）。仅当调用方未显式传 extraContext 时。
  if (!opts.extraContext) {
    try {
      const mc = await buildMarketInjection(userId, session.kind, session.ref_id ?? null, content);
      if (mc) extra = [extra, mc].filter(Boolean).join('\n\n');
    } catch {
      /* 安静降级 */
    }
  }
```
在文件顶部 import:`import { buildMarketInjection } from './market-context';`

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `cd backend && npx jest chat/service -i`(全绿),`npx tsc --noEmit`,`npm test`(全绿)。

- [ ] **Step 6: 提交**

```bash
git add backend/src/chat/market-context.ts backend/src/chat/service.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): postMessage 注入个股近期行情（buildMarketInjection 编排）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Part B — 大盘:上证指数点位日线 + 情绪历史

## Task B1: sidecar 取指数日线 + `/index/{code}`

**Files:**
- Modify: `sidecar/tdx.py`、`sidecar/main.py`
- Test: 容器内实连自检(见步骤)

- [ ] **Step 1: 容器内探明 mootdx 指数接口**

启动/确认容器在跑:`cd /home/zhangjq/projects/stock-agent && docker compose up -d`。
在容器内交互式探明 mootdx 取指数日线的正确调用(不要照搬假设):
```bash
docker exec -it stock-agent-akshare-mcp-1 python - <<'PY'
from mootdx.quotes import Quotes
c = Quotes.factory(market='std')
# 试探：标准客户端取指数日线。常见为 c.index(symbol='000001', frequency=9, offset=20) 或 c.bars(...,market=1)
for attempt in ['index', 'bars']:
    try:
        fn = getattr(c, attempt)
        df = fn(symbol='000001', frequency=9, offset=10) if attempt=='index' else fn(symbol='000001', frequency=9, offset=10)
        print(attempt, type(df))
        print(df.tail(3) if df is not None else None)
    except Exception as e:
        print(attempt, 'ERR', repr(e))
PY
```
记录哪种调用能返回上证指数(000001)的日线 DataFrame(含 datetime/open/high/low/close/vol/amount 之类列)。**以实跑结果为准**实现下一步。

- [ ] **Step 2: 实现 `index_bars`(`sidecar/tdx.py`)**

按 Step 1 探明的调用实现(下面是模板,字段名以实跑列名为准;指数**不做前复权**):
```python
def index_bars(code, days=120):
    """上证/深证指数日线（不复权）。升序 [{date,open,high,low,close,volume}]。"""
    def _do():
        c = _get_client()
        raw = c.index(symbol=code, frequency=9, offset=days)  # ← 按 Step1 实测改为正确方法
        bars = []
        for _, r in raw.iterrows():
            d = str(r.get('datetime') or r.get('date'))[:10]
            bars.append({
                'date': d,
                'open': float(r['open']), 'high': float(r['high']),
                'low': float(r['low']), 'close': float(r['close']),
                'volume': float(r.get('vol') or r.get('volume') or 0),
            })
        bars.sort(key=lambda b: b['date'])
        return bars
    try:
        return _call(_do)
    except Exception:
        return []
```

- [ ] **Step 3: 加路由(`sidecar/main.py`)**

```python
@app.get("/index/{code}")
def index_endpoint(code: str, days: int = 120):
    rows = tdx.index_bars(code, days)
    return {"rows": rows, "source": "tdx"}
```

- [ ] **Step 4: 容器内实连自检**

```bash
docker compose up -d --build   # 重建带 /index 的 sidecar
curl -s 'http://localhost:8000/index/000001?days=5' | head -c 400 ; echo
```
(sidecar 端口以 compose 为准;若非 8000 用容器内 `curl localhost:<port>`。)
Expected: 返回含 5 行上证指数日线的 JSON(date/close 等)。若取不到 → `rows:[]`(B 部分将自动降级为只用情绪历史)。

- [ ] **Step 5: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add sidecar/tdx.py sidecar/main.py
git commit -m "feat(sidecar): 取指数日线 + GET /index/{code}

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 若 Step 1 探明 mootdx **无法**取指数日线(所有尝试 ERR):记 BLOCKED 并向控制者报告——B 部分改为「只做情绪/广度历史注入」(跳过 index_daily/ensureIndexBars,`buildIndexContext` 仅渲染情绪序列)。

---

## Task B2: `index_daily` 表 + 取数(本地/按需)

**Files:**
- Modify: `backend/src/db.ts`、`backend/src/data/service.ts`、`backend/src/data/sidecar.ts`
- Test: `backend/src/data/service.test.ts`

- [ ] **Step 1: 建表(`db.ts`)**

在建表区(`quote_daily` 附近)加:
```ts
    CREATE TABLE IF NOT EXISTS index_daily (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL,
      source TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (code, date)
    );
```

- [ ] **Step 2: `fetchIndexBars`(`data/sidecar.ts`)**

仿 `fetchQuotes`:
```ts
export async function fetchIndexBars(base: string, code: string, days = 120): Promise<{ source: string | null; rows: QuoteRow[] } | null> {
  const data = await getJson(`${base}/index/${code}?days=${days}`);
  const arr = Array.isArray(data) ? data : data?.rows;
  if (!Array.isArray(arr)) return null;
  const source = Array.isArray(data) ? null : (data?.source ?? null);
  return { source, rows: arr.map((r: any) => ({ code, date: String(r.date), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume) })) };
}
```
(`num`/`qs` 等已在文件内;`QuoteRow` 已 import。)

- [ ] **Step 3: 写失败测试(`service.test.ts`)— cacheIndexBars / getRecentIndexBars / ensureIndexBars**

```ts
describe('index bars store + ensure', () => {
  it('cache + getRecent ascending; ensure fetches when local insufficient', async () => {
    svc.cacheIndexBars([
      { code: '000001', date: '2026-06-02', open: 3000, high: 3010, low: 2990, close: 3005, volume: 1 },
      { code: '000001', date: '2026-06-03', open: 3005, high: 3030, low: 3000, close: 3025, volume: 1 },
    ], 'test');
    const bars = svc.getRecentIndexBars('000001', 5);
    expect(bars.map((b: any) => b.date)).toEqual(['2026-06-02', '2026-06-03']);
    let fetched = 0;
    const fetcher = async (_c: string, n: number) => { fetched++; return [
      { code: '000001', date: '2026-06-04', open: 3025, high: 3050, low: 3020, close: 3040, volume: 1 },
      { code: '000001', date: '2026-06-05', open: 3040, high: 3060, low: 3030, close: 3055, volume: 1 },
      { code: '000001', date: '2026-06-06', open: 3055, high: 3070, low: 3050, close: 3060, volume: 1 },
    ].slice(0, n); };
    const out = await svc.ensureIndexBars('u1', '000001', 5, { fetcher });
    expect(fetched).toBe(1);
    expect(out.length).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 4: 实现 `cacheIndexBars` / `getRecentIndexBars` / `ensureIndexBars`(`data/service.ts`)**

```ts
export function cacheIndexBars(rows: QuoteRow[], source: string): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO index_daily (code,date,open,high,low,close,volume,source) VALUES (@code,@date,@open,@high,@low,@close,@volume,@source)
     ON CONFLICT(code,date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,source=excluded.source`
  );
  const tx = db.transaction((items: QuoteRow[]) => { for (const r of items) stmt.run({ ...r, source }); });
  tx(rows);
  return rows.length;
}

export function getRecentIndexBars(code: string, n: number): Bar[] {
  const rows = getDb()
    .prepare('SELECT date, open, high, low, close, volume FROM index_daily WHERE code = ? ORDER BY date DESC LIMIT ?')
    .all(code, n) as Bar[];
  return rows.reverse();
}

async function defaultIndexFetcher(userId: string, code: string, n: number): Promise<Bar[]> {
  const base = resolveSidecarBase(userId);
  if (!base) return [];
  const res = await fetchIndexBars(base, code, n);
  if (res && res.rows.length) cacheIndexBars(res.rows, res.source ?? 'tdx');
  return res?.rows.map((r) => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })) ?? [];
}

export async function ensureIndexBars(
  userId: string, code: string, n: number,
  opts: { fetcher?: (code: string, n: number) => Promise<QuoteRow[] | Bar[]> } = {}
): Promise<Bar[]> {
  const local = getRecentIndexBars(code, n);
  if (local.length >= n) return local;
  try {
    if (opts.fetcher) {
      const rows = await opts.fetcher(code, n);
      const qrows: QuoteRow[] = (rows as any[]).map((r) => ({ code, date: String(r.date), open: r.open ?? null, high: r.high ?? null, low: r.low ?? null, close: r.close ?? null, volume: r.volume ?? null }));
      if (qrows.length) cacheIndexBars(qrows, 'test');
    } else {
      await defaultIndexFetcher(userId, code, n);
    }
  } catch { /* 安静降级 */ }
  return getRecentIndexBars(code, n);
}
```
顶部确保 `import { fetchIndexBars } from './sidecar';`(与现有 fetchQuotes import 同处)。

- [ ] **Step 5: 跑测试 + 回归 + 提交**

Run: `cd backend && npx jest data/service -i -t "index bars"`(PASS),`npx tsc --noEmit`,`npm test`(全绿)。
```bash
git add backend/src/db.ts backend/src/data/service.ts backend/src/data/sidecar.ts backend/src/data/service.test.ts
git commit -m "feat(data): index_daily 表 + cache/getRecent/ensureIndexBars + fetchIndexBars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B3: `getMarketSentimentSeries` + `buildIndexContext`

**Files:**
- Modify: `backend/src/data/service.ts`、`backend/src/chat/market-context.ts`
- Test: `backend/src/data/service.test.ts`、`backend/src/chat/market-context.test.ts`

- [ ] **Step 1: 写 `getMarketSentimentSeries` 失败测试(`service.test.ts`)**

```ts
describe('getMarketSentimentSeries', () => {
  it('returns ascending series capped at n', () => {
    const db = getDb();
    for (const d of ['2026-06-01','2026-06-02','2026-06-03']) {
      db.prepare('INSERT OR REPLACE INTO market_sentiment (date,limit_up_count,limit_down_count,sse_ma20_slope,source) VALUES (?,?,?,?,?)')
        .run(d, 50, 10, 0.1, 'test');
    }
    const s = svc.getMarketSentimentSeries(2);
    expect(s.map((x: any) => x.date)).toEqual(['2026-06-02','2026-06-03']);
  });
});
```

- [ ] **Step 2: 跑确认失败 → 实现(`data/service.ts`)**

```ts
export function getMarketSentimentSeries(n: number): Array<{ date: string; limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null }> {
  const rows = getDb()
    .prepare('SELECT date, limit_up_count, limit_down_count, sse_ma20_slope FROM market_sentiment ORDER BY date DESC LIMIT ?')
    .all(n) as any[];
  return rows.reverse();
}
```
Run: `cd backend && npx jest data/service -i -t "getMarketSentimentSeries"` → PASS。

- [ ] **Step 3: 写 `buildIndexContext` 失败测试(`market-context.test.ts`)**

```ts
describe('buildIndexContext', () => {
  it('renders index close+pct table and sentiment tail; sentiment-only when no bars', () => {
    const bars = [
      { date: '2026-06-02', open: 3000, high: 3010, low: 2990, close: 3000, volume: 1 },
      { date: '2026-06-03', open: 3000, high: 3030, low: 3000, close: 3030, volume: 1 },
    ];
    const sent = [{ date: '2026-06-03', limit_up_count: 60, limit_down_count: 8, sse_ma20_slope: 0.2 }];
    const out = mc.buildIndexContext('000001', bars, sent);
    expect(out).toContain('000001');
    expect(out).toContain('3030');
    expect(out).toContain('涨停');           // 情绪段
    // 无 bars → 仅情绪
    const only = mc.buildIndexContext('000001', [], sent);
    expect(only).toContain('涨停');
    expect(only).not.toContain('日期│收│涨跌幅');
  });
});
```

- [ ] **Step 4: 跑确认失败 → 实现 `buildIndexContext`(`market-context.ts`)**

```ts
interface Sentiment { date: string; limit_up_count: number | null; limit_down_count: number | null; sse_ma20_slope: number | null }

export function buildIndexContext(code: string, bars: Bar[], sentiment: Sentiment[]): string {
  const name = code === '000001' ? '上证指数' : code === '399001' ? '深证成指' : code === '399006' ? '创业板指' : code;
  const parts: string[] = [`【大盘 ${name}(${code})】`];
  if (bars.length) {
    parts.push('日期│收│涨跌幅');
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      const prev = i > 0 ? bars[i - 1].close : null;
      const pct = c != null && prev ? `${(((c - prev) / prev) * 100).toFixed(2)}%` : '—';
      parts.push(`${bars[i].date}│${n2(c)}│${pct}`);
    }
    parts.push(`以上为 ${name} 最近 ${bars.length} 个交易日点位(截至 ${bars[bars.length - 1].date});更早数据本地暂未提供。`);
  }
  if (sentiment.length) {
    const s = sentiment.map((x) => `${x.date}: 涨停${x.limit_up_count ?? '—'}/跌停${x.limit_down_count ?? '—'}/上证20线斜率${n2(x.sse_ma20_slope)}`);
    parts.push('近期情绪(涨跌停家数/上证20日线斜率):', ...s);
  }
  if (!bars.length && !sentiment.length) return '';
  return parts.join('\n');
}
```
Run failing test then PASS。

- [ ] **Step 5: 回归 + 提交**

Run: `cd backend && npx tsc --noEmit && npm test`(全绿)。
```bash
git add backend/src/data/service.ts backend/src/data/service.test.ts backend/src/chat/market-context.ts backend/src/chat/market-context.test.ts
git commit -m "feat: getMarketSentimentSeries + buildIndexContext

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B4: 接入 index 分支到 `buildMarketInjection`

**Files:**
- Modify: `backend/src/chat/market-context.ts`
- Test: `backend/src/chat/service.test.ts`

- [ ] **Step 1: 写集成失败测试(`chat/service.test.ts`)**

```ts
describe('postMessage injects index context for 大盘 target', () => {
  it('general chat about 大盘 includes index/sentiment block', async () => {
    const U = 'u-mc-index';
    const db = getDb();
    for (const d of ['2026-06-01','2026-06-02','2026-06-03','2026-06-04','2026-06-05']) {
      db.prepare('INSERT OR REPLACE INTO index_daily (code,date,open,high,low,close,volume,source) VALUES (?,?,?,?,?,?,?,?)')
        .run('000001', d, 3000,3010,2990, 3000 + Number(d.slice(-2)), 1, 'test');
      db.prepare('INSERT OR REPLACE INTO market_sentiment (date,limit_up_count,limit_down_count,sse_ma20_slope,source) VALUES (?,?,?,?,?)')
        .run(d, 50, 10, 0.1, 'test');
    }
    const sid = chat.createSession(U, 'general', null, '闲聊');
    let captured = '';
    await chat.postMessage(U, sid, '大盘最近走势如何', {
      aiCall: async (p: string) => { captured = p; return { raw: 'ok', provider: 'p', model: 'm' }; },
    });
    expect(captured).toContain('大盘');
    expect(captured).toContain('涨停');
  });
});
```
(本地已塞 5 条 index_daily,`ensureIndexBars` 命中本地、不联网。)

- [ ] **Step 2: 跑确认失败**

Run: `cd backend && npx jest chat/service -i -t "index context"`
Expected: FAIL（buildMarketInjection 的 index 分支还是返回 ''）。

- [ ] **Step 3: 实现 index 分支(`market-context.ts` 的 `buildMarketInjection`)**

把 `return ''; // index：Part B 实现` 替换为:
```ts
    // index
    const bars = await ensureIndexBars(userId, target.code, n);
    const sent = getMarketSentimentSeries(Math.min(n, 30));
    return buildIndexContext(target.code, bars, sent);
```
顶部 import 增补:`import { ensureStockBars, getStockSnapshot, ensureIndexBars, getMarketSentimentSeries } from '../data/service';`

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd backend && npx jest chat/service -i`(全绿),`npx tsc --noEmit`,`npm test`(全绿)。

- [ ] **Step 5: 提交**

```bash
git add backend/src/chat/market-context.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): 大盘问题注入上证指数点位+情绪历史

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task C: 端到端验证 & 部署冒烟

**Files:** 无(验证 only)

- [ ] **Step 1: 全量后端测试 + tsc**

Run: `cd backend && npx tsc --noEmit && npm test`
Expected: 全绿(≥ 220 + 新增)。

- [ ] **Step 2: 前端类型检查(确认未被波及)**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3: 构建 + 起容器(含新 sidecar /index)**

Run: `cd /home/zhangjq/projects/stock-agent && docker compose up -d --build`
Expected: `app`、`akshare-mcp` healthy。

- [ ] **Step 4: 手动冒烟(浏览器,需用户)**

1. 开一只个股会话,问「昨天收盘价多少 / 最近走势」→ 来财据近期日线回答具体数字。
2. 个股会话问「近半年走势」→ 触发深取 120 日,来财能讲半年区间。
3. 普通聊天问「600519 近一个月怎么样」/「贵州茅台近半年」→ 注入该股数据后作答。
4. 普通聊天问「大盘最近怎么样 / 上证近半年」→ 注入指数点位+情绪后作答(若 sidecar 指数取不到,则只据情绪历史答,并说明无点位)。
5. 问超出窗口的「三年前的某天收盘」→ 来财据范围说明句如实说只有最近约 N 日数据。
6. **回归**:核心原则/早晚会/选股 等场景行为不变;无数据源时聊天不报错(安静降级)。

- [ ] **Step 5: 完成开发分支**

按 `superpowers:finishing-a-development-branch` 收尾(普通 repo,master 主线;是否推送/合并听用户)。

---

## Self-Review(对照 spec)

**Spec coverage:**
- 意图解析 parseTimeWindow/detectTarget → A2 ✅
- A 个股 getRecentBars/ensureStockBars/buildStockContext → A1/A3 ✅
- A 顺手修 getStockSnapshot 深度 → A4 ✅
- 注入 postMessage(个股) → A5 ✅
- B sidecar 取指数 + /index → B1 ✅(含实连确认 + 取不到降级)
- B index_daily 表 + ensureIndexBars + fetchIndexBars → B2 ✅
- B getMarketSentimentSeries + buildIndexContext → B3 ✅
- 注入 postMessage(大盘) → B4 ✅
- token/边界/安静降级 → buildStockContext/buildIndexContext 范围句 + postMessage try/catch ✅
- 部署/非目标 → C ✅

**Type consistency:** `Bar`(A1 导出,A3/B2/B3 复用)、`QuoteRow`(types)、`ensureStockBars(userId,code,n,{fetcher})`/`ensureIndexBars` 同签名、`detectTarget` 返回 `{kind,code}`、`buildMarketInjection(userId,sessionKind,sessionRefId,message)`、`fetchQuotes/fetchIndexBars` 同形。一致。

**Placeholder scan:** 无 TBD/TODO。B1 的 mootdx 指数调用是「容器内实测后按实际列名实现」的明确指令 + BLOCKED 降级路径,非占位。A2 测试里"近十年→500"那条已在 Step2 注里要求改为"近两年→480"(避免与实现不符)。

**已知偏差(对 spec 的合理细化):** spec 写"用 searchStocks 做名称识别",计划改为更正确的 `findStockCodeInText`(`INSTR(message,name)`,因 searchStocks 方向相反无法匹配)。"够新"判断简化为"够数(≥n)"(YAGNI,见 A3 注)。
