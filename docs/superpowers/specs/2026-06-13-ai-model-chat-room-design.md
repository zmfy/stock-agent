# 「AI 模型探讨」聊天室 + AI 顾问子 agent Design

> 新增第 4 个固定聊天室「AI 模型探讨」：把原「AI 模型」「能力插件」两个设置页的入口以标题栏按钮（与策略探讨一致）搬进该房间；新增一个**只答疑、不改配置**的子 agent `ai_helper`，结合当前模型/插件配置在房间里回答 AI 模型相关问题。

最后更新：2026-06-13。仓库：`github.com/zmfy/stock-agent`。

## 背景（现状）

- 固定房间：`chat/service.ts` `FIXED_ROOM_KINDS = ['core_principle','daily','screen']`，`FIXED_ROOM_TITLES` 给标题，`ensureFixedRooms` 幂等建齐并置顶；`routes/chat.ts` 的 `KINDS` 允许用户创建的 kind **不含** `daily`（固定房间仅由 ensure 建）。
- 房间聊天：`postMessage` 用 `getCorePersona(userId)` 作 persona、`defaultAiCall` 写死 role `'core'` 调模型；按 kind 注入 `extraContext`（stock/daily/screen/core_principle 各有分支）。`KIND_FRAMING` 给每个 kind 一句场景说明。
- 子 agent 角色：`ai/roles.ts` `ROLES`（key/label/prefer/hint）+ `agent/profiles-service.ts` `PROFILE_ROLES=['core','data','analysis','qualitative','review','validation']`。`getModelForRole(uid, role)`：无显式分配且 `role!=='core'` 时**回退 core 模型**（service.ts:281）。`AiSettingsView` 遍历 `ROLES` 渲染每个角色的模型分配行 → 新角色自动出现且可分配。persona 在子助手 persona 配置里按 `PROFILE_ROLES` 渲染。
- 设置导航：`HomeView` `SETTINGS` 数组，`ai`(AiSettingsView)/`plugins`(PluginsView) 现为 `roles:'both'`；`settingsMenu` 按 `roles` 过滤；`currentSettingsComp` 按 key 取组件。
- 标题栏按钮模式：core_principle 在 `title-actions` 里 `📜 当前策略`/`🔀 更换组合模板`，用 `<Modal v-if="xOpen" title=...>` 包内容。

## A. 新固定房间 `ai_model`

### 后端 `chat/service.ts`
- `ChatKind` 增加 `'ai_model'`。
- `FIXED_ROOM_KINDS = ['core_principle','daily','screen','ai_model']`。
- `FIXED_ROOM_TITLES['ai_model'] = 'AI 模型探讨'`。
- `KIND_FRAMING['ai_model']`：顾问场景说明（见 C）。
- `ensureFixedRooms` 不变逻辑、自然建齐 4 间（老用户下次进入自动补建并置顶）。

### `routes/chat.ts`
- `KINDS`（可创建白名单）**不**加 `ai_model`（与 `daily` 一致，仅 ensure 建，禁止手建）。注释同步。

### 前端 `HomeView.vue`
- `FIXED_ORDER` 增加 `'ai_model'`（排在 screen 之后）。
- 图标表加 `ai_model: '🤖'`；`sessionLabel`/标题映射「AI 模型探讨」。

## B. 新子 agent 角色 `ai_helper`

- `ai/roles.ts` `ROLES` 末尾追加：
  `{ key: 'ai_helper', label: 'AI 模型顾问', prefer: 'balanced', hint: '答疑 AI 模型选择/角色分配/报错排查/插件用途，引导用户去「AI 模型」「能力插件」设置，不替用户改配置' }`。
- `agent/profiles-service.ts` `PROFILE_ROLES` 追加 `'ai_helper'`。persona 缺省由 `defaultPersona('ai_helper')` 用 hint 生成；可在子助手 persona 配置里编辑。
- 模型：`getModelForRole(uid, 'ai_helper')` 未单独分配时回退 core（沿用现有逻辑），并自动出现在 AiSettingsView 的角色分配行里可单独指定。
- `draftSubAgentPersonas` 现用 `ROLES.filter(key!=='core')` 起草所有子角色 persona —— `ai_helper` 会被一并起草，无害；不特殊处理。

## C. 聊天逻辑（`postMessage` 当 `kind==='ai_model'`）

- **角色参数化**：postMessage 内令 `const role = session.kind === 'ai_model' ? 'ai_helper' : 'core'`：
  - persona：`role==='core'` 用 `getCorePersona(uid)`；否则用 `listProfiles(uid).find(p=>p.role===role)?.persona || getCorePersona(uid)`。
  - 模型调用：`defaultAiCall` 增参 `role`（默认 `'core'`），内部 `getModelForRole(uid, role)`；ai_model 房间传 `'ai_helper'`。
