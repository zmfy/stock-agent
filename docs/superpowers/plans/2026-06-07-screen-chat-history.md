# 选股聊天化 + 历史回溯 + 入选原因 + 操作按钮转圈 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「按核心原则选股」的结果+讨论做成单一 `screen` 聊天会话（可追问）、每只入选股记录确定性入选原因、选股窗内可折叠回溯历史选股，并给耗时操作按钮加转圈 loading。

**Architecture:** 后端给 `ScreenResult` 加 `reason`（确定性门槛摘要）、加 `GET /screen/history`、给 chat 加 `screen` kind 并用 `getLatest` 做 grounding；前端 `runScreen` 改为打开单一 screen 聊天会话，主区展示纪要+结果列表+历史折叠，并给 4 个按钮加 spinner。

**Tech Stack:** Node/Express+TS（jest，tmp DATA_DIR+require，AI/getStockSnapshot 注入或 mock fetch）；Vue3（vue-tsc + 冒烟）。

**已知形状：** `evaluateGates(snap, gates) → { gateResults: [{gate_key,label,system,veto,status:'pass'|'fail'|'unknown'}], systems, aVeto, bEmotion }`；`ScreenResult = {code,name,aPass,bPass,passed,total,failed}`；`getLatest(userId) → {note, results, discussion, created_at}`。

---

## Task 1: 后端 — 入选原因 + 历史路由（TDD）

**Files:** Modify `backend/src/screen/service.ts`、`backend/src/routes/screen.ts`、`frontend/src/api/screen.ts`(类型)；Test `backend/src/screen/service.test.ts`

- [ ] **Step 1: 失败测试**（参照该文件已有 setup：造 rulebook + 注入 snapshot/aiCall）
```ts
it('screenCode 给出确定性入选原因', async () => {
  const svc = require('./service');
  // 该测试文件已有的 setup：USER 有 active rulebook；getStockSnapshot 走 mock fetch 或注入
  const r = await svc.screenCode(USER, '600519');
  expect(typeof r.reason).toBe('string');
  expect(r.reason.length).toBeGreaterThan(0);
  // 入选→含"通过"，未入选→含"未入选"
  expect(r.aPass || r.bPass ? r.reason.includes('通过') : r.reason.includes('未入选')).toBe(true);
});
it('getHistory 返回最近选股(含入选股 reason)', async () => {
  const svc = require('./service');
  await svc.runScreen(USER, { codes: ['600519'] }); // 跑一次落库
  const h = svc.getHistory(USER, 5);
  expect(Array.isArray(h)).toBe(true);
  expect(h[0]).toHaveProperty('created_at');
  expect(h[0]).toHaveProperty('picks');
});
```
- [ ] **Step 2: 跑 → FAIL** — `cd backend && npx jest src/screen/service.test.ts -t "入选原因|getHistory" -i`
- [ ] **Step 3: 实现**
- `ScreenResult` 加 `reason: string;`
- `screenCode` 在算完 aPass/bPass 后构造 reason（用 `ev.gateResults`）：
```ts
  const selected = aPass || bPass;
  let reason: string;
  if (selected) {
    const sys = aPass ? 'A' : 'B';
    const passedLabels = ev.gateResults.filter((g) => g.system === sys && g.status === 'pass').map((g) => g.label);
    reason = `入选（${sys} 系统）：通过 ${passedLabels.join('、') || '（无明确门槛）'}`;
  } else {
    const blockers = ev.gateResults
      .filter((g) => g.veto === 1 && g.status !== 'pass')
      .map((g) => `${g.label}${g.status === 'unknown' ? '(数据缺失)' : '(未达标)'}`);
    reason = `未入选：${blockers.join('、') || '无符合系统'}`;
  }
  return { code, name: snap.name, aPass, bPass, passed, total: ev.gateResults.length, failed, reason };
```
- `getHistory`:
```ts
export function getHistory(userId: string, limit = 20): Array<{ created_at: string; note: string; picks: Array<{ code: string; name: string | null; reason: string }> }> {
  const rows = getDb()
    .prepare('SELECT source_note, results, created_at FROM screenings WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as Array<{ source_note: string; results: string; created_at: string }>;
  return rows.map((r) => {
    let parsed: ScreenResult[] = [];
    try { parsed = JSON.parse(r.results); } catch { /* ignore */ }
    const picks = parsed.filter((x) => x.aPass || x.bPass).map((x) => ({ code: x.code, name: x.name, reason: x.reason || '' }));
    return { created_at: r.created_at, note: r.source_note, picks };
  });
}
```
- 路由 `backend/src/routes/screen.ts` 加：`router.get('/history', (req, res) => successResponse(res, svc.getHistory(req.user!.userId, Number(req.query.limit) || 20)));`
- 前端类型 `frontend/src/api/screen.ts`：`ScreenResult` 加 `reason?: string`。
- [ ] **Step 4: 跑 → PASS + 全套 + tsc** — `cd backend && npx jest -i && npx tsc --noEmit`
- [ ] **Step 5: Commit**
```bash
git add backend/src/screen/service.ts backend/src/routes/screen.ts frontend/src/api/screen.ts backend/src/screen/service.test.ts
git commit -m "feat(screen): 入选原因(确定性门槛摘要) + GET /screen/history 历史"
```

