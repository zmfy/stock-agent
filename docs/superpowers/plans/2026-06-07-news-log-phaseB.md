# Phase B：新闻双日志 + 来财结构化采用 + 讨论结果展示

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子 agent 采集的新闻写入"标题日志/内容日志"双表；来财在早晚会综合时结构化声明采用了哪几条新闻；页面展示来财讨论结果 + 采用新闻(标题可点开内容)；按采用与否差异化保留日志。

**Architecture:** 新增 `news_title_log`(标题事件，>1年清理) + `news_content_log`(完整内容+采用标记，采用>3月/未采用>1周清理)；`data/news-log.ts` 统一收集/读取/标记采用/清理；sidecar `/news` 返回完整 content；early/evening 生成时数据员采集→写双表+给新闻打稳定 id，来财综合输出 `__ADOPT__ N1,N3` 解析后标记采用；路由提供标题日志列表 + 单条内容；前端 DataView 数据采集区改为采集日志，早晚会展示采用新闻。

**Tech Stack:** Node/Express+TS（jest，tmp DATA_DIR+require）；Python sidecar（无 pytest，一次性验证）；Vue3（vue-tsc + 冒烟）。本地 dev 容器 `stock-agent-app-1`/`stock-agent-akshare-mcp-1`。

**统一约定：**
- `news_content_log`：唯一性按 `(title, published_at)`（同一条新闻只一行内容）；`news_title_log`：每次采集追加一行事件，引用 `content_id`。
- news-log API：`recordCollected(items): Array<{content_id,title}>`、`listTitleLog(limit)`、`getContent(contentId)`、`markAdopted(contentIds[])`、`purgeOldLogs()`。
- 来财采用标记：synth 输出末行 `__ADOPT__ N1,N3`（仿 Phase1 `__SRC__`），解析后从 idMap 映回 content_id。

---

## Task 1: DB — news_title_log + news_content_log

**Files:** Modify `backend/src/db.ts`；Test `backend/src/db.test.ts`

- [ ] **Step 1: 失败测试**
```ts
it('news_title_log / news_content_log 表存在且列齐全', () => {
  const db = require('./db').getDb();
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('news_title_log','news_content_log')").all().map((r: any) => r.name);
  expect(t).toEqual(expect.arrayContaining(['news_title_log', 'news_content_log']));
  const cc = db.prepare('PRAGMA table_info(news_content_log)').all().map((c: any) => c.name);
  expect(cc).toEqual(expect.arrayContaining(['id', 'title', 'content', 'source', 'published_at', 'collected_at', 'adopted', 'adopted_at']));
});
```
- [ ] **Step 2: 跑 → FAIL**

Run: `cd backend && npx jest src/db.test.ts -t "news_title_log" -i` → FAIL。

- [ ] **Step 3: 实现** — 在 db.ts 建表区加（与其它 CREATE TABLE 一起），并在 `migrate()` 末尾用同样的 `CREATE TABLE IF NOT EXISTS` 兜底（幂等）：
```sql
CREATE TABLE IF NOT EXISTS news_content_log (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  source TEXT,
  published_at TEXT,
  collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  adopted INTEGER DEFAULT 0,
  adopted_at DATETIME,
  UNIQUE(title, published_at)
);
CREATE TABLE IF NOT EXISTS news_title_log (
  id TEXT PRIMARY KEY,
  content_id TEXT,
  title TEXT NOT NULL,
  source TEXT,
  published_at TEXT,
  collected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_news_title_collected ON news_title_log (collected_at);
CREATE INDEX IF NOT EXISTS idx_news_content_adopted ON news_content_log (adopted, collected_at);
```
- [ ] **Step 4: 跑 → PASS + 全套** — `cd backend && npx jest src/db.test.ts -i && npx jest`
- [ ] **Step 5: Commit**
```bash
git add backend/src/db.ts backend/src/db.test.ts
git commit -m "feat(db): news_title_log + news_content_log 双日志表"
```

---

## Task 2: data/news-log.ts 服务（TDD）

**Files:** Create `backend/src/data/news-log.ts`；Test `backend/src/data/news-log.test.ts`

