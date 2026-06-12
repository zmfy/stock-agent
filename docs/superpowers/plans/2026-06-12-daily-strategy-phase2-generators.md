# 当天策略引擎 · 阶段② 生成引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 4 类策略内容的生成器(预判 / 盘中 / 复盘 / 休市快报)，按用户生成并写入 `daily_strategy`。复用现有 meetings 的行情/板块/新闻/人设/AI 调用助手；预判的新闻窗口固定为「自上一交易日以来」(天然覆盖节后)。不含调度器/房间/UI(阶段③④⑤)。

**Architecture:** 新文件 `backend/src/strategy/generate.ts` 持有 4 个生成器 + 各自 prompt 构造。每个生成器以**单次核心 AI 调用**(注入 `opts.aiCall` 便于测试;盘中每小时跑,单次调用比多 agent 流水更省更合适)产出内容，调 `recordStrategy` 落库。复用 meetings/service.ts 的输入助手(导出后 import)。`now`/`aiCall`/`fetchNews` 可注入。

**Tech Stack:** Express/TS + jest。

参照 spec：`docs/superpowers/specs/2026-06-12-daily-strategy-engine-design.md`(B 生成引擎、C 休市日)。依赖阶段①的 `strategy/service.ts`(`recordStrategy`/`getStrategy`/`getIntradayTimeline`/`beijingDate`)。

---

## 文件结构

- Modify `backend/src/meetings/service.ts` — 把通用输入助手改为 `export`(无逻辑改动)
- Modify `backend/src/data/news-log.ts` — 新增 `newsTitlesSince(sinceIso)`
- Create `backend/src/strategy/generate.ts` — 4 prompt 构造 + 4 生成器 + 新闻窗口
- Create `backend/src/strategy/generate.test.ts` — 单测(注入 aiCall/fetchNews/now)

---

## Task 1: 暴露复用助手 + 新闻时间窗

**Files:** Modify `backend/src/meetings/service.ts`、`backend/src/data/news-log.ts`

- [ ] **Step 1: 导出 meetings 通用输入助手**

在 `backend/src/meetings/service.ts` 给这几个**现有私有函数**加 `export`(仅加关键字，函数体不动)：`marketText`、`sectorText`、`rulebookText`、`personaOf`、`defaultAiCall`、`parseAdopt`。
> 先 grep 确认它们当前是 `function xxx(` / `async function xxx(`，改为 `export function` / `export async function`。这些是通用助手(行情文本/板块/规则书文本/人设/AI 调用/__ADOPT__ 解析)，阶段③退役 morning/evening 生成时它们保留。

- [ ] **Step 2: news-log 加时间窗查询**

在 `backend/src/data/news-log.ts` 末尾加（仿 `listTitleLog` 的 SELECT 风格，确认 `getDb`/表名 `news_title_log`/`news_content_log` 与该文件一致）：
```ts
// 自某时间点(含)以来采集的新闻标题(去重保留最早一次)，给「策略预判」按「上一交易日以来」取窗口用。
export function newsTitlesSince(sinceIso: string, limit = 80): Array<{ content_id: string; title: string; collected_at: string }> {
  return getDb()
    .prepare(
      `SELECT content_id, title, MIN(collected_at) AS collected_at
       FROM news_title_log
       WHERE collected_at >= ?
       GROUP BY content_id
       ORDER BY collected_at DESC
       LIMIT ?`,
    )
    .all(sinceIso, limit) as Array<{ content_id: string; title: string; collected_at: string }>;
}
```
> 若 `news_title_log` 无 `content_id` 列(以 `listTitleLog` 的实际列为准，它 SELECT 了 `t.content_id`)，按实际列名调整；目标是「按 collected_at ≥ sinceIso 取标题列表」。

- [ ] **Step 3: 编译检查** — `cd ~/projects/stock-agent/backend && npx tsc --noEmit`。Expected: exit 0。