---

## Task 2: 后端 — screen 聊天 kind + grounding（TDD）

**Files:** Modify `backend/src/chat/service.ts`；Test `backend/src/chat/service.test.ts`

- [ ] **Step 1: 失败测试**
```ts
it('screen 会话 prompt 注入最近选股摘要', async () => {
  const svc = require('./service');
  const sc = require('../screen/service');
  // 造 active rulebook + 跑一次选股（参照已有 setup）
  await sc.runScreen(USER, { codes: ['600519'] });
  const sid = svc.createSession(USER, 'screen', null, '选股讨论');
  let seen = '';
  await svc.postMessage(USER, sid, '为什么选它', { aiCall: async (p: string) => { seen = p; return { raw: 'ok' }; } });
  expect(seen).toContain('本次选股');
});
```
- [ ] **Step 2: 跑 → FAIL** — `cd backend && npx jest src/chat/service.test.ts -t "screen 会话 prompt" -i`
- [ ] **Step 3: 实现**
- `ChatKind` 加 `'screen'`；`KIND_FRAMING.screen = '按核心原则的选股讨论：解释本次选股结果与依据，回答关于入选/未入选个股的追问；不替用户做买卖决定。'`
- `postMessage` 里加 grounding 分支（在其它 `if (!extra && session.kind===...)` 之后）：
```ts
  if (!extra && session.kind === 'screen') {
    const s = getLatestScreen(userId);
    if (s) {
      const top = s.results.slice(0, 12).map((r: any) => `${r.code} ${r.name ?? ''} ${r.aPass || r.bPass ? '入选' : '未入选'} · ${r.reason ?? ''}`).join('\n');
      extra = `本次选股范围：${s.note}\n讨论纪要：${s.discussion || '（无）'}\n候选与结果：\n${top}`;
    }
  }
```
- import：`import { getLatest as getLatestScreen } from '../screen/service'`（screen/service 不 import chat/service，无 cycle）。
- [ ] **Step 4: 跑 → PASS + 全套** — `cd backend && npx jest -i && npx tsc --noEmit`
- [ ] **Step 5: Commit**
```bash
git add backend/src/chat/service.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): screen 会话 kind + 最近选股 grounding（支持追问）"
```

---

## Task 3: 前端 — 选股开聊天会话 + 主区纪要/结果/历史

**Files:** Modify `frontend/src/views/HomeView.vue`、`frontend/src/api/screen.ts`

- [ ] **Step 1: api 加 history**
`frontend/src/api/screen.ts`：
```ts
history: (limit = 20) => api.get('/screen/history?limit=' + limit).then((r) => r.data.data as Array<{ created_at: string; note: string; picks: Array<{ code: string; name: string | null; reason: string }> }>),
```

- [ ] **Step 2: runScreen 改为开会话**（`HomeView.vue`）
```ts
async function openScreen() {
  let s = sessions.value.find((x) => x.kind === 'screen');
  if (!s) {
    const id = (await chatApi.createSession('screen', null, '选股讨论')).data.data.id;
    await loadSessions();
    s = sessions.value.find((x) => x.id === id);
  }
  if (s) await open(s);
}
async function runScreen() {
  screening.value = true; chatErr.value = '';
  try {
    screen.value = (await screenApi.run({})).data.data;
    await openScreen();
    await loadScreenHistory();
  } catch (e: any) { chatErr.value = e.response?.data?.message || '选股失败'; }
  finally { screening.value = false; }
}
const screenHistory = ref<Array<{ created_at: string; note: string; picks: Array<{ code: string; name: string | null; reason: string }> }>>([]);
const screenHistOpen = ref(false);
async function loadScreenHistory() { try { screenHistory.value = await screenApi.history(20); } catch { /* ignore */ } }
```
打开 screen 会话时也确保 `screen.value` 有最近结果：在 `open(s)` 流程里，若 `s.kind==='screen'` 且 `!screen.value`，`screen.value = (await screenApi.latest()).data.data`（latest 已存在）。并 `loadScreenHistory()`。

