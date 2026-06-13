# 「AI 模型探讨」聊天室 + AI 顾问子 agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第 4 个固定聊天室「AI 模型探讨」，把「AI 模型」「能力插件」设置以标题栏按钮搬进该房间，并加一个只答疑、不改配置的子 agent `ai_helper` 结合当前配置作答。

**Architecture:** 后端加 `ai_helper` 角色 + `ai_model` 固定房间，`postMessage` 按房间用 `ai_helper` 角色（persona+模型，回退 core）并注入「当前 AI 配置」上下文；前端把两设置页入口以标题按钮+Modal 复用进新房间，普通用户设置导航移除这两项（admin 保留）。

**Tech Stack:** Express/TS + better-sqlite3 + jest（后端）；Vue 3 + Vite（前端，无 runner → `vue-tsc --noEmit` 把关）。

Spec：`docs/superpowers/specs/2026-06-13-ai-model-chat-room-design.md`。

测试命令：后端 `cd backend && npm test`（当前 346 绿）；前端 `cd frontend && npx vue-tsc --noEmit`（exit 0）。

> **约定**：本仓库**仅当用户说「提交」时才 commit**。各 Task 的「Commit」步骤先写好 message 但**不执行**，攒到用户放行再统一落库。

---

## 文件结构（改动地图）

**后端**
- Modify `backend/src/ai/roles.ts` — `ROLES` 加 `ai_helper`。
- Modify `backend/src/agent/profiles-service.ts` — `PROFILE_ROLES` 加 `ai_helper`。
- Modify `backend/src/ai/service.test.ts` — `ai_helper` 模型回退 core 的测试。
- Modify `backend/src/chat/service.ts` — `ai_model` 固定房间 + 角色参数化 + `buildAiConfigContext` 注入。
- Modify `backend/src/chat/service.test.ts` — 4 房间 ensure + ai_model 注入测试。

**前端**
- Modify `frontend/src/views/HomeView.vue` — 导航 roles、`FIXED_ORDER`、图标、sessionLabel、标题按钮、两个 Modal、空房间引导。

---

## Task 1: 后端新增 `ai_helper` 角色 + 模型回退测试

