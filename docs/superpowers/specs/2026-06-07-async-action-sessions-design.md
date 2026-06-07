# 操作按钮即开会话 + 后台生成 + 随时回看

日期：2026-06-07

## Context（背景）

上一轮把「按核心原则选股」做成了 `screen` 聊天会话，并给早会/晚会/选股/提议规则按钮加了点击转圈 loading。但当前流程仍是**阻塞式**：

- `genMeeting(kind)` 先 `await meetingsApi.generate(kind)`，生成完成后才 `openMeeting` 打开会话。
- `runScreen()` 先 `await screenApi.run({})`，返回后才 `openScreen`。

后果：按钮上长时间转圈，会话窗口要等生成结束才打开；用户若在等待期间点了别处，这次结果就「丢」了（要重新触发）。

用户诉求：**只要点击就立即打开聊天框**（左侧会话列表里可见、右侧进入该会话），生成在后台跑；用户可随时切到别处、再切回本会话查看结果，不用一直等待；如果不能马上出结果，就在会话里提醒「稍后再来看」。早会、晚会、选股三个按钮都要这样。

## Goals

- 点击早会 / 晚会 / 按核心原则选股 → **立即打开对应会话**（不等生成）。
- 生成在后台进行；SPA 内切换到别的会话/菜单再切回来，进度与状态不丢。
- 生成期间，会话窗口顶部显示「正在生成…稍后回来查看」提示；左侧列表对应会话项显示转圈小图标。
- 生成完成且用户正停在该会话时，结果**自动刷新**显示（靠响应式，无需手动点刷新）。
- 后台生成失败时，在该会话内显示红色错误提示（而非转瞬即逝的 toast），可再次点击重试。

## Non-goals

- **不**做服务端后台任务 / 轮询 / SSE。持久化范围 = 仅前端内切换（SPA 导航）。硬刷新浏览器（F5）会丢失「生成中」的客户端状态——但服务端仍在生成，结果持久化，刷新后重新打开该会话即可看到已完成结果。（已与用户确认采用此范围。）
- **不**改早会/晚会/选股的生成算法与后端接口。本次纯前端改动。
- **不**改「让 agent 提议修改规则」按钮（`proposing`）——它停在 propose 面板上，行为保持原样，不在本次范围。
- **不**支持同一 kind 并发重复触发：若该 kind 正在生成中，再次点击按钮只是切回那个会话，不重复发起生成。

## 设计

唯一改动文件：`frontend/src/views/HomeView.vue`。服务端早会/晚会/选股结果本就持久化，前端只是不再 `await` 阻塞它。

### 模块级状态（SPA 内切换不丢，因为是模块级响应式对象）

```ts
import { reactive } from 'vue';
// 正在后台生成的会话种类
const generating = reactive(new Set<'morning' | 'evening' | 'screen'>());
// 后台生成失败信息，按 kind 记录
const genErr = reactive<Record<string, string>>({});
```

> 注：`reactive(new Set())` 在 Vue 3 中对 `.add`/`.delete`/`.has` 是响应式的，模板里 `generating.has(...)` 会随之更新。

### `genMeeting(kind)` 改为非阻塞

```ts
async function genMeeting(kind: 'morning' | 'evening') {
  // 已在生成中：只切回该会话，不重复触发
  if (generating.has(kind)) {
    await openMeeting(kind);
    return;
  }
  delete genErr[kind];
  await openMeeting(kind);        // 立即开窗
  generating.add(kind);
  // 不 await：后台生成
  meetingsApi
    .generate(kind)
    .then(() => loadMeetings())   // 刷新 meetings.value → briefing 响应式自动更新
    .catch((e: any) => {
      genErr[kind] = e.response?.data?.message || '生成失败';
    })
    .finally(() => generating.delete(kind));
}
```

`openMeeting` 保持原样（找/建 kind 会话并 `open`）。

### `runScreen()` 改为非阻塞