- [ ] **Step 1: 失败测试**
```ts
import path from 'path'; import os from 'os'; import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-newslog-'));
const nl = require('./news-log');

it('recordCollected 写内容(去重)+标题事件(追加)；listTitleLog/getContent', () => {
  const a = nl.recordCollected([{ title: 'A股大涨', content: '正文AAA', source: 'em', published_at: '2026-06-07 09:00' }]);
  expect(a).toHaveLength(1);
  const id = a[0].content_id;
  // 再采集同一条：内容不新增、标题事件 +1
  nl.recordCollected([{ title: 'A股大涨', content: '正文AAA', source: 'em', published_at: '2026-06-07 09:00' }]);
  const db = require('../db').getDb();
  expect((db.prepare('SELECT COUNT(*) c FROM news_content_log').get() as any).c).toBe(1);
  expect((db.prepare('SELECT COUNT(*) c FROM news_title_log').get() as any).c).toBe(2);
  expect(nl.getContent(id).content).toBe('正文AAA');
  const log = nl.listTitleLog(10);
  expect(log[0].title).toBe('A股大涨');
  expect(log[0].adopted).toBe(0);
});

it('markAdopted 标记采用', () => {
  const [{ content_id }] = nl.recordCollected([{ title: '龙头表现', content: 'x', source: 'em', published_at: '2026-06-07 10:00' }]);
  nl.markAdopted([content_id]);
  expect(nl.getContent(content_id).adopted).toBe(1);
});

it('purgeOldLogs 按规则清理', () => {
  const db = require('../db').getDb();
  // 旧标题事件(>1年)
  db.prepare("INSERT INTO news_title_log (id,content_id,title,collected_at) VALUES ('old1',null,'旧标题', datetime('now','-400 days'))").run();
  // 未采用>1周 / 采用>3月
  db.prepare("INSERT INTO news_content_log (id,title,content,adopted,collected_at) VALUES ('c_old_un','未采用','x',0, datetime('now','-10 days'))").run();
  db.prepare("INSERT INTO news_content_log (id,title,content,adopted,collected_at) VALUES ('c_old_ad','采用过','x',1, datetime('now','-100 days'))").run();
  db.prepare("INSERT INTO news_content_log (id,title,content,adopted,collected_at) VALUES ('c_fresh','新鲜','x',0, datetime('now','-2 days'))").run();
  nl.purgeOldLogs();
  expect(db.prepare("SELECT 1 FROM news_title_log WHERE id='old1'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM news_content_log WHERE id='c_old_un'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM news_content_log WHERE id='c_old_ad'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM news_content_log WHERE id='c_fresh'").get()).toBeTruthy();
});
```
- [ ] **Step 2: 跑 → FAIL**

Run: `cd backend && npx jest src/data/news-log.test.ts -i` → FAIL。