**Files:**
- Modify: `backend/src/ai/roles.ts`
- Modify: `backend/src/agent/profiles-service.ts:8`（`PROFILE_ROLES`）
- Test: `backend/src/ai/service.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `backend/src/ai/service.test.ts` 末尾追加（该文件已有 DATA_DIR/DB 初始化与 `require('./service')`；沿用其既有 `svc` 或 require 名，下例用 `require`）：

```ts
describe('ai_helper 角色', () => {
  const roles = require('./roles');
  const profiles = require('../agent/profiles-service');
  it('ai_helper 在 ROLES 与 PROFILE_ROLES 中', () => {
    expect(roles.ROLES.some((r: any) => r.key === 'ai_helper')).toBe(true);
    expect(profiles.PROFILE_ROLES).toContain('ai_helper');
  });
  it('getModelForRole(ai_helper) 回退到 core 的解析结果', () => {
    const s = require('./service');
    expect(s.getModelForRole('u-aih', 'ai_helper')).toEqual(s.getModelForRole('u-aih', 'core'));
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest ai/service -i -t "ai_helper"`。Expected: FAIL（ROLES/PROFILE_ROLES 无 ai_helper）。

- [ ] **Step 3: 实现** — `backend/src/ai/roles.ts` 的 `ROLES` 数组末尾（`validation` 那行之后）加：
```ts
  { key: 'ai_helper', label: 'AI 模型顾问', prefer: 'balanced', hint: '答疑 AI 模型选择/角色分配/报错排查/插件用途，引导用户去「AI 模型」「能力插件」设置，不替用户改配置' },
```
`backend/src/agent/profiles-service.ts:8` 的 `PROFILE_ROLES` 加 `'ai_helper'`：
```ts
export const PROFILE_ROLES = ['core', 'data', 'analysis', 'qualitative', 'review', 'validation', 'ai_helper'] as const;
```

- [ ] **Step 4: 运行确认通过** — `cd backend && npx jest ai/service -i -t "ai_helper"`。Expected: PASS。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/ai/roles.ts backend/src/agent/profiles-service.ts backend/src/ai/service.test.ts
git commit -m "feat(ai): 新增 ai_helper 角色(AI 模型顾问)——模型未分配时回退 core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端 `ai_model` 固定房间

**Files:**
- Modify: `backend/src/chat/service.ts:17-42`（ChatKind / FIXED_ROOM_KINDS / FIXED_ROOM_TITLES / KIND_FRAMING）
- Test: `backend/src/chat/service.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `backend/src/chat/service.test.ts` 末尾追加：

```ts
describe('ai_model 固定房间', () => {
  it('ensureFixedRooms 建齐含 AI 模型探讨', () => {
    const svc2 = require('./service');
    const sessions = svc2.ensureFixedRooms('u-fixed4');
    const room = sessions.find((s: any) => s.kind === 'ai_model');
    expect(room).toBeTruthy();
    expect(room.pinned).toBe(1);
    expect(room.title).toBe('AI 模型探讨');
    // 仍建齐其它三间
    for (const k of ['core_principle', 'daily', 'screen']) {
      expect(sessions.some((s: any) => s.kind === k)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest chat/service -i -t "ai_model 固定房间"`。Expected: FAIL（无 ai_model 房间）。

- [ ] **Step 3: 实现** — 改 `backend/src/chat/service.ts`：

`ChatKind`（约 17 行）加 `'ai_model'`：
```ts
export type ChatKind = 'general' | 'core_principle' | 'stock' | 'morning' | 'evening' | 'screen' | 'daily' | 'ai_model';
```
`FIXED_ROOM_KINDS`（约 19 行）：
```ts
export const FIXED_ROOM_KINDS = ['core_principle', 'daily', 'screen', 'ai_model'] as const satisfies ChatKind[];
```
`FIXED_ROOM_TITLES`（约 20-24 行）加一项：
```ts
const FIXED_ROOM_TITLES: Record<typeof FIXED_ROOM_KINDS[number], string> = {
  core_principle: '策略探讨',
  daily: '操盘和复盘',
  screen: '选股讨论',
  ai_model: 'AI 模型探讨',
};
```
`KIND_FRAMING`（约 34-42 行）加一项：
```ts
  ai_model: '用户在和你探讨本系统的 AI 模型与能力插件配置。你是「AI 模型顾问」：依据下方“当前配置”如实回答模型选择、各角色用哪个模型、报错排查、插件用途等问题；当用户想真正修改时，引导他点本房间标题栏的「🤖 AI 模型」或「🧩 能力插件」按钮去设置。你不直接修改配置，也不杜撰系统没有的模型/参数。',
```
> `routes/chat.ts` 的可创建 `KINDS` **不**加 `ai_model`（与 `daily` 一致，仅 ensure 建）；在该行注释里补一句「'ai_model' 同 daily：仅 ensure 建」。无功能代码改动。

- [ ] **Step 4: 运行确认通过 + 回归** — `cd backend && npx jest chat/service -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/chat/service.ts backend/src/chat/service.test.ts backend/src/routes/chat.ts
git commit -m "feat(chat): 新增第 4 个固定房间 ai_model「AI 模型探讨」

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端 ai_model 房间用 ai_helper 角色 + 注入当前配置

**Files:**
- Modify: `backend/src/chat/service.ts`（imports、`defaultAiCall`、`postMessage`、新增 `buildAiConfigContext`）
- Test: `backend/src/chat/service.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `backend/src/chat/service.test.ts` 末尾追加：

```ts
describe('ai_model 房间用 ai_helper 角色并注入当前配置', () => {
  it('postMessage 注入「当前 AI 配置」且带顾问 framing', async () => {
    const svc3 = require('./service');
    const sid = svc3.createSession('u-aim', 'ai_model', null, 'AI 模型探讨');
    let captured = '';
    await svc3.postMessage('u-aim', sid, 'deepseek 和 qwen 哪个适合分析？', {
      aiCall: async (p: string) => { captured = p; return '建议……要改点上方按钮'; },
    });
    expect(captured).toContain('当前 AI 配置');
    expect(captured).toContain('AI 模型顾问'); // KIND_FRAMING 注入
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest chat/service -i -t "ai_helper 角色并注入"`。Expected: FAIL（无「当前 AI 配置」注入）。

- [ ] **Step 3: 实现** — 改 `backend/src/chat/service.ts`：

① import：`getCorePersona` 那行改为同时引入 `listProfiles`（来自 `../agent/profiles-service`）。文件顶部 import 区再加：
```ts
import { getModelForRole, getRoleAssignment, listConfigs } from '../ai/service';
import { ROLES } from '../ai/roles';
import { listForUser } from '../plugins/service';
```
> 注意：`getModelForRole` 若已被 import（现有 `defaultAiCall` 用到它来自 `../ai/service`，确认现有 import 行——若已含 `getModelForRole` 则只补 `getRoleAssignment, listConfigs`，勿重复）。

② 新增 `buildAiConfigContext`（放在 `defaultAiCall` 之后）：
```ts
// 给「AI 模型探讨」房间的顾问注入当前配置摘要（不含任何密钥）。
function buildAiConfigContext(userId: string): string {
  const parts: string[] = [];
  try {
    const roleLines = ROLES.map((r) => {
      const m = getModelForRole(userId, r.key);
      const a = getRoleAssignment(userId, r.key);
      const mode = a?.mode === 'manual' ? '手动' : '自动';
      const model = m ? `${m.provider}/${m.model}` : '未配置';
      return `· ${r.label}：${model}（${mode}）`;
    }).join('\n');
    parts.push(`角色模型分配：\n${roleLines}`);
  } catch { /* 降级 */ }
  try {
    const enabled = listConfigs(userId).filter((c: any) => c.enabled).map((c: any) => c.provider);
    parts.push(`已启用模型 provider：${enabled.length ? enabled.join('、') : '（无）'}`);
  } catch { /* 降级 */ }
  try {
    const plugs = listForUser(userId).map((p: any) => `${p.label}：${p.enabled ? '开' : '关'}`);
    parts.push(`能力插件：\n${plugs.join('\n')}`);
  } catch { /* 降级 */ }
  return `当前 AI 配置：\n${parts.join('\n\n')}`;
}
```

③ `defaultAiCall` 加 `role` 参数（默认 'core'）：
```ts
async function defaultAiCall(userId: string, prompt: string, role = 'core'): Promise<{ raw: string; provider: string; model: string }> {
  const cfg = getModelForRole(userId, role);
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
  const raw = await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 1500, acct);
  return { raw, provider: cfg.provider, model: cfg.model };
}
```

④ `postMessage` 内：把 `const persona = getCorePersona(userId);` 改为按角色取，并在 extra 注入分支加 ai_model 分支，aiCall 传 role。具体：
- 紧接 `const history = ...` 后，替换 persona 行为：
```ts
  const role = session.kind === 'ai_model' ? 'ai_helper' : 'core';
  const persona = role === 'core'
    ? getCorePersona(userId)
    : (listProfiles(userId).find((p) => p.role === role)?.persona || getCorePersona(userId));
```
- 在 `if (!extra && session.kind === 'core_principle') {...}` 分支**之后**、行情注入块**之前**，加：
```ts
  if (!extra && session.kind === 'ai_model') {
    extra = buildAiConfigContext(userId);
  }
```
- 把 `const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));` 改为：
```ts
  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p, role));
```

- [ ] **Step 4: 运行确认通过 + 回归** — `cd backend && npx jest chat/service -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/chat/service.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): ai_model 房间用 ai_helper 角色作答并注入当前 AI 配置摘要

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前端房间注册 + 导航调整

**Files:**
- Modify: `frontend/src/views/HomeView.vue`（SETTINGS roles、FIXED_ORDER、图标、sessionLabel）

- [ ] **Step 1: 导航 roles 改 admin** — `SETTINGS` 数组里把 `ai`、`plugins` 两项的 `roles: 'both'` 改为 `roles: 'admin'`：
```ts
  { key: 'ai', label: 'AI 模型', icon: '🤖', comp: AiSettingsView, roles: 'admin' },
  { key: 'plugins', label: '能力插件', icon: '🧩', comp: PluginsView, roles: 'admin' },
```

- [ ] **Step 2: FIXED_ORDER + 图标 + sessionLabel** —
`FIXED_ORDER`（约 `const FIXED_ORDER: ChatKind[] = ['core_principle', 'daily', 'screen'];`）改为：
```ts
const FIXED_ORDER: ChatKind[] = ['core_principle', 'daily', 'screen', 'ai_model'];
```
图标表（`const icons: Record<ChatKind, string> = {...}`）加 `ai_model: '🤖'`。
`sessionLabel`（连续的 `if (s.kind === 'core_principle') return '策略探讨';` 等）加一行：
```ts
  if (s.kind === 'ai_model') return 'AI 模型探讨';
```
> 这些符号位置可用 `grep -n "FIXED_ORDER\|const icons\|sessionLabel\|s.kind === 'screen'" HomeView.vue` 定位。`ChatKind` 类型从 api/chat 引入，已含 `ai_model`（前端类型若独立维护，需同步加 'ai_model'——先 `grep -n "type ChatKind" frontend/src` 确认；若前端有独立 ChatKind 联合类型，补上 'ai_model'）。

- [ ] **Step 3: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 4: Commit（待放行）**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): 注册 ai_model 固定房间(序/图标/标题);AI模型·能力插件导航改 admin 专属

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 前端房间标题按钮 + 两个 Modal + 空房间引导

**Files:**
- Modify: `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 标题按钮** — 在 `title-actions` 内、`🧹 清理` 按钮**之前**（screen 的 `<template v-if="active.kind === 'screen'">` 块之后）加：
```vue
                  <template v-if="active.kind === 'ai_model'">
                    <button class="mini" @click="aiModelModalOpen = true">🤖 AI 模型</button>
                    <button class="mini" @click="pluginsModalOpen = true">🧩 能力插件</button>
                  </template>
```

- [ ] **Step 2: 两个 Modal** — 在模板末尾、现有 `<Modal v-if="tplOpen" ...>` 弹层附近加：
```vue
    <Modal v-if="aiModelModalOpen" title="AI 模型" @close="aiModelModalOpen = false">
      <AiSettingsView />
    </Modal>
    <Modal v-if="pluginsModalOpen" title="能力插件" @close="pluginsModalOpen = false">
      <PluginsView />
    </Modal>
```

- [ ] **Step 3: refs** — `<script setup>` 内（`tplOpen` ref 旁）加：
```ts
const aiModelModalOpen = ref(false);
const pluginsModalOpen = ref(false);
```
> `AiSettingsView`、`PluginsView` 已 import（现为 SETTINGS 的 comp），无需再 import。

- [ ] **Step 4: 空房间引导** — 在消息列表 `<div class="msgs" ...>` 内、`v-for="m in messages"` **之前**加一条仅 ai_model 空房显示的提示：
```vue
                <div v-if="active?.kind === 'ai_model' && !messages.length" class="msg assistant">
                  <div class="bubble">问我 AI 模型怎么选、各角色用哪个、报错怎么处理、插件干嘛用；要改配置点上方「🤖 AI 模型」「🧩 能力插件」。</div>
                </div>
```

- [ ] **Step 5: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 6: 走查（dev）** — `cd frontend && npm run dev`，普通用户登录：
  1. 左侧固定房间多出「AI 模型探讨」（🤖、置顶、不可删）。
  2. 进该房间：标题栏 `🤖 AI 模型`/`🧩 能力插件`/`🧹 清理`；点前两个分别弹出原 AI 模型 / 能力插件设置页。
  3. 空房间显示引导语；发问后由顾问作答（依赖已配模型）。
  4. 普通用户「设置」下拉**不再有** AI 模型/能力插件；admin 登录设置下拉**仍有**。

- [ ] **Step 7: Commit（待放行）**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): AI模型探讨房间标题按钮(🤖AI模型/🧩能力插件 Modal)+空房引导

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 端到端验证（实现完成后）

1. `cd backend && npm test` → 全绿（346 + 新增）。
2. `cd frontend && npx vue-tsc --noEmit` → exit 0。
3. `npm run dev` 走查 Task 5 Step 6 四项。

## 风险 / 注意

- `getModelForRole(uid,'ai_helper')` 依赖现有「非 core 回退 core」逻辑（service.ts:281）；若未来改了该回退，需给 ai_helper 显式兜底。
- `AiSettingsView`/`PluginsView` 原为设置面板组件，嵌入 Modal 直接复用；若它们内部假设了某些父级布局/路由，走查时确认显示正常（理论上自包含）。
- 顾问只读：prompt 已声明不改配置；实际修改仅经 Modal 按钮。注入的配置摘要不含密钥。
- 老用户首次进入由 `ensureFixedRooms` 补建第 4 间。