- [ ] **Step 4: 全量回归(确认导出未破坏 meetings)** — `cd ~/projects/stock-agent/backend && npx jest meetings -i`。Expected: 既有 meetings 测试绿(仅加 export，无行为改动)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/meetings/service.ts backend/src/data/news-log.ts
git commit -m "refactor(meetings): 导出通用输入助手(行情/板块/规则书/人设/AI/ADOPT)；news-log 加 newsTitlesSince 时间窗

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 4 类生成器 + prompt（TDD）

**Files:** Create `backend/src/strategy/generate.ts`、`backend/src/strategy/generate.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/strategy/generate.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-strat-gen-'));

const { getDb } = require('../db');
const svc = require('./service');
const gen = require('./generate');

const U = 'u1';
beforeEach(() => {
  getDb().exec('DELETE FROM daily_strategy; DELETE FROM daily_strategy_config; DELETE FROM news_title_log; DELETE FROM news_content_log;');
});

// 收集每次 aiCall 收到的 prompt，便于断言上下文注入
function recordingAi(reply = '核心结论') {
  const prompts: string[] = [];
  const aiCall = async (p: string) => {
    prompts.push(p);
    return reply;
  };
  return { aiCall, prompts };
}
const D = '2026-06-10';
const NOON = Date.UTC(2026, 5, 10, 4, 0, 0); // 北京 12:00（交易日盘中之外亦可，仅作 now 注入）

describe('generators 落库到正确 phase', () => {
  it('预判 → daily_strategy.phase=prejudge', async () => {
    const { aiCall } = recordingAi('今日偏多，关注券商');
    await gen.generatePrejudge(U, { aiCall, fetchNews: async () => {}, now: Date.UTC(2026, 5, 10, 0, 0, 0) });
    expect(svc.getStrategy(U, D, 'prejudge')?.content).toContain('今日偏多');
  });
  it('盘中 → 累积 intraday', async () => {
    const { aiCall } = recordingAi('盘中：放量上行');
    await gen.generateIntraday(U, { aiCall, now: NOON });
    await gen.generateIntraday(U, { aiCall, now: NOON });
    expect(svc.getIntradayTimeline(U, D)).toHaveLength(2);
  });
  it('复盘 → phase=review，且 prompt 含当天预判 + 盘中', async () => {
    svc.recordStrategy(U, 'prejudge', '【预判】偏多', {}, D);
    svc.recordStrategy(U, 'intraday', '【盘中】券商冲高', {}, D);
    const { aiCall, prompts } = recordingAi('复盘：预判方向对，券商兑现');
    await gen.generateReview(U, { aiCall, now: Date.UTC(2026, 5, 10, 8, 0, 0) }); // 北京16:00
    expect(svc.getStrategy(U, D, 'review')?.content).toContain('复盘');
    const joined = prompts.join('\n');
    expect(joined).toContain('偏多');        // 含当天预判
    expect(joined).toContain('券商冲高');     // 含当天盘中
  });
  it('休市快报 → phase=holiday', async () => {
    const { aiCall } = recordingAi('节假日消息面：xxx；可能受影响板块：旅游');
    await gen.generateHoliday(U, { aiCall, fetchNews: async () => {}, now: NOON });
    expect(svc.getStrategy(U, D, 'holiday')?.content).toContain('受影响板块');
  });
});

describe('预判新闻窗口=自上一交易日以来(覆盖节后)', () => {
  it('预判 prompt 含上一交易日之后采集的新闻标题', async () => {
    // 造一条「昨天」采集的新闻；预判窗口应纳入
    const cid = 'c1';
    getDb().prepare("INSERT INTO news_content_log (id, title, content, source, collected_at) VALUES (?, '节前重大利好', '正文', 'test', datetime('now','-1 day'))").run(cid);
    getDb().prepare("INSERT INTO news_title_log (id, content_id, title, source, collected_at) VALUES ('t1', ?, '节前重大利好', 'test', datetime('now','-1 day'))").run(cid);
    const { aiCall, prompts } = recordingAi('预判');
    await gen.generatePrejudge(U, { aiCall, fetchNews: async () => {}, now: Date.now() });
    expect(prompts.join('\n')).toContain('节前重大利好');
  });
});
```
> 若 `news_content_log`/`news_title_log` 的列与上面 INSERT 不符，先 Read `data/news-log.ts` 与 `db.ts` 对应建表，按真实列名调整 INSERT。

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest strategy/generate -i`。Expected: FAIL（`Cannot find module './generate'`）。

- [ ] **Step 3: 实现 `backend/src/strategy/generate.ts`**

```ts
import { getActive } from '../rulebook/service';
import { refreshNews } from '../data/service';
import { newsTitlesSince } from '../data/news-log';
import { getCorePersona } from '../agent/profiles-service';
import { isTradingDay, lastTradingDayBefore } from '../data/trade-calendar';
import { marketText, sectorText, rulebookText, defaultAiCall } from '../meetings/service';
import { beijingDate, recordStrategy, getStrategy, getIntradayTimeline, StrategyPhase } from './service';

