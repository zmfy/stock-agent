# 核心原则变更记忆 + 对话框清空/展示 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 核心原则变更时让 agent 总结"为什么改"存进版本记忆，并注入 core_principle 聊天 prompt；进入聊天框硬清空旧消息并展示当前原则+最后更换日期。

**Architecture:** 复用 `rulebook_versions.note`（已存在）作为"变更记忆"；变更落库时调一次 AI 总结理由写入 note；`chat/service` 给 core_principle 注入最近版本变更历史；前端进入时 `clearMessages` + briefing 展示最后更换日期。

**Tech Stack:** Node/Express+TS（jest，tmp DATA_DIR+require，AI 调用可注入 mock）；Vue3（vue-tsc + 冒烟）。`rulebook_versions` 已有 `created_at`（无需迁移）。

**约定：** `RulebookVersion` 含 `version_label, created_at, note`。AI 调用沿用 propose-service 里 `proposeChange` 的方式（`getModelForRole(userId,'review')` + ai manager），summarize 函数以 `aiCall` 注入便于测试。

---

## Task 1: 后端 — summarizeChangeReason + listVersionHistory（TDD）

**Files:** Create `backend/src/rulebook/memory.ts`；Modify `backend/src/rulebook/service.ts`（加 `listVersionHistory`）；Test `backend/src/rulebook/memory.test.ts`

- [ ] **Step 1: 失败测试**

`backend/src/rulebook/memory.test.ts`:
```ts
import path from 'path'; import os from 'os'; import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cpmem-'));
const mem = require('./memory');

it('summarizeChangeReason 拼讨论+变更描述、调 aiCall', async () => {
  let seen = '';
  const aiCall = async (p: string) => { seen = p; return '因为用户认为龙头稀缺，放宽 ROE 门槛'; };
  const r = await mem.summarizeChangeReason({ persona: '来财', discussion: '用户：ROE 10 太严\n助手：可放宽', changeDesc: 'A_roe_ttm 10→8', aiCall });
  expect(r).toContain('放宽 ROE');
  expect(seen).toContain('A_roe_ttm 10→8');
  expect(seen).toContain('ROE 10 太严');
});

it('summarizeChangeReason: aiCall 失败走兜底文案', async () => {
  const r = await mem.summarizeChangeReason({ persona: '', discussion: '', changeDesc: '换入模板：价值质量', aiCall: async () => { throw new Error('x'); } });
  expect(r).toBe('换入模板：价值质量');
});
```

- [ ] **Step 2: 跑 → FAIL**

Run: `cd backend && npx jest src/rulebook/memory.test.ts -i` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`backend/src/rulebook/memory.ts`:
```ts
export interface ReasonInput {
  persona: string;
  discussion: string;      // core_principle 会话讨论文本（可空）
  changeDesc: string;      // 本次变更描述：diff 摘要 / 模板名（兜底用）
  aiCall: (prompt: string) => Promise<string>;
}

export async function summarizeChangeReason(input: ReasonInput): Promise<string> {
  const prompt =
    `你是${input.persona || '股票助手'}。用户刚刚调整了核心选股/操作原则。\n` +
    `本次变更：${input.changeDesc}\n` +
    (input.discussion ? `相关讨论：\n${input.discussion}\n` : '') +
    `请用一句话（不超过60字）总结"用户为什么要这么改"，只输出这句话。`;
  try {
    const out = (await input.aiCall(prompt)).trim();
    return out || input.changeDesc;
  } catch {
    return input.changeDesc;
  }
}
```

`backend/src/rulebook/service.ts` 加（`listVersions` 已存在，返回 `RulebookVersion[]`）：
```ts
export function listVersionHistory(userId: string, limit = 5): Array<{ version_label: string; created_at: string; note: string }> {
  return (getDb()
    .prepare('SELECT version_label, created_at, note FROM rulebook_versions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit) as any[]);
}
```

