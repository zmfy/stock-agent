# 账号昵称编辑 + A股日历移入状态条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 账号设置显示用户名(只读)+可编辑昵称(新后端端点);② A 股日历从顶栏移入状态条最右端,抽成独立小图标弹层组件。

**Architecture:** 后端新 `PUT /api/account/profile {nickname}` + `account/service.updateNickname`。前端:`SettingsView` 加账号信息区(保存后 `auth.fetchMe()` 刷新);新 `CalendarPopover.vue`(从 HomeView 原样迁出日历状态/函数/模板/样式)放进 `MarketStatusBar` 最右端;HomeView 顶栏删日历。

**Tech Stack:** Express/TS + jest + Vue 3。

参照 spec：`docs/superpowers/specs/2026-06-13-profile-nickname-and-calendar-relocate-design.md`。

---

## Task 1: 后端 昵称编辑（TDD）

**Files:** Modify `backend/src/account/service.ts`、`backend/src/routes/account.ts`；Create `backend/src/routes/account.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/routes/account.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-account-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let userTok = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456', agreed: true });
  const tok = login.body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${tok}`);
  const reg = await request(app).post('/api/auth/register').send({ username: 'plainu', password: 'secret123', inviteCode: inv.body.data.code, agreed: true });
  userTok = reg.body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('account profile (nickname)', () => {
  it('PUT /api/account/profile 改昵称并读回；用户名不变', async () => {
    const r = await request(app).put('/api/account/profile').set(h(userTok)).send({ nickname: '小明' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ username: 'plainu', nickname: '小明' });
    const me = await request(app).get('/api/auth/me').set(h(userTok));
    expect(me.body.data.nickname).toBe('小明');
    expect(me.body.data.username).toBe('plainu'); // 用户名不可改
  });
  it('空昵称 → 清除(回落用户名由前端处理)', async () => {
    const r = await request(app).put('/api/account/profile').set(h(userTok)).send({ nickname: '' });
    expect(r.status).toBe(200);
    expect(r.body.data.nickname).toBe('');
  });
  it('超长昵称(>30) → 422', async () => {
    const r = await request(app).put('/api/account/profile').set(h(userTok)).send({ nickname: 'x'.repeat(31) });
    expect(r.status).toBe(422);
  });
  it('未登录 401', async () => {
    expect((await request(app).put('/api/account/profile').send({ nickname: 'a' })).status).toBe(401);
  });
});
```
> 确认 `/api/auth/me` 路径与返回(`me.body.data` 含 username/nickname/role)——它就是 `auth.fetchMe()` 调的端点。若路径不同(如 `/api/auth/profile`),改测试与下文一致。

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest routes/account -i`。Expected: FAIL（404）。

- [ ] **Step 3: 实现 service**（`backend/src/account/service.ts`，确认其已 `import { getDb } from '../db'`；若无则加）

```ts
export function updateNickname(userId: string, nickname: string): { id: string; username: string; role: string; nickname: string | null } {
  getDb().prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, userId);
  return getDb().prepare('SELECT id, username, role, nickname FROM users WHERE id = ?').get(userId) as any;
}
```

- [ ] **Step 4: 实现路由**（`backend/src/routes/account.ts`，加在其它路由旁）

```ts
// PUT /api/account/profile { nickname } — 改当前用户昵称(用户名不可改)
router.put('/profile', (req: Request, res: Response) => {
  const parsed = z.object({ nickname: z.string() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const nickname = parsed.data.nickname.trim();
  if (nickname.length > 30) return errorResponse(res, 422, 'VALIDATION_ERROR', '昵称不能超过 30 字');
  const user = svc.updateNickname(req.user!.userId, nickname);
  successResponse(res, user, '已保存');
});
```
(`z`/`errorResponse`/`successResponse`/`svc` 已在 account.ts import。)

- [ ] **Step 5: 运行确认通过 + 回归** — `cd ~/projects/stock-agent/backend && npx jest routes/account -i` 然后 `npm test`。Expected: 全绿(注:既有 chat/meetings/strategy-generate flaky 除外)。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/account/service.ts backend/src/routes/account.ts backend/src/routes/account.test.ts
git commit -m "feat(account): PUT /api/account/profile 改昵称(用户名不可改,≤30,允许清空)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 前端 账号信息区（昵称编辑）

**Files:** Modify `frontend/src/api/account.ts`、`frontend/src/views/SettingsView.vue`

- [ ] **Step 1: api 加 updateProfile**（`frontend/src/api/account.ts` 的 `accountApi` 内）

