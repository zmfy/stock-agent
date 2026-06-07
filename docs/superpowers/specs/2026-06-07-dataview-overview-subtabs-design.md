# 数据页重构：状态概览条 + 二级标签

日期：2026-06-07

## Context（背景）

「数据」页（`frontend/src/views/DataView.vue`，530 行）目前把 **7 张卡片**从上到下平铺，需要大量滚动，且看不到「数据新不新 / 数据源在不在线」的整体状态：
1. 数据源管理　2. 行情上游（探测择优）　3. 股票库（本地全量 A 股）　4. 行情数据（本地）　5. 数据采集　6. 上传行情 CSV　7. 查看个股快照

用户希望往「更方便使用」的方向优化（不再一路下滑）。本次以数据页为**试点**，调出一套可复用的版式（验证满意后再推广到其它功能页，推广不在本次范围）。

## Goals

- 顶部常驻**状态概览条**：一眼看到数据源在线状态 + 股票库/行情最后同步时间 + 是否正在同步。
- **二级标签**把 7 张卡归 3 组，点哪组只渲染哪组，消除长滚动：
  - **数据源**：数据源管理、行情上游探测
  - **同步状态**：股票库、行情数据（本地）、数据采集
  - **工具**：上传行情 CSV、查看个股快照
- 纯前端、单文件、**零接口/零逻辑改动**——只重排现有 DOM + 加概览条/标签栏 + CSS。

## Non-goals

- 不改任何数据获取 / job 触发 / 上传 / 探测 / 快照逻辑，不动各卡片自身的成功/错误提示。
- 不动后端，不加新 API。
- 本次**不**抽公共组件、**不**改其它功能页（数据页验证后再推广）。
- 不做卡片折叠、不做拖拽排序（YAGNI）。

## 设计

唯一改动文件：`frontend/src/views/DataView.vue`。

### 状态（script）

新增一个 ref：
```ts
const tab = ref<'source' | 'sync' | 'tools'>('source'); // 默认「数据源」
```
其余 script 不变（`source`、`jobs`、`dsources`、`providers`、`snap`、所有 handler 原样保留）。

### 概览条（template，放在 `<header class="bar">` 之后、替换现有那条 `<section class="banner">`）

```html
<section class="overview">
  <span class="ov-item" :class="source.sidecarHealthy ? 'ok' : 'warn'">
    <b>●</b>
    <template v-if="source.sidecarConfigured">数据源 {{ source.sidecarHealthy ? '在线' : '离线' }}</template>
    <template v-else>未启用数据源</template>
  </span>
  <span class="ov-item">股票库 {{ (jobs.stock_universe?.last_success_at || '—').slice(0, 10) }}</span>
  <span class="ov-item">行情 {{ (jobs.eod?.last_success_at || '—').slice(0, 10) }}</span>
  <span v-if="anySyncing" class="ov-item syncing">⟳ 同步中…</span>
  <span v-if="source.sidecarConfigured === false" class="ov-hint">可在「能力插件」启用 AkShare；仍可手动上传 CSV。</span>
</section>
```

新增 computed：
```ts
const anySyncing = computed(
  () => jobs.value.stock_universe?.state === 'running' || jobs.value.eod?.state === 'running'
);
```
> 注：实现时按 `jobs` 在该文件里的真实形态取值（ref 则 `jobs.value.xxx`，reactive 则 `jobs.xxx`）。`last_success_at` 形如 ISO 字符串，`.slice(0,10)` 取到日期；为空用 `—`。

### 二级标签栏（概览条之后）

```html
<nav class="subtabs">
  <button :class="{ active: tab === 'source' }" @click="tab = 'source'">数据源</button>
  <button :class="{ active: tab === 'sync' }" @click="tab = 'sync'">同步状态</button>
  <button :class="{ active: tab === 'tools' }" @click="tab = 'tools'">工具</button>
</nav>
```

### 分组渲染

把现有 7 个 `<section class="card">` 用一层包裹按组 `v-if` 显示（**卡片内部 DOM 与逻辑完全不动**，仅在外层加显示条件）：

- `<div v-show="tab === 'source'">` 包：数据源管理卡 + 行情上游探测卡
- `<div v-show="tab === 'sync'">` 包：股票库卡 + 行情数据卡 + 数据采集卡
- `<div v-show="tab === 'tools'">` 包：上传 CSV 卡 + 查看个股快照卡

用 `v-show`（而非 `v-if`）避免切换标签时丢失各卡已加载的状态（如已探测的 providers、已查的 snap、展开的日志）；首屏开销可接受（卡片本就都在）。

### 样式（新增 scoped CSS）

```css
.overview { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 10px 14px; background: #f7faff; border: 1px solid #d6e4ff; border-radius: 8px; margin: 8px 0; font-size: 13px; }
.ov-item { color: #334; }
.ov-item.ok b { color: #389e0d; }
.ov-item.warn b { color: #cf1322; }
.ov-item.syncing { color: #1677ff; }
.ov-hint { color: #888; margin-left: auto; }
.subtabs { display: flex; gap: 6px; margin: 10px 0 4px; border-bottom: 1px solid #eee; }
.subtabs button { border: none; background: none; padding: 8px 16px; font-size: 14px; cursor: pointer; color: #555; border-bottom: 2px solid transparent; }
.subtabs button.active { color: #1677ff; border-bottom-color: #1677ff; font-weight: 600; }
```
删除原 `.banner` 相关 CSS（不再使用）。

## Testing

- `cd frontend && npx vue-tsc --noEmit` 干净。
- 后端零改动；可选 `cd backend && npm test` 回归确认仍 194 绿。
- 手动冒烟：
  1. 进入数据页默认停在「数据源」标签，只见 数据源管理 + 行情上游探测两张卡；概览条显示数据源在线状态 + 股票库/行情日期。
  2. 切「同步状态」→ 只见 股票库/行情数据/数据采集；切「工具」→ 只见 上传CSV/个股快照。
  3. 在「数据源」探测一次 → 切走再切回，providers 结果仍在（v-show 保状态）。
  4. 触发一个 job（如股票库「立即更新」running）→ 概览条出现 `⟳ 同步中…`。
  5. 各卡原有按钮/上传/快照/日志功能照常工作（无回归）。

## 默认决定（已确认）

- 默认标签 = **数据源**（用户确认）。
- 分组：数据源 / 同步状态 / 工具，3 组如上。
- 用 `v-show` 切换保留各卡状态。
- 概览条三项：数据源在线、股票库最后同步、行情最后同步 + 同步中提示。
- 本次仅数据页；公共组件抽取与其它页推广留待后续。