- [ ] **Step 4: 跑 → PASS + 全套**

Run: `cd backend && npx jest src/rulebook/memory.test.ts -i && npx jest` → 绿。

- [ ] **Step 5: Commit**
```bash
git add backend/src/rulebook/memory.ts backend/src/rulebook/memory.test.ts backend/src/rulebook/service.ts
git commit -m "feat(rulebook): summarizeChangeReason + listVersionHistory（变更记忆）"
```

---

## Task 2: 后端 — 变更落库写入"理由"到 note（TDD）

**Files:** Modify `backend/src/rulebook/propose-service.ts`（`applyProposal` 加 sessionId+summarize）、`backend/src/rulebook/service.ts`（`applyComposedTemplates`/`applyTemplateAsVersion` 加 sessionId+summarize）、`backend/src/routes/rulebook.ts`（apply/apply-compose/apply-template 透传 sessionId）；Test `backend/src/rulebook/propose-service.test.ts`

- [ ] **Step 1: 失败测试**

在 `backend/src/rulebook/propose-service.test.ts` 加（先确保有 active 版本 + 一个 core_principle 会话与消息；参照该测试文件已有的 setup）：
```ts
it('applyProposal 带 sessionId 时把 AI 总结的理由写进 note', async () => {
  const svc = require('./service');
  const ps = require('./propose-service');
  const chat = require('../chat/service');
  // 准备 active 基线
  svc.instantiateBaseline?.(USER) ?? svc.applyTemplateAsVersion(USER, 'value-quality');
  const sid = chat.createSession(USER, 'core_principle', null, '讨论').id;
  chat.addMessageForTest ? chat.addMessageForTest(sid, 'user', 'ROE 太严') : null;
  const active = svc.getActive(USER);
  const proposal = { persona: active.version.persona, note: '机械理由', gates: active.gates, softRules: active.softRules, positionRules: active.positionRules };
  const out = await ps.applyProposal(USER, proposal, 'V9.9', sid, async () => '因为龙头稀缺要放宽');
  expect(svc.getActive(USER).version.note).toContain('龙头稀缺');
});
```
（注：若 `applyProposal` 现为同步，本任务改为 async。`addMessageForTest`/会话准备按该文件实际可用 API 调整；关键断言是新版本 note = AI 理由。）

- [ ] **Step 2: 跑 → FAIL**

Run: `cd backend && npx jest src/rulebook/propose-service.test.ts -t "写进 note" -i` → FAIL。

- [ ] **Step 3: 实现**

`propose-service.ts` `applyProposal` 改为 async + 接 `sessionId?` 与可注入 `aiCall?`：
```ts
export async function applyProposal(userId: string, proposal: ProposalPayload, versionLabel: string, sessionId?: string, aiCall?: (p: string) => Promise<string>): Promise<FullRulebook> {
  const active = getActive(userId);
  let note = proposal.note || '规则调整';
  if (sessionId) {
    const discussion = getMessages(userId, sessionId).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
    note = await summarizeChangeReason({ persona: active?.version.persona || '', discussion, changeDesc: proposal.note || '规则调整', aiCall: aiCall || ((p) => reasonAiCall(userId, p)) });
  }
  const created = createVersion(userId, { versionLabel, persona: proposal.persona || active?.version.persona || '', note, parentVersionId: active?.version.id ?? null, author: 'agent', gates: proposal.gates, softRules: proposal.softRules, positionRules: proposal.positionRules });
  activateVersion(userId, created.version.id);
  return { ...created, version: { ...created.version, is_active: 1 } };
}
```
- import `summarizeChangeReason` from `./memory`、`getMessages` from `../chat/service`。
- `reasonAiCall(userId, prompt)`：复用 `proposeChange` 调 AI 的方式（`getModelForRole(userId,'review')` + ai manager `chat`），返回字符串 raw。把 `proposeChange` 里现成的 AI 调用抽一个内部 helper 复用即可。

