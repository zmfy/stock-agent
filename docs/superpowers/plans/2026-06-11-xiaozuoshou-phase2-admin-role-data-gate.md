# 小作手 1.0 · 阶段② C+D：admin 纯运维角色分流 + 数据触发收紧 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 admin 成为纯运维账号(登录后不显示任何交易功能、只见运维面板)，普通用户保持现有交易主页；并把所有数据「触发/写」类接口收紧为仅 admin，普通用户保留只读。

**Architecture:** C 在前端 `HomeView.vue` 按 `auth.isAdmin` 分流——给 `SETTINGS` 菜单项加 `roles` 字段按角色过滤；admin 隐藏聊天壳(顶栏「💬聊天」按钮 + 左栏会话列表 + 聊天区)，默认落在「数据管理」面板。D 在后端 `routes/data.ts` 给触发类路由加 `adminMiddleware`，读类保持开放；用后端 jest 做 403/200 鉴权测试(TDD)。

**Tech Stack:** Vue 3 (前端无单测运行器 → 靠 `vue-tsc --noEmit` + 逻辑走查验证) + Express/TS + jest (后端 282 测试现绿)。

参照 spec：`docs/superpowers/specs/2026-06-10-xiaozuoshou-1.0-design.md` C、D 两节。

**本阶段已确认的范围裁剪：**
- admin 菜单 = 数据管理 | 定时任务 | AI模型 | 能力插件 | 账号设置。
- 「数据告警」留到阶段③(E)再加入菜单。
- 「用户管理」本阶段**不做**(无现成页面/后端，后续单独 brainstorming→spec)。
- 路由守卫(redirect)按 spec 标注「可选」→ 本阶段只做菜单层隐藏 + admin 默认面板，不加 vue-router 守卫(YAGNI)。

---

## 文件结构

- Modify `backend/src/routes/data.ts` — 给 4 个触发路由加 `adminMiddleware`(D)
- Modify `backend/src/routes/data.test.ts` — 新增触发=403 / 读=200 鉴权测试(D)
- Modify `frontend/src/views/HomeView.vue` — `SETTINGS` 加 `roles` + `settingsMenu` 按角色过滤(C-1)；隐藏 admin 聊天壳 + 默认面板(C-2)

> 后端鉴权模型不改(`adminMiddleware` 已存在于 `../middleware/auth`)。前端不新增路由/视图。

---

## Task 1: D — 数据触发类接口仅 admin（TDD）

**Files:**
- Modify: `backend/src/routes/data.ts`
- Modify: `backend/src/routes/data.test.ts`

收紧的触发路由(加 `adminMiddleware`)：
- `POST /quotes/csv`(line 66) — CSV 导入行情(写)
- `POST /refresh`(line 83) — 刷新大盘/个股
- `POST /news/refresh`(line 100) — 采集热点新闻
- `POST /:job/run`(line 229) — stock_universe / eod 同步

保持**开放**(读 / 交易页要用)：`GET /snapshot/:code`、`GET /news`、`GET /news/log`、`GET /news/content/:id`、`GET /trade-calendar`、`GET /sources`、`GET /sources/catalog`、`GET /stocks/search`、`GET /tdx/server`、`GET /source`、`GET /probe*`、`GET /:job/status`。其余(sources 增删改、tdx 测速/设服、proxy*、`/:job/cancel|force-stop|log`)本就 admin，不动。

> 注：`POST /quotes/csv` 不在 spec D 的显式清单里，但属「数据写/触发」，按已确认「所有触发取数/刷新/同步仅 admin」一并收紧。

- [ ] **Step 1: 写失败测试**（追加到 `data.test.ts` 的 `describe('data routes', ...)` 内，紧跟现有 `非管理员访问 eod/cancel 和 eod/log 返回 403` 那条之后）