- **`KIND_FRAMING['ai_model']`**：`'用户在和你探讨本系统的 AI 模型与能力插件配置。你是「AI 模型顾问」：依据下方“当前配置”如实回答模型选择、各角色用哪个模型、报错排查、插件用途等问题；当用户想真正修改时，引导他点本房间标题栏的「🤖 AI 模型」或「🧩 能力插件」按钮去设置。你不直接修改配置，也不杜撰系统没有的模型/参数。'`
- **注入 `extraContext`**（仅 ai_model，且调用方未显式传 extraContext 时）：拼一段「当前配置」文本：
  - 各角色模型分配：遍历 `ROLES`，每行 `{label}：{provider}/{model}（auto|手动）`，取自 `getRoleAssignment(uid, role)`（mode/provider/model）+ `getModelForRole(uid, role)`（实际解析到的 provider/model，含回退）。
  - 已启用模型：`listConfigs(uid)` 里 enabled 的 provider 列表。
  - 插件：`plugins/service.ts` `listForUser(uid)`，列 `{name}：开/关`。
  - 拼成 `当前 AI 配置：\n角色模型：\n…\n已启用模型：…\n插件：…`。

## D. 前端房间标题按钮（与策略探讨一致）

- `HomeView` `title-actions` 内加 `<template v-if="active.kind === 'ai_model'">`，在 `🧹 清理` 之前：
  - `<button class="mini" @click="aiModelModalOpen = true">🤖 AI 模型</button>`
  - `<button class="mini" @click="pluginsModalOpen = true">🧩 能力插件</button>`
- 模板末尾（与现有 Modal 同处）加两个弹层：
  - `<Modal v-if="aiModelModalOpen" title="AI 模型" @close="aiModelModalOpen = false"><AiSettingsView /></Modal>`
  - `<Modal v-if="pluginsModalOpen" title="能力插件" @close="pluginsModalOpen = false"><PluginsView /></Modal>`
- 新增 `const aiModelModalOpen = ref(false)`、`const pluginsModalOpen = ref(false)`。`AiSettingsView`/`PluginsView` 已 import（现为 SETTINGS 组件），直接复用。
- 空房间引导：当 `active.kind==='ai_model'` 且无消息时，显示一句提示：「问我 AI 模型怎么选、各角色用哪个、报错怎么处理、插件干嘛用；要改配置点上方「🤖 AI 模型」「🧩 能力插件」。」（纯展示，无正文区/简介块）。

## E. 导航调整

- `SETTINGS` 中 `ai`、`plugins` 两项 `roles: 'both'` → `roles: 'admin'`：admin 仍从设置下拉进入；普通用户从「AI 模型探讨」房间进入。两边共用同一 `AiSettingsView`/`PluginsView`。

## 数据流

普通用户进「AI 模型探讨」房间 → 发问 → `postMessage` 以 `ai_helper` 角色（persona=ai_helper profile，模型=ai_helper 分配或回退 core）+ 注入「当前 AI 配置」上下文 → 顾问据实作答并引导点按钮 → 点 `🤖 AI 模型`/`🧩 能力插件` 开 Modal 实际修改。admin 走原设置导航。

## 错误处理 / 边界

- ai_helper 无模型（用户未配任何模型）→ `getModelForRole` 回退 core；core 也无 → 沿用现有 `NO_MODEL` 提示（postMessage 既有处理）。
- `listForUser`/`listConfigs` 异常 → extraContext 该段安静降级为空（沿用现有 try/catch 注入风格）。
- 老用户首次进入由 `ensureFixedRooms` 补建第 4 间；不影响既有 3 间。
- 顾问只读：prompt 明确不改配置、不杜撰；实际修改只经按钮 Modal。

## 范围 / 测试

- **后端 jest（`chat/service.test.ts`、`agent`/`ai` 相关）**：① `ensureFixedRooms` 建齐 4 间含 `ai_model`（存在、pinned=1、title='AI 模型探讨'）；② `'ai_helper'` 在 `ROLES` 与 `PROFILE_ROLES`，且 `getModelForRole(uid,'ai_helper')` 在无分配时回退 core；③ `postMessage` 对 `ai_model` 房间用 ai_helper 角色并注入「当前 AI 配置」——用注入的 `aiCall` 抓 prompt，断言含某已启用 provider/插件名或角色模型行。
- **前端无 runner** → `vue-tsc --noEmit` + 走查：普通用户有第 4 间「AI 模型探讨」，标题栏 `🤖 AI 模型`/`🧩 能力插件`/`🧹 清理`，点开各自 Modal 即原设置页内容；普通用户设置下拉不再有 AI 模型/能力插件；admin 设置下拉仍有；房间问答由顾问作答。

## 不在本次范围

- 顾问不通过工具调用修改任何配置（只答疑 + 引导）。
- 不重写 `AiSettingsView`/`PluginsView`（原样嵌入 Modal）。
- 不给 admin 增加聊天室 UI（admin 仍用设置导航）。
- 不改其它三个房间的行为。
