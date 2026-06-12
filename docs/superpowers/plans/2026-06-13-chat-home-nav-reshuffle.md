# 聊天主页导航微调 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「当前策略探讨」房间标题栏加 [📜当前策略][🔀更换组合模板][🧹清理]，前两个弹出层；顶部菜单去掉「当前策略」「账号设置」两项；账号设置移入右上角用户下拉(含登出)。

**Architecture:** 纯前端 `HomeView.vue` 改动 + 新增通用 `Modal.vue`。当前策略弹层挂 `RulebookView`；更换模板弹层挂原 `tplswitch` 面板(从房间正文迁入)。账号设置仍走现有 `settingsKey='account'` 面板，仅入口移到用户下拉——故 `account` 项保留在 `SETTINGS`(供 `currentSettingsComp` 解析)但从菜单隐藏。

**Tech Stack:** Vue 3 (Vite，无前端单测 → `vue-tsc` + 走查)。

参照 spec：`docs/superpowers/specs/2026-06-13-chat-home-nav-reshuffle-design.md`。

---

## 文件结构

- Create `frontend/src/views/Modal.vue` — 通用弹层(标题+✕+遮罩+插槽)
- Modify `frontend/src/views/HomeView.vue` — 标题栏按钮、两弹层、菜单精简、用户下拉、房间正文移走 tplswitch

---

## Task 1: 通用 Modal 组件

**Files:** Create `frontend/src/views/Modal.vue`

- [ ] **Step 1: 创建 `frontend/src/views/Modal.vue`**

```vue
<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal-card">
      <div class="modal-head">
        <span class="modal-title">{{ title }}</span>
        <button class="modal-x" @click="$emit('close')" title="关闭">✕</button>
      </div>
      <div class="modal-body"><slot /></div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title?: string }>();
defineEmits<{ (e: 'close'): void }>();
</script>

<style scoped>
.modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
.modal-card { background: var(--surface, #fff); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2); width: 100%; max-width: 720px; max-height: 86vh; display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border, #e5e5e5); }
.modal-title { font-weight: 700; font-size: 15px; }
.modal-x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--muted, #888); padding: 2px 6px; }
.modal-body { padding: 16px; overflow-y: auto; }
</style>
```

- [ ] **Step 2: 类型检查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/Modal.vue
git commit -m "feat(ui): 通用 Modal 弹层组件(标题/关闭/遮罩/插槽)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: HomeView — 标题栏按钮 + 弹层 + 菜单精简 + 用户下拉

**Files:** Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: import + refs**

1a. 顶部加 `import Modal from './Modal.vue';`(与其它 `import ... from './...'` 同处)。`RulebookView`、`SettingsView` 的 import **保留**(弹层/账号面板仍用)。
1b. 加两个 ref(与其它 ref 同区)：
```ts
const rulebookModalOpen = ref(false);
const userMenuOpen = ref(false);
```
(`tplOpen` ref 已存在，复用作更换模板弹层的显隐。)

- [ ] **Step 2: 标题栏(line 102–109)加 core_principle 两按钮**

把：
```vue
              <div class="title">
                {{ active.title || sessionLabel(active) }}
                <span v-if="active.kind === 'stock'" class="stock-head">
                  <button class="mini" :disabled="analyzing" @click="doAnalyze(active)">{{ analyzing ? '按当前策略分析中…' : '🔄 重新按当前策略分析' }}</button>
                  <button class="mini" @click="openReport(active.ref_id!)">完整报告</button>
                </span>
                <button class="mini clear-cur" @click="clearCurrent" title="清空当前会话的消息">🧹 清理</button>
              </div>
```
改为(在 🧹清理 之前插入 core_principle 两按钮)：
```vue
              <div class="title">
                {{ active.title || sessionLabel(active) }}
                <span v-if="active.kind === 'stock'" class="stock-head">
                  <button class="mini" :disabled="analyzing" @click="doAnalyze(active)">{{ analyzing ? '按当前策略分析中…' : '🔄 重新按当前策略分析' }}</button>
                  <button class="mini" @click="openReport(active.ref_id!)">完整报告</button>
                </span>
                <template v-if="active.kind === 'core_principle'">
                  <button class="mini" @click="rulebookModalOpen = true">📜 当前策略</button>
                  <button class="mini" @click="tplOpen = true">🔀 更换组合模板</button>
                </template>
                <button class="mini clear-cur" @click="clearCurrent" title="清空当前会话的消息">🧹 清理</button>
              </div>
```