```ts
  it('数据触发类接口仅 admin：非 admin 403', async () => {
    const refresh = await request(app).post('/api/data/refresh').set(uh()).send({});
    expect(refresh.status).toBe(403);
    const news = await request(app).post('/api/data/news/refresh').set(uh());
    expect(news.status).toBe(403);
    const run = await request(app).post('/api/data/eod/run').set(uh());
    expect(run.status).toBe(403);
    const csv = await request(app)
      .post('/api/data/quotes/csv')
      .set(uh())
      .attach('file', Buffer.from('code,date,close\n600000,2026-05-28,10'), 'q.csv');
    expect(csv.status).toBe(403);
  });

  it('数据读类接口普通用户仍可用', async () => {
    expect((await request(app).get('/api/data/snapshot/600000').set(uh())).status).toBe(200);
    expect((await request(app).get('/api/data/news').set(uh())).status).toBe(200);
    expect((await request(app).get('/api/data/stocks/search?q=600').set(uh())).status).toBe(200);
    expect((await request(app).get('/api/data/trade-calendar').set(uh())).status).toBe(200);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ~/projects/stock-agent/backend && npx jest routes/data -i -t "数据触发类接口仅 admin"`
Expected: FAIL(当前这些触发接口允许普通用户 → 拿到 200/其它而非 403)。

- [ ] **Step 3: 加 adminMiddleware 到 4 个触发路由**

在 `backend/src/routes/data.ts`：

3a. `POST /quotes/csv`(line 66)：
```ts
router.post('/quotes/csv', adminMiddleware, upload.single('file'), (req: Request, res: Response) => {
```
(在 `upload.single('file')` 之前插入 `adminMiddleware,`)

3b. `POST /refresh`(line 83)：
```ts
router.post('/refresh', adminMiddleware, async (req: Request, res: Response) => {
```

3c. `POST /news/refresh`(line 100)：
```ts
router.post('/news/refresh', adminMiddleware, async (req: Request, res: Response) => {
```

