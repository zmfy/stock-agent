# 操作按钮即开会话 + 后台生成 + 随时回看 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让早会/晚会/按核心原则选股三个按钮点击即打开对应聊天会话、生成在后台进行、用户可随时切走再回来查看结果。

**Architecture:** 纯前端改动，只动 `frontend/src/views/HomeView.vue`。把现有「await 生成后才开窗」的阻塞流程改为「先开窗 → 不 await 地后台跑生成 → 完成后刷新数据 ref（briefing 靠响应式自动更新）」。用模块级 `reactive(Set)` 记录进行中的会话种类、`reactive(Record)` 记录失败信息，SPA 内切换不丢；会话窗顶部横幅 + 左侧列表转圈图标体现进行中。服务端早会/晚会/选股结果本就持久化，无后端改动。

**Tech Stack:** Vue 3 (Composition API, `<script setup lang="ts">`)、TypeScript、vue-tsc 类型检查。前端无单元测试框架——验证 = `vue-tsc --noEmit` 干净 + 后端 `npm test` 回归全绿 + 手动冒烟。

**关键约束（来自 spec）：**
- 仅前端内切换持久化；硬刷新丢「生成中」状态可接受（服务端仍完成、重开会话见结果）。
- 同 kind 生成中重复点击 = 切回该会话，不重复触发。
- 完成且停留在该会话 → briefing 响应式自动刷新（非「点此刷新」）。
- 失败 → 该会话窗口红色横幅（按 kind），可重试。
- 「让 agent 提议修改规则」按钮（`proposing`）不动。

**当前代码锚点（实现前请确认行号未漂移，用字符串匹配定位）：**
- import：`HomeView.vue:208` — `import { ref, computed, nextTick, onMounted } from 'vue';`
- 状态：`HomeView.vue:254` — `const genning = ref<'' | 'morning' | 'evening'>('');`；`:255` `const screen = ref<ScreenRun | null>(null);`；`:256` `const screening = ref(false);`
- 三个按钮：`HomeView.vue:147`（早会）、`:151`（晚会）、`:154`（选股）
- briefing 区：`HomeView.vue:74` — `<div v-if="briefing" class="briefing">{{ briefing }}</div>`
- 左侧 li：`HomeView.vue:14-15` — `<span class="kind">…</span><span class="stitle">…</span>`
- `genMeeting`：`HomeView.vue:513-525`；`runScreen`：`HomeView.vue:576-588`；`openMeeting`/`openScreen` 保持原样。

---

### Task 1: 新增模块级进行中状态

**Files:**
- Modify: `frontend/src/views/HomeView.vue:208`（import）
- Modify: `frontend/src/views/HomeView.vue:253-256`（状态声明区，紧跟 `meetings` ref 之后）

- [ ] **Step 1: 在 vue import 中加入 `reactive`**

把 `HomeView.vue:208`：

```ts
import { ref, computed, nextTick, onMounted } from 'vue';
```

改为：

```ts
import { ref, reactive, computed, nextTick, onMounted } from 'vue';
```

- [ ] **Step 2: 新增 `generating` 与 `genErr` 状态**

在 `HomeView.vue:253` 的 `const meetings = ref(...)` 这一行**之后**插入两行（放在 `meetings` 与 `genning` 之间）：

```ts
// 正在后台生成的会话种类（morning/evening/screen）——SPA 内切换不丢
const generating = reactive(new Set<'morning' | 'evening' | 'screen'>());
// 后台生成失败信息，按 kind 记录
const genErr = reactive<Record<string, string>>({});
```

> 说明：`reactive(new Set())` 在 Vue 3 中对 `.add`/`.delete`/`.has` 响应式，模板里 `generating.has(...)` 会随之更新。

- [ ] **Step 3: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 通过（新加的 `generating`/`genErr` 暂未被引用，TS 不会报未使用——`<script setup>` 顶层声明不触发 noUnusedLocals 对模板可见绑定的告警；若报未使用，Task 2/4 引用后即消除，可继续）。

- [ ] **Step 4: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 新增 generating/genErr 模块级进行中状态

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `genMeeting` 改为非阻塞（先开窗，后台生成）

**Files:**
- Modify: `frontend/src/views/HomeView.vue:513-525`（`genMeeting` 函数）

- [ ] **Step 1: 重写 `genMeeting`**

把现有（`HomeView.vue:513-525`）：

```ts
async function genMeeting(kind: 'morning' | 'evening') {
  genning.value = kind;
  chatErr.value = '';
  try {
    await meetingsApi.generate(kind);
    await loadMeetings();
    await openMeeting(kind);
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '生成失败';
  } finally {
    genning.value = '';
  }
}
```

整体替换为：