- [ ] **Step 3: 实现** `backend/src/data/news-log.ts`:
```ts
import { getDb } from '../db';
import { v4 as uuidv4 } from 'uuid';

export interface CollectItem { title: string; content?: string; source?: string; published_at?: string }

export function recordCollected(items: CollectItem[]): Array<{ content_id: string; title: string }> {
  const db = getDb();
  const out: Array<{ content_id: string; title: string }> = [];
  const findC = db.prepare('SELECT id FROM news_content_log WHERE title = ? AND IFNULL(published_at,\'\') = IFNULL(?,\'\')');
  const insC = db.prepare('INSERT INTO news_content_log (id, title, content, source, published_at) VALUES (?, ?, ?, ?, ?)');
  const updC = db.prepare('UPDATE news_content_log SET content = COALESCE(?, content), source = COALESCE(?, source) WHERE id = ?');
  const insT = db.prepare('INSERT INTO news_title_log (id, content_id, title, source, published_at) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction((rows: CollectItem[]) => {
    for (const n of rows) {
      if (!n.title) continue;
      const existing = findC.get(n.title, n.published_at ?? '') as { id: string } | undefined;
      let cid: string;
      if (existing) { cid = existing.id; updC.run(n.content ?? null, n.source ?? null, cid); }
      else { cid = uuidv4(); insC.run(cid, n.title, n.content ?? null, n.source ?? null, n.published_at ?? null); }
      insT.run(uuidv4(), cid, n.title, n.source ?? null, n.published_at ?? null);
      out.push({ content_id: cid, title: n.title });
    }
  });
  tx(items);
  return out;
}

export function listTitleLog(limit = 30): Array<{ id: string; content_id: string; title: string; source: string; collected_at: string; adopted: number }> {
  return getDb().prepare(
    `SELECT t.id, t.content_id, t.title, t.source, t.collected_at, COALESCE(c.adopted, 0) AS adopted
     FROM news_title_log t LEFT JOIN news_content_log c ON c.id = t.content_id
     ORDER BY t.collected_at DESC, t.rowid DESC LIMIT ?`
  ).all(limit) as any[];
}

export function getContent(contentId: string): { id: string; title: string; content: string; source: string; published_at: string; collected_at: string; adopted: number } | null {
  return (getDb().prepare('SELECT * FROM news_content_log WHERE id = ?').get(contentId) as any) ?? null;
}

export function markAdopted(contentIds: string[]): void {
  if (!contentIds.length) return;
  const db = getDb();
  const stmt = db.prepare("UPDATE news_content_log SET adopted = 1, adopted_at = CURRENT_TIMESTAMP WHERE id = ?");
  const tx = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(id); });
  tx(contentIds);
}

export function purgeOldLogs(): void {
  const db = getDb();
  db.prepare("DELETE FROM news_title_log WHERE collected_at < datetime('now','-1 year')").run();
  db.prepare("DELETE FROM news_content_log WHERE adopted = 1 AND collected_at < datetime('now','-3 months')").run();
  db.prepare("DELETE FROM news_content_log WHERE adopted = 0 AND collected_at < datetime('now','-7 days')").run();
}
```
- [ ] **Step 4: 跑 → PASS + 全套** — `cd backend && npx jest src/data/news-log.test.ts -i && npx jest && npx tsc --noEmit`
- [ ] **Step 5: Commit**
```bash
git add backend/src/data/news-log.ts backend/src/data/news-log.test.ts
git commit -m "feat(data): news-log 服务（收集/读取/采用标记/清理）"
```

---

## Task 3: sidecar 完整 content + refreshNews 写双日志（TDD）

**Files:** Modify `sidecar/main.py`、`backend/src/data/sidecar.ts`、`backend/src/data/service.ts`；Test `backend/src/data/sidecar.test.ts`

- [ ] **Step 1: sidecar /news 返回完整 content**

`sidecar/main.py` `_news_provider`：保留 `summary`(短)，新增 `content`(完整不截断)：
```python
            if title:
                rows.append({"title": str(title), "summary": str(summary)[:200], "content": str(summary), "published_at": str(ts)})
```
重建验证：
```bash
docker compose up -d --build akshare-mcp
docker exec stock-agent-akshare-mcp-1 python -c "import urllib.request,json; d=json.load(urllib.request.urlopen('http://localhost:8000/news?limit=2')); print(list(d['rows'][0].keys()) if d['rows'] else d)"
```
Expected: rows 元素含 `content` 键。

- [ ] **Step 2: 失败测试（Node fetchNews 带 content + refreshNews 写双日志）**

`backend/src/data/sidecar.test.ts`:
```ts
it('fetchNews 解析 content', async () => {
  (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ source: 'em', rows: [{ title: 't', summary: 's', content: '完整正文', published_at: 'p' }] }) }));
  const r = await require('./sidecar').fetchNews('http://x', 2);
  expect(r.rows[0].content).toBe('完整正文');
});
```
`backend/src/data/service.test.ts`:
```ts
it('refreshNews 写入 news 双日志', async () => {
  const svc = require('./service');
  require('./sources-service').ensureSeedGlobal?.();
  (global as any).fetch = jest.fn((u: string) =>
    u.includes('/news') ? Promise.resolve({ ok: true, json: async () => ({ source: 'em', rows: [{ title: '热点X', summary: 's', content: '正文X', published_at: '2026-06-07' }] }) })
    : Promise.resolve({ ok: true, json: async () => ([]) }));
  await svc.refreshNews('u1', 5);
  const db = require('../db').getDb();
  expect((db.prepare("SELECT content FROM news_content_log WHERE title='热点X'").get() as any).content).toBe('正文X');
});
```
- [ ] **Step 3: 跑 → FAIL**