3d. `POST /:job/run`(line 229)：
```ts
router.post('/:job/run', adminMiddleware, async (req, res) => {
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `cd ~/projects/stock-agent/backend && npx jest routes/data -i`
Expected: 全绿(含新 2 例；现有 `eod/run`、`quotes/csv` 成功路径用 `h()`(admin)不受影响)。

Run: `cd ~/projects/stock-agent/backend && npm test`
Expected: 全绿(原 282 + 新 2 = 284 左右)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(api): 数据触发类接口(refresh/news/quotes-csv/job-run)收紧为仅 admin

读类接口(snapshot/news/search/calendar/probe/...)保持普通用户可用。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: C-1 — SETTINGS 加 roles + 菜单按角色过滤

**Files:**
- Modify: `frontend/src/views/HomeView.vue`(line 304–315)

- [ ] **Step 1: 给 SETTINGS 每项加 roles，并把「数据」改标签为「数据管理」**

把(line 304–313)：
```ts
const SETTINGS = [
  { key: 'rulebook', label: '当前策略', icon: '📜', comp: RulebookView },
  { key: 'meetings', label: '早晚会历史', icon: '🗓', comp: MeetingsHistoryView },
  { key: 'analysis', label: '分析历史', icon: '📊', comp: AnalysisView },
  { key: 'data', label: '数据', icon: '📈', comp: DataView },
  { key: 'ai', label: 'AI 模型', icon: '🤖', comp: AiSettingsView },
  { key: 'plugins', label: '能力插件', icon: '🧩', comp: PluginsView },
  { key: 'crons', label: '定时任务', icon: '⏰', comp: CronsView, adminOnly: true },
  { key: 'account', label: '账号设置', icon: '👤', comp: SettingsView },
];
```
改为：
```ts
// roles: 'user' = 仅普通用户(交易功能)；'admin' = 仅 admin(运维)；'both' = 两者都有。
const SETTINGS = [
  { key: 'rulebook', label: '当前策略', icon: '📜', comp: RulebookView, roles: 'user' },
  { key: 'meetings', label: '早晚会历史', icon: '🗓', comp: MeetingsHistoryView, roles: 'user' },
  { key: 'analysis', label: '分析历史', icon: '📊', comp: AnalysisView, roles: 'user' },
  { key: 'data', label: '数据管理', icon: '📈', comp: DataView, roles: 'admin' },
  { key: 'ai', label: 'AI 模型', icon: '🤖', comp: AiSettingsView, roles: 'both' },
  { key: 'plugins', label: '能力插件', icon: '🧩', comp: PluginsView, roles: 'both' },
  { key: 'crons', label: '定时任务', icon: '⏰', comp: CronsView, roles: 'admin' },
  { key: 'account', label: '账号设置', icon: '👤', comp: SettingsView, roles: 'both' },
];
```

- [ ] **Step 2: 改 settingsMenu 过滤逻辑(line 315)**

把：
```ts
const settingsMenu = computed(() => SETTINGS.filter((s: any) => !s.adminOnly || auth.isAdmin));
```
改为：
```ts
const settingsMenu = computed(() =>
  SETTINGS.filter((s: any) => s.roles === 'both' || s.roles === (auth.isAdmin ? 'admin' : 'user')),
);
```

- [ ] **Step 3: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 4: 逻辑走查(无前端运行器，手工核对)**

确认：
- `auth.isAdmin === true` → `settingsMenu` = [data(数据管理), ai, plugins, crons, account]，**不含** rulebook/meetings/analysis。
- `auth.isAdmin === false` → `settingsMenu` = [rulebook(当前策略), meetings, analysis, ai, plugins, account]，**不含** data/crons。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(role): HomeView 菜单按角色(roles)分流 admin/user

admin=数据管理|定时任务|AI模型|能力插件|账号；user=当前策略|早晚会|分析|AI模型|能力插件|账号。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: C-2 — admin 隐藏聊天壳 + 默认落运维面板

**Files:**
- Modify: `frontend/src/views/HomeView.vue`(template line 9–24、33；script line 314、903–906)

- [ ] **Step 1: 左栏会话区对 admin 隐藏(template line 9–24)**

把这段(讨论记录标题 + 会话列表 + 清空对话按钮)：
```vue
      <!-- 会话列表 -->
      <div class="sect-head">讨论记录</div>
      <ul class="sessions">
        <li v-for="s in sessions" :key="s.id" :class="{ active: active?.id === s.id, 'is-pinned': s.pinned === 1 }"
            @click="open(s)" @mouseenter="startHover(s.id)" @mouseleave="endHover">
          <span class="kind">{{ kindIcon(s.kind) }}</span>
          <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
          <span v-if="generating.has(s.kind)" class="spinner sess-spin"></span>
          <button class="pin" :class="{ on: s.pinned === 1 }" :title="s.pinned === 1 ? '取消置顶' : '置顶'" @click.stop="togglePin(s)">📌</button>
          <button v-show="hoverDelId === s.id" class="del" title="删除会话（分析历史保留）" @click.stop="removeSession(s)">×</button>
        </li>
      </ul>

      <div class="menu">
        <button v-if="sessions.length" class="settings-entry clearall" @click="clearAllChats">🧹 清空所有对话</button>
      </div>
```
用一个 `<template v-if="!auth.isAdmin">` 包起来(admin 无聊天会话)：
```vue
      <!-- 会话列表（admin 纯运维账号不显示聊天） -->
      <template v-if="!auth.isAdmin">
        <div class="sect-head">讨论记录</div>
        <ul class="sessions">
          <li v-for="s in sessions" :key="s.id" :class="{ active: active?.id === s.id, 'is-pinned': s.pinned === 1 }"
              @click="open(s)" @mouseenter="startHover(s.id)" @mouseleave="endHover">
            <span class="kind">{{ kindIcon(s.kind) }}</span>
            <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
            <span v-if="generating.has(s.kind)" class="spinner sess-spin"></span>
            <button class="pin" :class="{ on: s.pinned === 1 }" :title="s.pinned === 1 ? '取消置顶' : '置顶'" @click.stop="togglePin(s)">📌</button>
            <button v-show="hoverDelId === s.id" class="del" title="删除会话（分析历史保留）" @click.stop="removeSession(s)">×</button>
          </li>
        </ul>
        <div class="menu">
          <button v-if="sessions.length" class="settings-entry clearall" @click="clearAllChats">🧹 清空所有对话</button>
        </div>
      </template>