export interface GenStrategyOpts {
  aiCall?: (prompt: string, role?: string) => Promise<string>;
  fetchNews?: () => Promise<void>;
  now?: number;
}

function resolveAi(userId: string, opts: GenStrategyOpts) {
  return opts.aiCall || ((p: string, role = 'core') => defaultAiCall(userId, p, role));
}

// 预判新闻窗口：自上一交易日以来采集的新闻（节后=整段休市新闻；常日=隔夜新闻）。
function prejudgeNewsText(now: number): string {
  const since = lastTradingDayBefore(beijingDate(now)); // YYYY-MM-DD
  const items = newsTitlesSince(`${since} 00:00:00`);
  if (!items.length) return '（暂无自上一交易日以来的新闻）';
  return items.map((n) => `· ${n.title}`).join('\n');
}

// ---- prompt 构造 ----
function prejudgePrompt(persona: string, market: string, sectors: string, news: string, rb: string, hasRb: boolean): string {
  return `${persona}\n场景：盘前【策略预判】。基于以下信息，给出今天的操作预判（方向、关注板块、风险点；${hasRb ? '结合用户当前策略' : '无个人策略，仅给大盘/板块层面预判'}）。\n大盘：${market}\n板块：${sectors}\n自上一交易日以来的新闻：\n${news}\n${hasRb ? `用户当前策略：\n${rb}` : ''}\n请用中文给出简洁、可执行的预判：`;
}
function intradayPrompt(persona: string, market: string, sectors: string, rb: string, hasRb: boolean): string {
  return `${persona}\n场景：盘中【实时策略】。总结当前大盘走势与板块热度，并${hasRb ? '结合用户当前策略' : '在大盘/板块层面'}给出用户此刻可能的交易策略。\n大盘：${market}\n板块：${sectors}\n${hasRb ? `用户当前策略：\n${rb}` : ''}\n请用中文给出简洁的盘中小结（这一时点）：`;
}
function reviewPrompt(persona: string, market: string, prejudge: string, intraday: string, rb: string, hasRb: boolean): string {
  return `${persona}\n场景：盘后【复盘】。只复盘今天这个交易日：对照实际行情，复盘今早的「策略预判」与当天的「盘中策略」，总结对错、原因与改进。\n今日大盘：${market}\n今日预判：\n${prejudge || '（今日无预判）'}\n今日盘中时间线：\n${intraday || '（今日无盘中记录）'}\n${hasRb ? `用户当前策略：\n${rb}` : ''}\n请用中文给出复盘（哪些对/错、为什么、下次怎么调整）：`;
}
function holidayPrompt(persona: string, sectors: string, news: string): string {
  return `${persona}\n场景：【休市日快报】。今天休市，无操作。请仅做：① 近期消息面/新闻归纳；② 可能受影响的板块（说明逻辑）。\n板块：${sectors}\n近期新闻：\n${news}\n请用中文给出简洁的休市快报：`;
}