Run: `cd backend && npx jest src/data -t "fetchNews 解析 content|写入 news 双日志" -i` → FAIL。

- [ ] **Step 4: 实现**
- `sidecar.ts fetchNews`：在 rows 映射里加 `content: String(n.content ?? n.summary ?? '')`（返回类型的 row 增 `content`）。
- `service.ts refreshNews`：取到 rows 后，调用 `recordCollected(rows.map((n) => ({ title: n.title, content: n.content, source: srcVal, published_at: n.published_at })))`（import from `./news-log`）。保留/可移除旧 `news` 表写入——本计划改为**只写双日志**（旧 `news` 表与 `listNews` 留作兼容、不再写）。返回收集条数。
- [ ] **Step 5: 跑 → PASS + 全套 + tsc** — `cd backend && npx jest -i && npx tsc --noEmit`
- [ ] **Step 6: Commit**
```bash
git add sidecar/main.py backend/src/data/sidecar.ts backend/src/data/service.ts backend/src/data/*.test.ts
git commit -m "feat(data): sidecar 新闻返回完整 content；refreshNews 写双日志"
```

---

## Task 4: 早晚会数据员采集 + 来财结构化采用（TDD）

**Files:** Modify `backend/src/meetings/service.ts`；Test `backend/src/meetings/service.test.ts`

- [ ] **Step 1: 失败测试**
```ts
it('generateMorning 采集新闻入双日志，来财 __ADOPT__ 标记采用并存 adopted_news', async () => {
  const m = require('./service');
  const nl = require('../data/news-log');
  require('../data/sources-service').ensureSeedGlobal?.();
  // 预置已采集的两条新闻（带 content_id）
  const recs = nl.recordCollected([{ title: '新能源爆发', content: 'c1', source: 'em', published_at: 'p1' }, { title: '银行走弱', content: 'c2', source: 'em', published_at: 'p2' }]);
  // 注入 aiCall：core 角色输出带 __ADOPT__ N1
  const aiCall = async (_p: string, role: string) => role === 'core' ? '今日新能源板块占优。\n__ADOPT__ N1' : `[${role}]`;
  const r = await m.generateMorning('u1', { aiCall, fetchNews: async () => {} });   // fetchNews 注入空，沿用已预置
  const data = JSON.parse(r.data);
  expect(data.adopted_news.map((x: any) => x.title)).toContain('新能源爆发');
  expect(nl.getContent(recs[0].content_id).adopted).toBe(1);
  expect(r.content).not.toContain('__ADOPT__');     // 展示文本里剥掉标记
});
```
（注：`generateMorning` 增加可注入 `fetchNews?` 以便测试跳过真实采集；非测试时默认 `refreshNews(userId)`。idMap：新闻按 listTitleLog/最近 content-log 顺序映射 N1..Nn。）

- [ ] **Step 2: 跑 → FAIL**

Run: `cd backend && npx jest src/meetings/service.test.ts -t "__ADOPT__" -i` → FAIL。

- [ ] **Step 3: 实现** 在 `meetings/service.ts`：
- `GenOpts` 增可选 `fetchNews?: () => Promise<void>`。
- `newsText()` 改为基于"带 id 的最近新闻"：新增 helper
```ts
function buildNewsWithIds(userId: string): { text: string; idMap: Record<string, string> } {
  const rows = getDb().prepare('SELECT id, title FROM news_content_log ORDER BY collected_at DESC LIMIT 8').all() as Array<{ id: string; title: string }>;
  const idMap: Record<string, string> = {};
  const lines = rows.map((r, i) => { const tag = `N${i + 1}`; idMap[tag] = r.id; return `[${tag}] ${r.title}`; });
  return { text: lines.length ? '近期财经要闻：\n' + lines.join('\n') : '（暂无近期财经新闻）', idMap };
}
```
- `generateMorning`：开头 `await (opts.fetchNews ? opts.fetchNews() : refreshNews(userId).then(() => {}).catch(() => {}))`（采集→写双日志）。然后 `const { text: news, idMap } = buildNewsWithIds(userId)`，把 `news` 传给 data/qual/synth prompts（替换原 `newsText()`）。
- synth prompt（`buildMorningSynthPrompt`）末尾追加指令："若引用了上面某几条新闻作为依据，请在最后另起一行输出：`__ADOPT__ 逗号分隔的编号`（如 `__ADOPT__ N1,N3`），没有就不输出该行。"
- 拿到 `coreOut` 后：解析 `/__ADOPT__\s+([N\d,\s]+)/`，得到 tags → `adoptedIds = tags.map(t=>idMap[t]).filter(Boolean)`；`markAdopted(adoptedIds)`；`adopted_news = adoptedIds.map(id => ({ content_id: id, title: getContent(id)?.title }))`；把 coreOut 里的 `__ADOPT__ ...` 行删除后再拼入 content。
- `upsert(... , { ...原有, discussion, adopted_news })`。
- `generateEvening` 同理（晚会 synth 也支持 `__ADOPT__`）。
- import `recordCollected, listTitleLog, getContent, markAdopted` from `../data/news-log`，`refreshNews` from `../data/service`，`getDb` 已有。
- [ ] **Step 4: 跑 → PASS + 全套** — `cd backend && npx jest -i && npx tsc --noEmit`
- [ ] **Step 5: Commit**
```bash
git add backend/src/meetings/service.ts backend/src/meetings/service.test.ts
git commit -m "feat(meetings): 数据员采集入双日志 + 来财 __ADOPT__ 结构化采用并留痕"
```