`service.ts` `applyComposedTemplates`/`applyTemplateAsVersion` 同样改 async + 接 `sessionId?`、`aiCall?`：变更描述分别用现有 note 文案（"组合多套系统…"/"换入模板X"）作 `changeDesc`，有 sessionId 则 summarize 覆盖 note。

`routes/rulebook.ts`：
- `/apply` body 解析增 `sessionId?: string`，`await applyProposal(userId, proposal, versionLabel, sessionId)`（route handler 改 async/await）。
- `/apply-compose`、`/apply-template` 同理透传 `sessionId`，`await svc.applyComposedTemplates(userId, keys, sessionId)` 等。

- [ ] **Step 4: 跑 → PASS + 全套 + tsc**

Run: `cd backend && npx jest -i && npx tsc --noEmit` → 全绿、tsc 干净（注意 applyProposal 等改 async，更新所有 await 调用点）。

- [ ] **Step 5: Commit**
```bash
git add backend/src/rulebook/propose-service.ts backend/src/rulebook/service.ts backend/src/routes/rulebook.ts backend/src/rulebook/propose-service.test.ts
git commit -m "feat(rulebook): 变更落库时 AI 总结理由写入版本 note（apply/apply-compose/apply-template 接 sessionId）"
```

---

## Task 3: 后端 — core_principle prompt 注入变更记忆（TDD）

**Files:** Modify `backend/src/chat/service.ts`（buildPrompt 前的 core_principle extra 块）；Test `backend/src/chat/service.test.ts` 或 `routes/chat.test.ts`

- [ ] **Step 1: 失败测试**

在 chat 测试里（注入 aiCall 捕获 prompt）验证 core_principle 会话发消息时 prompt 含"原则演进记忆"：
```ts
it('core_principle 的 prompt 注入版本变更记忆', async () => {
  const svc = require('./service');
  const rb = require('../rulebook/service');
  rb.applyTemplateAsVersion(USER, 'value-quality');           // 造一个版本(带 note)
  const sid = svc.createSession(USER, 'core_principle', null, '讨论').id;
  let seen = '';
  await svc.postMessage(USER, sid, '聊聊', { aiCall: async (p: string) => { seen = p; return { raw: 'ok' }; } });
  expect(seen).toContain('原则演进记忆');
});
```

- [ ] **Step 2: 跑 → FAIL**

Run: `cd backend && npx jest -t "注入版本变更记忆" -i` → FAIL。

- [ ] **Step 3: 实现**

`chat/service.ts` 在 `if (!extra && session.kind === 'core_principle')` 块内，构造 extra 时追加变更记忆（import `listVersionHistory` from `../rulebook/service`）：
```ts
  if (!extra && session.kind === 'core_principle') {
    const rb = getActive(userId);
    if (rb) {
      const g = rb.gates.map((x) => `${x.system}:${x.label} ${x.op}${x.threshold ?? ''}${x.unit}${x.veto ? '(否决)' : ''}`).join('；');
      const hist = listVersionHistory(userId, 5)
        .map((v) => `· ${v.version_label}（${(v.created_at || '').slice(0, 10)}）：${v.note || '（无说明）'}`)
        .join('\n');
      extra = `当前核心原则【${rb.version.version_label}】人设：${rb.version.persona}\n硬门槛：${g}\n\n原则演进记忆（最近变更，知道为什么是现在这样）：\n${hist}`;
    }
  }
```

- [ ] **Step 4: 跑 → PASS + 全套**

Run: `cd backend && npx jest -i` → 绿。

- [ ] **Step 5: Commit**
```bash
git add backend/src/chat/service.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): core_principle prompt 注入最近版本变更记忆"
```

---

## Task 4: 前端 — 进入清空 + 最后更换日期 + 采纳/换模板带 sessionId

**Files:** Modify `frontend/src/views/HomeView.vue`、`frontend/src/api/rulebook.ts`