- [ ] **Step 3: 房间正文(line 157–194)移除「更换模板」触发 + tplswitch，保留 synthesize/propose**

把 `<div v-else-if="active.kind === 'core_principle'" class="room-actions"> ... </div>`(157–194 整块)替换为(只留 synthesize/propose)：
```vue
              <div v-else-if="active.kind === 'core_principle'" class="room-actions">
                <button v-if="needsInit" class="propose-btn" :disabled="synthesizing" @click="synthesizePrinciple">
                  <span v-if="synthesizing" class="spinner"></span>{{ synthesizing ? '来财生成中…' : '🛠 根据我们的聊天，帮我生成当前策略' }}
                </button>
                <button v-else class="propose-btn" :disabled="proposing" @click="propose">
                  <span v-if="proposing" class="spinner"></span>{{ proposing ? 'agent 拟定中…' : '🛠 根据本次讨论，让 agent 提议修改规则' }}
                </button>
              </div>
```
(删掉了 line 158 的「更换/组合模板」触发按钮与 line 165–194 的整段 `tplswitch` 面板——后者迁入 Step 5 的弹层。)

- [ ] **Step 4: 用户下拉(topnav-user, line 69–72)**

把：
```vue
        <div class="topnav-user">
          <span class="uname">👤 {{ auth.user?.nickname || auth.user?.username }}</span>
          <button class="mini" @click="logout">登出</button>
        </div>
```
改为：
```vue
        <div class="topnav-user">
          <button class="uname-btn" @click="userMenuOpen = !userMenuOpen">👤 {{ auth.user?.nickname || auth.user?.username }} ▾</button>
          <div v-if="userMenuOpen" class="user-menu">
            <button @click="settingsKey = 'account'; userMenuOpen = false">账号设置</button>
            <button @click="logout">登出</button>
          </div>
        </div>
```

- [ ] **Step 5: 两个弹层(放模板末尾，紧邻现有 `<MarkdownModal .../>`)**

在 `<MarkdownModal :open="detailOpen" ... />` 附近(同级)加：
```vue
    <Modal v-if="rulebookModalOpen" title="当前策略" @close="rulebookModalOpen = false">
      <RulebookView />
    </Modal>
    <Modal v-if="tplOpen" title="更换 / 组合模板" @close="tplOpen = false">
      <div class="tplswitch">
        <div class="tplgrid">
          <label v-for="t in templates" :key="t.key" class="tplcheck">
            <input type="checkbox" :value="t.key" v-model="tplSelected" /> {{ t.label }}
          </label>
        </div>
        <button :disabled="!tplSelected.length" @click="previewCompose">预览组合（{{ tplSelected.length }}）</button>
        <div class="tpl-interview-entry">
          <a href="#" @click.prevent="startInterview">或：我还没想好，帮我从聊天聊出一套 →</a>
        </div>
        <div v-if="composeRes" class="composeprev">
          <p v-if="!composeRes.conflict" class="ok-msg">✅ 无冲突，将合并为一套：{{ composeRes.versionLabel }}</p>
          <template v-else>
            <p class="warn">⚠️ 存在冲突（字段：{{ composeRes.conflictFields.join('、') }}），将拆为多套系统，请排优先级（上=优先）：</p>
            <div v-for="(k, i) in orderedKeys" :key="k" class="sysrow">
              <span><b>{{ String.fromCharCode(65 + i) }}</b>：{{ labelOfKey(k) }}</span>
              <span class="ord">
                <button class="mini" :disabled="i === 0" @click="moveKey(i, -1)">↑</button>
                <button class="mini" :disabled="i === orderedKeys.length - 1" @click="moveKey(i, 1)">↓</button>
              </span>
            </div>
          </template>
          <button @click="applyCompose">换入为当前策略</button>
        </div>
        <span v-if="tplMsg" class="ok-msg">{{ tplMsg }}</span>
      </div>
    </Modal>
```
> 与原 `tplswitch` 内容一致，仅去掉原 `.tpl-head`(标题+收起)——Modal 自带标题与 ✕。所有 ref/函数(`templates`/`tplSelected`/`previewCompose`/`composeRes`/`orderedKeys`/`moveKey`/`labelOfKey`/`applyCompose`/`tplMsg`/`startInterview`)沿用。