---

## Task 5: 路由 — 采集日志列表 + 单条内容（TDD）

**Files:** Modify `backend/src/routes/data.ts`；Test `backend/src/routes/data.test.ts`

- [ ] **Step 1: 失败测试**
```ts
it('GET /api/data/news/log 返回采集日志；/news/content/:id 返回内容', async () => {
  const nl = require('../data/news-log');
  const [{ content_id }] = nl.recordCollected([{ title: '日志测试', content: '内容Z', source: 'em', published_at: 'p' }]);
  const log = await request(app).get('/api/data/news/log').set('Authorization', `Bearer ${token}`);
  expect(log.status).toBe(200);
  expect(log.body.data.some((x: any) => x.title === '日志测试')).toBe(true);
  const c = await request(app).get(`/api/data/news/content/${content_id}`).set('Authorization', `Bearer ${token}`);
  expect(c.body.data.content).toBe('内容Z');
});
```
- [ ] **Step 2: 跑 → FAIL**

Run: `cd backend && npx jest src/routes/data.test.ts -t "news/log" -i` → FAIL。

- [ ] **Step 3: 实现** 在 `routes/data.ts`（import `listTitleLog, getContent` from `../data/news-log`）：
```ts
router.get('/news/log', (req, res) => { successResponse(res, listTitleLog(Number(req.query.limit) || 50)); });
router.get('/news/content/:id', (req, res) => { const c = getContent(req.params.id); if (!c) return errorResponse(res, 404, 'NOT_FOUND', '内容已清理或不存在'); successResponse(res, c); });
```
（放在 `/news`、`/news/refresh` 附近；注意 `/news/content/:id` 与 `/news/log` 都是两段路径，不与 `/news` 冲突。）
- [ ] **Step 4: 跑 → PASS + 全套** — `cd backend && npx jest -i`
- [ ] **Step 5: Commit**
```bash
git add backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(api): GET /news/log 采集日志 + /news/content/:id 单条内容"
```

---

## Task 6: 保留清理接入 cron（TDD 已在 Task2，cron 仅接线）

**Files:** Modify `backend/src/cron/nightly.ts`

- [ ] **Step 1: 接线** 在 `runNightly()` 末尾加（import `purgeOldLogs` from `../data/news-log`）：
```ts
  try { purgeOldLogs(); } catch { /* ignore */ }
```
（`purgeOldLogs` 已在 Task 2 单测覆盖；此处只是每晚 23:00 调用。）
- [ ] **Step 2: 验证** — `cd backend && npx jest -i && npx tsc --noEmit` → 全绿、干净。
- [ ] **Step 3: Commit**
```bash
git add backend/src/cron/nightly.ts
git commit -m "feat(cron): 夜间清理新闻双日志（标题>1年 / 内容采用>3月·未采用>1周）"
```

---

## Task 7: 前端 — 采集日志区 + 早晚会采用新闻展示

**Files:** Modify `frontend/src/api/data.ts`、`frontend/src/views/DataView.vue`、`frontend/src/views/HomeView.vue`