```ts
async function runScreen() {
  if (generating.has('screen')) {
    await openScreen();
    return;
  }
  delete genErr['screen'];
  await openScreen();             // 立即开窗
  generating.add('screen');
  screenApi
    .run({})
    .then((r) => {
      screen.value = r.data.data; // 刷新 screen.value → briefing 自动更新
      return loadScreenHistory();
    })
    .catch((e: any) => {
      genErr['screen'] = e.response?.data?.message || '选股失败';
    })
    .finally(() => generating.delete('screen'));
}
```

`openScreen` 保持原样（找/建 `screen` 会话并 `open`）。

### 会话窗口：进行中横幅 + 错误横幅

在 briefing 区（`<div v-if="briefing" class="briefing">`）**上方**插入：

```html
<div v-if="active && generating.has(active.kind as any)" class="gen-banner">
  ⏳ 正在生成，可能需要一会儿。你可以先去别处，稍后回到本会话查看结果。
</div>
<div v-else-if="active && genErr[active.kind]" class="gen-banner err">
  生成失败：{{ genErr[active.kind] }}（可再次点击对应按钮重试）
</div>
```

`active.kind` 仅 `morning`/`evening`/`screen` 会命中 `generating`/`genErr`；其它 kind（stock/core_principle）永不命中，横幅不显示。

**自动刷新**：`briefing` computed 已读 `meetings.value` / `screen.value`。后台 `.then` 里刷新这两个 ref 后，停在该会话的 briefing 与结果列表靠 Vue 响应式自动更新，无需手动重渲染或提示用户点刷新。

### 左侧会话列表：进行中转圈图标

`<li v-for="s in sessions">` 内，会话名旁加：

```html
<span v-if="generating.has(s.kind as any)" class="spinner"></span>
```

（`s.kind` 为 `morning`/`evening`/`screen` 且在集合中时显示；复用既有 `.spinner` CSS。）

### 按钮：去掉长时间禁用 + 转圈

三个按钮（早会 / 晚会 / 选股）改回常态文案，点击即开窗：

- 早会：`📈 生成今日早会`
- 晚会：`🌙 生成今日晚会`
- 选股：`🔍 按核心原则选股`

移除 `:disabled="genning === ..."` / `:disabled="screening"` 与按钮内的 `<span class="spinner">` + 「…中」文案（进行中状态改由会话窗口横幅 + 左侧列表图标体现）。原 `genning` / `screening` ref 若不再被引用则删除（避免死代码）。

`proposing`（让 agent 提议）按钮**不动**。

### 样式

新增 scoped CSS：

```css
.gen-banner { background: #fffbe6; border: 1px solid #ffe58f; border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 13px; line-height: 1.6; flex: 0 0 auto; }
.gen-banner.err { background: #fff1f0; border-color: #ffccc7; color: #cf1322; }
```

## Testing

- **类型**：`cd frontend && npx vue-tsc --noEmit` 干净（注意 `Set` 泛型与 `active.kind as any` 的窄化）。
- **回归**：后端零改动 → `cd backend && npm test` 保持全绿。
- **手动冒烟**：
  1. 点「生成今日早会」→ 立即进入早会会话 + 顶部出现 ⏳ 横幅 + 左侧早会项转圈；
  2. 立刻切到「选股」并触发选股 → 选股会话也立即打开 + 转圈；两个后台任务并行；
  3. 切回早会 → 若已完成则横幅消失、briefing 显示早会内容（自动刷新）；若未完成仍显示 ⏳；
  4. 模拟失败（如停后端/断网）→ 回到该会话见红色「生成失败」横幅，再次点击按钮可重试；
  5. 重复点同一 kind（生成中）→ 仅切回该会话，不重复发起。

## 默认决定（已确认 / 可改）

- 持久化范围 = 仅前端内切换；硬刷新丢「生成中」状态可接受（服务端仍完成，重开会话见结果）。
- 生成完成且停留在该会话 → 自动刷新结果（非「点此刷新」）。
- 失败提示写在会话窗口横幅（按 kind），非顶部 toast。
- 同 kind 生成中重复点击 = 切回会话，不重复触发。
- 「让 agent 提议修改规则」按钮不在本次范围。