- [ ] **Step 1: api 带 sessionId**

`frontend/src/api/rulebook.ts`：`apply` 与 `applyCompose` 增加可选 `sessionId`：
```ts
apply: (versionLabel: string, proposal: any, sessionId?: string) => api.post('/rulebook/apply', { versionLabel, proposal, sessionId }),
applyCompose: (keys: string[], sessionId?: string) => api.post('/rulebook/apply-compose', { keys, sessionId }),
```

- [ ] **Step 2: HomeView 改动**

(a) `openCorePrinciple()`：进入后硬清空：
```ts
async function openCorePrinciple() {
  let s = sessions.value.find((x) => x.kind === 'core_principle');
  if (!s) {
    const id = (await chatApi.createSession('core_principle', null, '核心原则探讨')).data.data.id;
    await loadSessions();
    s = sessions.value.find((x) => x.id === id);
  }
  if (s) {
    await chatApi.clearMessages(s.id);   // 每次进入硬清空旧聊天（变更记忆已存版本 note，不丢）
    await open(s);
    messages.value = [];
  }
}
```
(b) `applyProposal()`：apply 时带上当前会话 id：`await rulebookApi.apply(label, proposal.value.proposal, active.value?.id);`
(c) `applyCompose()`：`await rulebookApi.applyCompose(orderedKeys.value, active.value?.id);` 并**删除**该函数里现有的 `await chatApi.clearMessages(active.value.id)` 与 `messages.value = []`（清空交给"打开时"；保留换入后的提示文案）。
(d) `buildCpBriefing(rb)`：在版本标题行后加"最后更换"：
```ts
  const changed = rb.version.created_at ? `（最后更换：${String(rb.version.created_at).slice(0, 10)}）` : '';
  // 把首行改为：`【当前使用的核心原则 ${rb.version.version_label}】${changed}\n`
```
（确认 `FullRulebook.version` 类型含 `created_at`；前端类型若缺则补 `created_at?: string`。）

- [ ] **Step 3: 验证**

Run: `cd frontend && npx vue-tsc --noEmit` → 0 errors。冒烟：进核心原则聊天框旧消息被清；briefing 显示「最后更换：YYYY-MM-DD」；采纳/换模板后版本 note 为 AI 总结的理由。

- [ ] **Step 4: Commit**
```bash
git add frontend/src/views/HomeView.vue frontend/src/api/rulebook.ts
git commit -m "feat(ui): 进核心原则聊天框硬清空 + 展示最后更换日期 + 采纳/换模板带 sessionId"
```

---

## Task 5: 端到端验证

- [ ] **Step 1: 重建 + 全套**
```bash
docker compose up -d --build
cd backend && npx jest
cd ../frontend && npx vue-tsc --noEmit
```
Expected: 后端全绿；前端 0 errors。

- [ ] **Step 2: 冒烟（real AI，可选）**
在 UI：核心原则讨论里聊几句 → 采纳提议 → 新版本 note 应为一句"为什么改"；退出再进核心原则聊天框 → 旧消息已清、briefing 显示最后更换日期；继续聊天时 agent 能引用"原则演进记忆"。

---

## Self-Review
- **Spec 覆盖**：变更记忆捕获(Task1/2)、注入 prompt(Task3)、进入清空+最后更换日期+带 sessionId(Task4)、e2e(Task5) —— 均有任务。created_at 已存在，无迁移任务（正确）。
- **Placeholder**：无；每步含真实代码。
- **类型一致**：`summarizeChangeReason(ReasonInput{persona,discussion,changeDesc,aiCall})`、`listVersionHistory→{version_label,created_at,note}[]`、`applyProposal/applyComposedTemplates/applyTemplateAsVersion` 改 async 且新增 `sessionId?,aiCall?`、路由透传 sessionId、前端 api `apply/applyCompose` 带 sessionId —— 贯穿一致。注意 async 化后更新所有 await 调用点（routes + 任何测试）。