```ts
  updateProfile: (nickname: string) => api.put<{ data: { id: string; username: string; role: string; nickname: string | null } }>('/account/profile', { nickname }),
```

- [ ] **Step 2: SettingsView 顶部加「账号信息」区**

2a. `<script setup>`：确认/补 `import { useAuthStore } from '../stores/auth';` 与 `const auth = useAuthStore();`(若已存在则复用)。加：
```ts
import { ref } from 'vue'; // 若已 import 则合并
const nickname = ref(auth.user?.nickname || '');
const savingProfile = ref(false);
const profileMsg = ref('');
async function saveProfile() {
  savingProfile.value = true; profileMsg.value = '';
  try {
    await accountApi.updateProfile(nickname.value.trim());
    await auth.fetchMe();
    profileMsg.value = '已保存';
  } catch (e: any) {
    profileMsg.value = e.response?.data?.message || '保存失败';
  } finally {
    savingProfile.value = false;
  }
}
```
(`accountApi` 已 import。`useAuthStore` 若 SettingsView 未用过则需新增 import。)

2b. 模板最顶部(第一个 `<section>`/内容之前)加：
```vue
    <section class="card acct-info">
      <h2>账号信息</h2>
      <div class="row"><label>用户名</label><span class="ro">{{ auth.user?.username }}</span></div>
      <div class="row"><label>昵称</label>
        <input v-model="nickname" maxlength="30" placeholder="给自己起个昵称(可留空)" />
        <button class="mini" :disabled="savingProfile" @click="saveProfile">{{ savingProfile ? '保存中…' : '保存' }}</button>
        <span v-if="profileMsg" class="muted">{{ profileMsg }}</span>
      </div>
    </section>
```
> 先 Read SettingsView 顶部确认插入点(在模板根容器内、最上)。class 复用现有(`card`/`mini`/`muted`);若无 `.card`/`.row` 样式则在 `<style>` 末尾补：
```css
.acct-info .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
.acct-info label { width: 56px; color: var(--muted, #888); }
.acct-info .ro { color: var(--text, #333); }
.acct-info input { width: 220px; }
```

- [ ] **Step 3: 类型检查 + 走查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。
走查:账号信息区在 SettingsView 顶部;用户名只读;改昵称保存→「已保存」+右上角按钮昵称即时更新(auth.fetchMe)。

- [ ] **Step 4: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/account.ts frontend/src/views/SettingsView.vue
git commit -m "feat(account-ui): 账号信息区——用户名只读 + 昵称可编辑保存(存后刷新 auth)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: A股日历移入状态条

**Files:** Create `frontend/src/views/CalendarPopover.vue`；Modify `frontend/src/views/MarketStatusBar.vue`、`frontend/src/views/HomeView.vue`

- [ ] **Step 1: 创建 `frontend/src/views/CalendarPopover.vue`**（从 HomeView 原样迁出日历）