- [ ] **Step 6: SETTINGS 精简 + settingsMenu 过滤隐藏项**

6a. `SETTINGS` 数组：
- **删除** `{ key: 'rulebook', label: '当前策略', icon: '📜', comp: RulebookView, roles: 'user' },`(已改为标题栏弹层)。
- 给 `account` 项加 `hidden: true`(保留在 SETTINGS 供 `currentSettingsComp` 解析，但从菜单隐藏)：
  `{ key: 'account', label: '账号设置', icon: '👤', comp: SettingsView, roles: 'both', hidden: true },`
6b. `settingsMenu` computed 过滤加 `&& !s.hidden`：
```ts
const settingsMenu = computed(() =>
  SETTINGS.filter((s: any) => !s.hidden && (s.roles === 'both' || s.roles === (auth.isAdmin ? 'admin' : 'user'))),
);
```
> `currentSettingsComp`(按 key 查 comp)不变——`settingsKey='account'` 仍能解析到 `SettingsView`，故用户下拉点「账号设置」正常打开面板。

- [ ] **Step 7: 样式(`<style scoped>` 末尾)**

```css
.uname-btn { background: none; border: none; font-size: 12px; color: var(--text-soft); white-space: nowrap; cursor: pointer; padding: 4px 6px; }
.topnav-user { position: relative; }
.user-menu { position: absolute; top: 110%; right: 0; z-index: 60; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.12); display: flex; flex-direction: column; min-width: 120px; }
.user-menu button { background: none; border: none; text-align: left; padding: 8px 14px; font-size: 13px; cursor: pointer; }
.user-menu button:hover { background: var(--hover, #f5f5f5); }
```
> `.tplswitch`/`.tplgrid`/`.tplcheck`/`.composeprev`/`.sysrow`/`.tpl-interview-entry`/`.ok-msg`/`.warn` 等样式已存在，弹层内复用即可(它们非 `:deep`，在 HomeView 自身作用域，弹层 DOM 也在 HomeView 模板内，作用域属性照常生效)。

- [ ] **Step 8: 类型检查 + 走查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。
走查确认：
- 进「当前策略探讨」房间，标题栏出现 [📜当前策略][🔀更换组合模板][🧹清理]；点前两个分别弹出 RulebookView / 模板面板；房间正文只剩 synthesize/propose。
- 其它房间(个股/复盘/选股)标题栏不变(无新按钮)。
- 顶部菜单不再有「当前策略」「账号设置」；普通用户菜单=策略历史|分析历史|AI模型|能力插件。
- 右上角 👤 点击弹下拉 [账号设置][登出]；账号设置→打开账号面板；独立登出按钮已消失。

- [ ] **Step 9: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): 当前策略/更换模板移入核心策略房间标题栏弹层;账号设置入用户下拉;顶部菜单精简

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收

1. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
2. 容器验证(可选)：`docker compose up -d --build` 后普通用户——「当前策略探讨」房间标题栏三按钮 + 两弹层正常；顶部菜单已精简;右上角用户下拉含账号设置+登出。admin：用户下拉同样可用(账号设置/登出);admin 无核心策略房间，标题栏弹层按钮不出现。