// ---- 生成器 ----
export async function generatePrejudge(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  await (opts.fetchNews ? opts.fetchNews() : refreshNews(userId).then(() => {}).catch(() => {}));
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const sec = await sectorText(userId);
  const rb = rulebookText(userId);
  const hasRb = !!getActive(userId);
  const news = prejudgeNewsText(now);
  const out = (await resolveAi(userId, opts)(prejudgePrompt(persona, mkt.text, sec.text, news, rb, hasRb), 'core')).trim();
  recordStrategy(userId, 'prejudge', out, { market: mkt.data, sectors: sec.sectors }, beijingDate(now));
  return out;
}

export async function generateIntraday(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const sec = await sectorText(userId);
  const rb = rulebookText(userId);
  const hasRb = !!getActive(userId);
  const out = (await resolveAi(userId, opts)(intradayPrompt(persona, mkt.text, sec.text, rb, hasRb), 'core')).trim();
  recordStrategy(userId, 'intraday', out, { market: mkt.data, sectors: sec.sectors }, beijingDate(now));
  return out;
}

export async function generateReview(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  const date = beijingDate(now);
  const persona = getCorePersona(userId);
  const mkt = marketText();
  const rb = rulebookText(userId);
  const hasRb = !!getActive(userId);
  const prejudge = getStrategy(userId, date, 'prejudge')?.content ?? '';
  const intraday = getIntradayTimeline(userId, date).map((r: any) => `· ${r.content}`).join('\n');
  const out = (await resolveAi(userId, opts)(reviewPrompt(persona, mkt.text, prejudge, intraday, rb, hasRb), 'core')).trim();
  recordStrategy(userId, 'review', out, { market: mkt.data }, date);
  return out;
}

export async function generateHoliday(userId: string, opts: GenStrategyOpts = {}): Promise<string> {
  const now = opts.now ?? Date.now();
  await (opts.fetchNews ? opts.fetchNews() : refreshNews(userId).then(() => {}).catch(() => {}));
  const persona = getCorePersona(userId);
  const sec = await sectorText(userId);
  const news = prejudgeNewsText(now); // 休市日同样取「自上一交易日以来」的新闻窗口
  const out = (await resolveAi(userId, opts)(holidayPrompt(persona, sec.text, news), 'core')).trim();
  recordStrategy(userId, 'holiday', out, { sectors: sec.sectors }, beijingDate(now));
  return out;
}
```
> 说明：每个生成器单次核心 AI 调用(role='core')，注入 `aiCall` 时测试不触网。`marketText`/`sectorText`/`rulebookText`/`defaultAiCall` 来自 meetings(Task 1 已导出)。`StrategyPhase` 仅类型，无运行期依赖；若 lint 报未用可去掉该 import。

- [ ] **Step 4: 运行确认通过** — `cd ~/projects/stock-agent/backend && npx jest strategy/generate -i`。Expected: PASS(全部)。

- [ ] **Step 5: 全量回归** — `cd ~/projects/stock-agent/backend && npm test`。Expected: 本批相关绿(既有 chat/meetings live-sidecar flaky 除外)。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/strategy/generate.ts backend/src/strategy/generate.test.ts
git commit -m "feat(strategy): 4 类生成器(预判/盘中/复盘/休市快报)+prompt;预判新闻窗口=自上一交易日以来(覆盖节后)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段② 验收

1. `cd ~/projects/stock-agent/backend && npx jest strategy -i` → service + generate 全绿。
2. `npm test` → 本批相关绿。
3. 生成器就位：4 类各自落对 phase；预判/复盘上下文注入正确（复盘含当天预判+盘中；预判含自上一交易日以来的新闻，天然覆盖节后）；`aiCall`/`now`/`fetchNews` 可注入。阶段③(调度器)将按各用户配置 + 交易日历定时调用这 4 个生成器。