```
(其后的 `<p class="risk-note">…</p>` 保持不变，对所有人显示。)

- [ ] **Step 2: 顶栏「💬聊天」按钮对 admin 隐藏(template line 33)**

把：
```vue
          <button class="tnav" :class="{ active: !settingsKey }" @click="goChat">💬 聊天</button>
```
改为：
```vue
          <button v-if="!auth.isAdmin" class="tnav" :class="{ active: !settingsKey }" @click="goChat">💬 聊天</button>
```

- [ ] **Step 3: settingsKey 初值——admin 默认进运维面板(script line 314)**

把：
```ts
const settingsKey = ref(''); // '' = 聊天；否则为某个功能面板
```
改为：
```ts
// '' = 聊天；否则为某个功能面板。admin 无聊天 → 默认落「数据管理」(若 user 已同步加载)。
const settingsKey = ref(auth.isAdmin ? 'data' : '');
```

- [ ] **Step 4: onMounted——admin 兜底设默认面板并跳过聊天加载(script line 903–906)**

把：
```ts
onMounted(async () => {
  if (!auth.user) await auth.fetchMe().catch(() => {});
  await loadSessions();
  await loadMeetings();
```
改为：
```ts
onMounted(async () => {
  if (!auth.user) await auth.fetchMe().catch(() => {});
  // admin 是纯运维账号：不加载聊天/早晚会/当前策略，默认停在运维面板。
  if (auth.isAdmin) {
    if (!settingsKey.value) settingsKey.value = 'data';
    return;
  }
  await loadSessions();
  await loadMeetings();
```
(其余 onMounted 主体不变——`screen`/`rulebook`/`interview` 这些仅普通用户路径。)

- [ ] **Step 5: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 6: 逻辑走查(手工核对)**

确认对 admin：
- 左栏无「讨论记录/会话列表/清空对话」，仅品牌 + 版本 + 风险提示。
- 顶栏无「💬聊天」按钮；标签只剩 admin 菜单项(数据管理/定时任务/AI模型/能力插件/账号)。
- `settingsKey` 初值即 `'data'`(user 持久化时)或 onMounted 兜底为 `'data'` → `<section v-if="settingsKey">` 恒为真 → 聊天区 `<section v-else>` 永不渲染、无闪烁。
- admin onMounted 提前 return → 不调用 `loadSessions/loadMeetings/screenApi/rulebookApi`，无多余请求/报错。
对普通用户：行为与改前一致(聊天壳、会话列表、菜单都在)。

- [ ] **Step 7: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(role): admin 纯运维主页——隐藏聊天壳/会话列表，默认落数据管理面板

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收(全部 Task 完成后)

1. `cd ~/projects/stock-agent/backend && npm test` → 全绿(原 282 + 新 2)。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(可选)：`docker compose up -d --build` 后——
   - **admin** 登录：主页无聊天，左栏只有品牌/版本/风险提示，顶栏菜单=数据管理|定时任务|AI模型|能力插件|账号；进「数据管理」点刷新/采集/同步仍可用(admin 200)。
   - **普通用户** 登录：聊天主页照旧，菜单=当前策略|早晚会|分析|AI模型|能力插件|账号；无数据管理/定时任务入口；直接 `POST /api/data/refresh` 返回 403，但个股分析(读类 snapshot/search)正常。