```vue
<template>
  <div class="cal-wrap">
    <button class="mini cal-btn" title="A股日历" @click="toggleCalendar">📅</button>
    <div v-if="calOpen" class="cal-pop">
      <div class="cal-nav">
        <button class="mini" @click="prevMonth">‹</button>
        <span>{{ calYear }} 年 {{ calMonth }} 月</span>
        <button class="mini" @click="nextMonth" :disabled="atCalMax">›</button>
      </div>
      <div class="cal-grid cal-head">
        <span v-for="w in ['一','二','三','四','五','六','日']" :key="w">{{ w }}</span>
      </div>
      <div class="cal-grid">
        <span v-for="n in calLead" :key="'b' + n" class="cal-cell blank"></span>
        <span v-for="d in calDays" :key="d.date" class="cal-cell" :class="{ closed: !d.trading, today: d.date === calToday }">
          {{ Number(d.date.slice(8, 10)) }}
          <i v-if="!d.trading" class="cal-x">休</i>
        </span>
      </div>
      <div class="cal-foot muted">灰色=休市（周末/节假日）；今日高亮。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { dataApi } from '../api/data';

const calToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const calOpen = ref(false);
const calYear = ref(Number(calToday.slice(0, 4)));
const calMonth = ref(Number(calToday.slice(5, 7)));
const calDays = ref<Array<{ date: string; trading: boolean }>>([]);
const calLead = computed(() => {
  const first = `${calYear.value}-${String(calMonth.value).padStart(2, '0')}-01`;
  return (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
});
const calMax = (() => {
  const y = Number(calToday.slice(0, 4));
  const m = Number(calToday.slice(5, 7));
  const d = Number(calToday.slice(8, 10));
  const afterNov30 = m > 11 || (m === 11 && d >= 30);
  return { year: afterNov30 ? y + 1 : y, month: 12 };
})();
const atCalMax = computed(() => calYear.value > calMax.year || (calYear.value === calMax.year && calMonth.value >= calMax.month));
async function loadCalendar() {
  try { calDays.value = (await dataApi.tradeCalendar(calYear.value, calMonth.value)).days; } catch { calDays.value = []; }
}
function toggleCalendar() {
  calOpen.value = !calOpen.value;
  if (calOpen.value) {
    calYear.value = Number(calToday.slice(0, 4));
    calMonth.value = Number(calToday.slice(5, 7));
    loadCalendar();
  }
}
function prevMonth() {
  if (calMonth.value === 1) { calMonth.value = 12; calYear.value--; } else calMonth.value--;
  loadCalendar();
}
function nextMonth() {
  if (atCalMax.value) return;
  if (calMonth.value === 12) { calMonth.value = 1; calYear.value++; } else calMonth.value++;
  loadCalendar();
}
</script>

<style scoped>
.cal-wrap { position: relative; }
.cal-btn { font-size: 14px; padding: 2px 6px; }
/* 状态条在屏幕最底部 → 弹层向上、右对齐 */
.cal-pop { position: absolute; bottom: calc(100% + 6px); right: 0; min-width: 240px; max-width: calc(100vw - 24px); background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,0.16); padding: 10px; z-index: 60; }
.cal-nav { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.cal-head span { text-align: center; font-size: 11px; color: var(--muted, #888); padding: 2px 0; }
.cal-cell { position: relative; text-align: center; font-size: 12px; padding: 5px 0; border-radius: 6px; cursor: default; }
.cal-cell.blank { visibility: hidden; }
.cal-cell.closed { background: #f0f0f0; color: #aaa; }
.cal-cell.today { outline: 2px solid var(--accent, #2a8a2a); font-weight: 700; }
.cal-x { position: absolute; top: 0; right: 2px; font-size: 8px; color: #c98; font-style: normal; }
.cal-foot { font-size: 11px; margin-top: 6px; }
.mini { font-size: 12px; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
</style>
```
> `dataApi.tradeCalendar(y,m)` 返回带 `.days` 的对象(与 HomeView 现状一致)。`calToday` 用浏览器北京日期。

- [ ] **Step 2: MarketStatusBar 接入(右侧最右端)**

`frontend/src/views/MarketStatusBar.vue`：
- `<script setup>` 加 `import CalendarPopover from './CalendarPopover.vue';`。
- 模板 `.right` 容器内、`<span class="muted updated">…</span>` **之后**(最右)加 `<CalendarPopover />`。

- [ ] **Step 3: HomeView 删顶栏日历**

- 模板：删除顶栏的 `<div v-if="!auth.isAdmin" class="cal-wrap"> … </div>` 整段(日历块，约 48–67 行；保留其后的 `<div class="topnav-user">`)。
- 脚本：删除迁走的日历状态/computed/函数 `calToday/calOpen/calYear/calMonth/calDays/calLead/calMax/atCalMax/loadCalendar/toggleCalendar/prevMonth/nextMonth`。
- 样式：删除 `.cal-wrap/.cal-pop/.cal-nav/.cal-grid/.cal-head/.cal-cell/.cal-x/.cal-foot` 及 `.topnav .cal-wrap`/`.topnav .cal-pop` 等只服务顶栏日历的规则(grep 确认无其它引用)。
- `grep -n "calOpen\|toggleCalendar\|cal-wrap\|dataApi" frontend/src/views/HomeView.vue` 确认:cal* 全清；`dataApi` 若 HomeView 不再用则连同 import 删,仍用则保留。
- `npx vue-tsc --noEmit` 必须 0(无未用变量/未定义引用)。

- [ ] **Step 4: 类型检查 + 走查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。
走查:状态条最右端出现 📅 小图标(hover 提示「A股日历」),点击向上弹当月日历、可切月;HomeView 顶栏不再有日历。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/CalendarPopover.vue frontend/src/views/MarketStatusBar.vue frontend/src/views/HomeView.vue
git commit -m "feat(home): A股日历抽成 CalendarPopover 移入状态条最右端(小图标向上弹);顶栏移除

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收

1. `cd ~/projects/stock-agent/backend && npx jest routes/account -i` → 全绿。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(可选)：`docker compose up -d --build`——
   - 账号设置顶部「账号信息」:用户名只读、改昵称保存后右上角即时更新。
   - 状态条最右端 📅 小图标(title 提示),点击向上弹当月日历、可切月;顶栏不再有日历。