- [ ] **Step 1: api**
`frontend/src/api/data.ts` 加：
```ts
newsLog: (limit = 50) => api.get('/data/news/log?limit=' + limit).then((r) => r.data.data as Array<{ id: string; content_id: string; title: string; source: string; collected_at: string; adopted: number }>),
newsContent: (id: string) => api.get('/data/news/content/' + id).then((r) => r.data.data as { title: string; content: string; source: string; collected_at: string; adopted: number }),
```

- [ ] **Step 2: DataView「数据采集」区改造**
把原「采集热点新闻 + 新闻列表(listNews)」改为：保留「立即采集」按钮(调 `collectNews` → refresh)，列表改用 `dataApi.newsLog()` 渲染：每行 `标题 · 时间 · {{ adopted? '已采用':'' }}`，点标题 → `dataApi.newsContent(content_id)` 弹出/展开内容（用一个 `openContent` ref 存当前展开的 {title,content}）。`<script setup>`：
```ts
const newsLog = ref<any[]>([]);
const openNews = ref<{ title: string; content: string } | null>(null);
async function loadNewsLog() { newsLog.value = await dataApi.newsLog(50); }
async function collectNews() { busy.value = true; try { await dataApi.refreshNews(); await loadNewsLog(); } finally { busy.value = false; } }
async function showNewsContent(id: string) { openNews.value = await dataApi.newsContent(id); }
onMounted(loadNewsLog);
```
（`dataApi.refreshNews` 已存在；若原 collectNews 调的是别的方法，对齐即可。）

- [ ] **Step 3: 早晚会展示采用新闻**
`HomeView.vue` morning/evening 会话视图：在 briefing 下方，若该 meeting 的 `data.adopted_news` 非空，渲染「来财采用的新闻」列表(标题可点)。meetings/today 接口已返回 meeting（含 `data` JSON 字符串）；前端解析 `JSON.parse(meeting.data).adopted_news`，每条标题点 → 调 `dataApi.newsContent(content_id)` 展示。加一个 `adoptedNews` computed（从当前 morning/evening meeting 的 data 解析）+ 一个内容弹层。

- [ ] **Step 4: 验证** — `cd frontend && npx vue-tsc --noEmit` → 0 errors。冒烟：数据采集区显示采集日志(标题/时间/采用徽标)、点标题看内容；早/晚会显示来财采用的新闻、可点开。
- [ ] **Step 5: Commit**
```bash
git add frontend/src/api/data.ts frontend/src/views/DataView.vue frontend/src/views/HomeView.vue
git commit -m "feat(ui): 数据采集区改采集日志(标题/采用/点开内容) + 早晚会展示来财采用新闻"
```

---

## Task 8: 端到端验证

- [ ] **Step 1: 重建 + 全套** — `docker compose up -d --build`；`cd backend && npx jest`；`cd frontend && npx vue-tsc --noEmit`
- [ ] **Step 2: 冒烟** — 数据采集「立即采集」→ news/log 出现条目；real AI 生成早会 → 来财结论带依据，meeting.data.adopted_news 有值、对应 content_log.adopted=1；点采用新闻标题能看到内容。

---

## Self-Review
- **Spec(Phase B) 覆盖**：双表(Task1)、news-log 服务含清理(Task2)、sidecar 完整 content + refreshNews 写双日志(Task3)、数据员采集+来财 __ADOPT__ 采用留痕(Task4)、路由 log/content(Task5)、夜间清理接线(Task6)、前端采集日志区+早晚会采用新闻(Task7)、e2e(Task8) —— 均有任务。
- **Placeholder**：无；每步含真实代码/命令。
- **类型一致**：`recordCollected→[{content_id,title}]`、`listTitleLog→{id,content_id,title,source,collected_at,adopted}`、`getContent→{...content...}`、`markAdopted(string[])`、`purgeOldLogs()`、meetings `data.adopted_news=[{content_id,title}]`、`__ADOPT__ N1,N3` + idMap，贯穿后端与前端一致。
- **注意**：旧 `news` 表 + `listNews` 改为不再写（保留定义兼容）；meetings/DataView 改用双日志；newsText 被 buildNewsWithIds 取代。