```ts
async function genMeeting(kind: 'morning' | 'evening') {
  // 已在后台生成中：只切回该会话，不重复触发
  if (generating.has(kind)) {
    await openMeeting(kind);
    return;
  }
  delete genErr[kind];
  await openMeeting(kind); // 立即打开会话窗口（不等生成）
  generating.add(kind);
  // 不 await：后台生成，完成后刷新 meetings.value，briefing 靠响应式自动更新
  meetingsApi
    .generate(kind)
    .then(() => loadMeetings())
    .catch((e: any) => {
      genErr[kind] = e.response?.data?.message || '生成失败';
    })
    .finally(() => {
      generating.delete(kind);
    });
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 通过。`genning` 此时仅在模板按钮 + 声明处被引用，未报错（Task 4 会清理）。

- [ ] **Step 3: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 早会/晚会按钮点击即开会话、后台生成

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `runScreen` 改为非阻塞（先开窗，后台选股）

**Files:**
- Modify: `frontend/src/views/HomeView.vue:576-588`（`runScreen` 函数）

- [ ] **Step 1: 重写 `runScreen`**

把现有（`HomeView.vue:576-588`）：

```ts
async function runScreen() {
  screening.value = true;
  chatErr.value = '';
  try {
    screen.value = (await screenApi.run({})).data.data;
    await openScreen();
    await loadScreenHistory();
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '选股失败';
  } finally {
    screening.value = false;
  }
}
```

整体替换为：

```ts
async function runScreen() {
  // 已在后台选股中：只切回选股会话，不重复触发
  if (generating.has('screen')) {
    await openScreen();
    return;
  }
  delete genErr['screen'];
  await openScreen(); // 立即打开选股会话窗口（不等选股结果）
  generating.add('screen');
  // 不 await：后台选股，完成后刷新 screen.value + 历史，briefing 靠响应式自动更新
  screenApi
    .run({})
    .then((r) => {
      screen.value = r.data.data;
      return loadScreenHistory();
    })
    .catch((e: any) => {
      genErr['screen'] = e.response?.data?.message || '选股失败';
    })
    .finally(() => {
      generating.delete('screen');
    });
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 通过。`screening` 此时仅在模板选股按钮 + 声明处被引用（Task 4 清理）。

- [ ] **Step 3: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 选股按钮点击即开会话、后台选股

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 模板——进行中/失败横幅 + 左侧转圈图标 + 按钮回常态 + CSS

**Files:**
- Modify: `frontend/src/views/HomeView.vue:74`（briefing 上方插横幅）
- Modify: `frontend/src/views/HomeView.vue:14-15`（左侧 li 加 spinner）
- Modify: `frontend/src/views/HomeView.vue:147,151,154`（三个按钮回常态）
- Modify: `frontend/src/views/HomeView.vue` 样式区（新增 `.gen-banner` CSS，紧邻既有 `.briefing` 规则）

- [ ] **Step 1: 在 briefing 上方插入进行中/失败横幅**

在 `HomeView.vue:74` 的 `<div v-if="briefing" class="briefing">{{ briefing }}</div>` 这一行**之前**插入：

```html
              <div v-if="active && generating.has(active.kind as any)" class="gen-banner">
                ⏳ 正在生成，可能需要一会儿。你可以先去别处，稍后回到本会话查看结果。
              </div>
              <div v-else-if="active && genErr[active.kind]" class="gen-banner err">
                生成失败：{{ genErr[active.kind] }}（可再次点击对应按钮重试）
              </div>
```

- [ ] **Step 2: 左侧会话列表项加进行中转圈图标**

把 `HomeView.vue:14-15`：

```html
          <span class="kind">{{ kindIcon(s.kind) }}</span>
          <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
```

改为（在 `stitle` 之后加一个条件 spinner）：

```html
          <span class="kind">{{ kindIcon(s.kind) }}</span>
          <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
          <span v-if="generating.has(s.kind as any)" class="spinner sess-spin"></span>
```

- [ ] **Step 3: 三个按钮回常态文案（去掉禁用 + 按钮内 spinner）**

把 `HomeView.vue:147`（早会）：

```html
            <button v-else class="ops-btn dashed" :disabled="genning === 'morning'" @click="genMeeting('morning')"><span v-if="genning === 'morning'" class="spinner"></span>📈 生成今日早会</button>
```

改为：

```html
            <button v-else class="ops-btn dashed" @click="genMeeting('morning')">📈 生成今日早会</button>
```

把 `HomeView.vue:151`（晚会）：

```html
            <button v-else class="ops-btn dashed" :disabled="genning === 'evening'" @click="genMeeting('evening')"><span v-if="genning === 'evening'" class="spinner"></span>🌙 生成今日晚会</button>
```

改为：

```html
            <button v-else class="ops-btn dashed" @click="genMeeting('evening')">🌙 生成今日晚会</button>
```

把 `HomeView.vue:154`（选股）：

```html
            <button class="ops-btn" :disabled="screening" @click="runScreen"><span v-if="screening" class="spinner"></span>🔍 {{ screening ? '选股中…' : '按核心原则选股' }}</button>
```

改为：

```html
            <button class="ops-btn" @click="runScreen">🔍 按核心原则选股</button>
```

- [ ] **Step 4: 新增 `.gen-banner` 样式**

定位既有 `.briefing { … }` 规则（`HomeView.vue:762` 附近），在其**之后**插入：

```css
.gen-banner { background: #fffbe6; border: 1px solid #ffe58f; border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 13px; line-height: 1.6; flex: 0 0 auto; }
.gen-banner.err { background: #fff1f0; border-color: #ffccc7; color: #cf1322; }
.sess-spin { margin-left: 4px; }
```

- [ ] **Step 5: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 通过。注意 `generating.has(active.kind as any)` / `generating.has(s.kind as any)` 用 `as any` 窄化（`s.kind`/`active.kind` 是完整 ChatKind 联合，而 Set 泛型只含三种）。`genErr[active.kind]` 以 string 索引 `Record<string,string>`，合法。

- [ ] **Step 6: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 会话窗进行中/失败横幅 + 左侧转圈图标 + 按钮回常态

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 清理死代码（`genning`/`screening`）+ 全量验证

**Files:**
- Modify: `frontend/src/views/HomeView.vue:254,256`（删除不再引用的 ref）

- [ ] **Step 1: 确认 `genning` / `screening` 已无引用**

Run: `cd frontend && grep -n "genning\|screening" src/views/HomeView.vue`
Expected: 仅剩 `:254` `const genning` 与 `:256` `const screening` 两处声明（模板与函数引用应在 Task 2/3/4 后全部消失）。若还有其它引用，说明前面任务漏改——回头修正，不要直接删声明。

- [ ] **Step 2: 删除两处声明**

删除 `HomeView.vue:254`：

```ts
const genning = ref<'' | 'morning' | 'evening'>('');
```

删除 `HomeView.vue:256`：

```ts
const screening = ref(false);
```

（保留中间的 `const screen = ref<ScreenRun | null>(null);`——它仍在用。）

- [ ] **Step 3: 类型检查（确认无未使用变量报错）**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 通过，无 `'genning' is declared but never read` / `'screening' is declared but never read`。

- [ ] **Step 4: 后端回归（确认零改动未破坏）**

Run: `cd /home/zhangjq/projects/stock-agent/backend && npm test`
Expected: 全部测试通过（与改动前一致，本次无后端改动）。

- [ ] **Step 5: 手动冒烟（开发模式）**

启动前端 dev（`cd frontend && npm run dev`）+ 后端（`cd backend && npm run dev`），在浏览器逐项确认：
1. 点「生成今日早会」→ 立即进入早会会话 + 顶部出现 ⏳ 横幅 + 左侧早会项尾部转圈；按钮不再卡禁用。
2. 立刻切到操作面板点「按核心原则选股」→ 选股会话也立即打开 + 转圈；两个后台任务并行。
3. 切回早会会话 → 若已完成：⏳ 横幅消失、briefing 显示早会内容（自动刷新，无需手点）；若未完成：仍显示 ⏳。
4. 模拟失败（临时停掉后端再点）→ 回到该会话见红色「生成失败」横幅；恢复后端后再次点击按钮可重试，横幅变回 ⏳ 再变为结果。
5. 在某 kind 生成中再次点该按钮 → 仅切回该会话，不重复发起（左侧不应出现重复请求、转圈状态不闪断）。

- [ ] **Step 6: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "refactor(ui): 删除不再使用的 genning/screening ref

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：**
- 点击即开会话（早会/晚会）→ Task 2；选股 → Task 3。✓
- SPA 内切换不丢（模块级 reactive 状态）→ Task 1。✓
- 进行中横幅 + 左侧转圈图标 → Task 4 Step 1/2。✓
- 完成自动刷新（响应式，刷新 `meetings.value`/`screen.value`）→ Task 2/3 的 `.then`。✓
- 失败会话内红色横幅可重试 → Task 4 Step 1 + Task 2/3 的 `genErr` + 重复点重试。✓
- 同 kind 生成中重复点 = 切回不重复触发 → Task 2/3 的 `generating.has` 早返回。✓
- 按钮去掉长禁用/转圈 → Task 4 Step 3。✓
- `proposing` 不动 → 计划未触碰。✓
- 纯前端、后端零改 → 仅 `HomeView.vue`；Task 5 Step 4 跑后端回归确认未破坏。✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤给出完整替换前/后代码与精确命令。✓

**Type consistency：** `generating: Set<'morning'|'evening'|'screen'>` 全程一致；`genErr: Record<string,string>` 用 string key（`kind` / `'screen'`）一致；`screenApi.run({}).data.data` 与现状一致（Task 3）；`as any` 窄化在两处模板 `.has()` 调用一致。✓