- [ ] **Step 3: 主区渲染**（`active.kind==='screen'`）
- `briefing` computed 加分支：`active.kind==='screen'` → `screen.value ? screen.value.note + '\n\n' + (screen.value.discussion||'') : '点「按核心原则选股」开始'`。
- briefing 下方（仿 adoptedNews box）渲染结果列表 + 历史折叠：
```html
<template v-if="active?.kind === 'screen'">
  <div v-if="screen" class="screen-box">
    <button class="fold" @click="screenHistOpen = !screenHistOpen">{{ screenHistOpen ? '▾' : '▸' }} 历史选股记录（{{ screenHistory.length }}）</button>
    <div v-if="screenHistOpen" class="screen-hist">
      <div v-for="(h, i) in screenHistory" :key="i" class="sh-row">
        <div class="muted">{{ (h.created_at || '').slice(0,16) }} · {{ h.note }}</div>
        <div v-for="p in h.picks" :key="p.code" class="sh-pick" @click="openStockCode(p.code)">
          {{ p.name || p.code }} <span class="muted">{{ p.code }} · {{ p.reason }}</span>
        </div>
        <div v-if="!h.picks.length" class="muted">（本次无入选）</div>
      </div>
    </div>
    <div class="screen-results">
      <div v-for="r in screen.results" :key="r.code" class="srow" @click="openStockCode(r.code)">
        <span class="badge2" :class="r.aPass ? 'a' : r.bPass ? 'b' : 'no'">{{ r.aPass ? 'A' : r.bPass ? 'B' : '—' }}</span>
        {{ r.name || r.code }} <span class="muted">{{ r.code }} · {{ r.reason }}</span>
      </div>
    </div>
  </div>
</template>
```
（放在 `.briefing` 之后、`.msgs` 之前，类似 adoptedNews box。复用已有 `.srow/.badge2/.fold` 样式；新增 `.screen-hist/.sh-row/.sh-pick` 简单样式。）
- **移除** ops-side 里原有的 `.screen-list` 内联折叠面板（保留「按核心原则选股」按钮 + `runScreen`）。删除不再用的 `screenOpen` ref（若仅此处用）。

- [ ] **Step 4: 验证** — `cd frontend && npx vue-tsc --noEmit` → 0 errors。冒烟：点选股进单一聊天窗、显示纪要+结果(带原因,可点开个股)+历史折叠可回溯;可追问。
- [ ] **Step 5: Commit**
```bash
git add frontend/src/views/HomeView.vue frontend/src/api/screen.ts
git commit -m "feat(ui): 选股改单一聊天会话 + 结果带入选原因 + 历史选股记录折叠回溯"
```

---

## Task 4: 前端 — 耗时按钮转圈 loading

**Files:** Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 加 spinner 样式**（`<style scoped>`）
```css
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: -1px; margin-right: 4px; }
@keyframes spin { to { transform: rotate(360deg); } }
```
- [ ] **Step 2: 四个按钮加转圈**
- 生成早会：`<button v-else class="ops-btn dashed" :disabled="genning==='morning'" @click="genMeeting('morning')"><span v-if="genning==='morning'" class="spinner"></span>📈 生成今日早会</button>`（去掉原 `{{ genning==='morning' ? '…' : '' }}`）。
- 生成晚会：同理用 `genning==='evening'`。
- 按核心原则选股：`<button class="ops-btn" :disabled="screening" @click="runScreen"><span v-if="screening" class="spinner"></span>🔍 {{ screening ? '选股中…' : '按核心原则选股' }}</button>`。
- 让 agent 提议修改规则：`<button class="propose-btn" :disabled="proposing" @click="propose"><span v-if="proposing" class="spinner"></span>{{ proposing ? 'agent 拟定中…' : '🛠 根据本次讨论，让 agent 提议修改规则' }}</button>`。
- [ ] **Step 3: 验证** — `cd frontend && npx vue-tsc --noEmit` → 0 errors。冒烟：点这四个按钮立即出现转圈、按钮禁用、完成恢复。
- [ ] **Step 4: Commit**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 生成早晚会/选股/提议规则 按钮点击即转圈 loading"
```

---

## Task 5: 端到端验证

- [ ] **Step 1: 重建 + 全套** — `docker compose up -d --build`；`cd backend && npx jest`；`cd frontend && npx vue-tsc --noEmit`
- [ ] **Step 2: 冒烟（real AI）** — 点选股 → 进单一 screen 聊天窗、结果带入选原因、可点开个股、历史折叠能回溯、可向来财追问；四个耗时按钮点击即转圈。

---

## Self-Review
- **Spec 覆盖**：入选原因+历史(Task1)、screen kind+grounding(Task2)、前端选股聊天化+结果/历史(Task3)、转圈(Task4)、e2e(Task5) —— 均有任务。
- **Placeholder**：无；每步含真实代码。
- **类型一致**：`ScreenResult.reason`、`getHistory→[{created_at,note,picks:[{code,name,reason}]}]`、chat `screen` kind + getLatestScreen grounding、前端 `screenApi.history`、`.spinner` —— 贯穿一致。无 import cycle（chat→screen 单向）。
