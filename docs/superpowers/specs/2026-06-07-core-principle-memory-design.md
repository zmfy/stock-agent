# 核心原则：变更记忆 + 对话框行为

日期：2026-06-07

## Context（背景）

agent 要"成长"——它必须记得**为什么**用户把核心原则改成了现在这样。当前实现里：
- 换模板/组合时会 `clearMessages` 清空 core_principle 会话（HomeView `applyCompose`），把"为什么改"的讨论一并销毁。
- core_principle 聊天的 prompt 只注入当前原则摘要 + 会话历史，不注入**版本变更历史**；所以一旦聊天被清，agent 就"忘了"原则的来龙去脉。
- 用户希望：每次进核心原则聊天框是**干净**的（清空旧聊天），但 agent 的**变更记忆不能丢**。

把"为什么改"的记忆从易失的聊天框，迁到**持久的版本记忆**（`rulebook_versions.note` 已存在），并注入到 agent 的 prompt —— 这样清空聊天框就安全了。

## Goals
- 核心原则每次变更（采纳提议 / 换模板组合）时，让 agent 总结一句"用户为什么这么改"，存入新版本的变更记忆。
- core_principle 聊天 prompt 注入最近版本变更历史，使 agent 始终"知道为什么"。
- 每次打开核心原则聊天框：硬清空旧消息；展示当前原则 + 最后更换日期。

## Non-goals
- 不改规则算法、不改提议/diff 逻辑本身（只在变更落库时补"理由总结"）。
- 不引入新的记忆表（复用 `rulebook_versions.note` + parent 链）。

## 设计

### 1. 变更记忆捕获（成长）
- 新增 `rulebook/memory.ts`（或 propose-service 内）函数 `summarizeChangeReason({ persona, discussion, changeDesc, aiCall }): Promise<string>`：用 core/review 角色 AI，输入=当时 core_principle 会话讨论文本 + 本次变更描述（diff 摘要 / 模板名），输出一句中文"用户为什么要这么改"。`aiCall` 可注入（测试 mock）。失败/超时 → 返回兜底文案。
- 落库点：
  - 采纳提议：`applyProposal(userId, proposal, versionLabel, sessionId?)` —— 若给 sessionId，取该会话 history 作 discussion，summarize → 作为新版本 `note`；否则用 proposal.note 兜底。
  - 换模板/组合：`applyComposedTemplates`/`applyTemplateAsVersion` 增加可选 `sessionId`，同理 summarize → `note`；兜底 "换入模板X"。
- 路由：`POST /api/rulebook/apply` body 增可选 `sessionId`；`POST /api/rulebook/apply-compose` 增可选 `sessionId`。前端采纳/换模板时带上当前 core_principle 会话 id。

### 2. 注入"变更记忆"到 agent
- `rulebook/service.ts` 加 `listVersionHistory(userId, limit=5)`：返回最近版本 `[{ version_label, created_at, note }]`（按 created_at desc）。
- `chat/service.ts` buildPrompt：当 `kind==='core_principle'`，extraContext 追加"原则演进记忆"块：
  ```
  原则演进记忆（最近变更，知道为什么是现在这样）：
  · V3.1（2026-06-07）：放宽 ROE 到 8，因为用户认为当前行情龙头稀缺…
  · V3.0（2026-06-05）：导入双系统基线…
  ```

### 3. 进入即清空 + 展示
- 前端 `openCorePrinciple()`：进入后 `chatApi.clearMessages(session.id)` 硬清空 + `messages.value=[]`。
- briefing（`buildCpBriefing`）顶部加一行「最后更换：YYYY-MM-DD」（来自当前激活版本 `created_at`）。
- 移除 `applyCompose` 里现有的 `clearMessages` 调用（清空改由"打开时"负责；变更记忆已落 note，不丢）。

### 数据模型
- 复用 `rulebook_versions.note`（已存在）。
- 若 `rulebook_versions` 无 `created_at` 列：`migrate()` 幂等补 `ALTER TABLE rulebook_versions ADD COLUMN created_at DATETIME`（老行为 NULL，前端展示兜底"—"）；新建表语句补 `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`。（实现前先 PRAGMA 确认是否已有。）

## Testing
- `summarizeChangeReason`：注入 mock aiCall，验证拼 prompt 正确、AI 失败走兜底。
- `listVersionHistory`：插入多版本，验证按时间倒序、limit、字段。
- buildPrompt 注入：core_principle 含"原则演进记忆"块，其它 kind 不含。
- applyProposal/applyComposedTemplates 带 sessionId 时新版本 note = summarize 结果（mock）。
- 前端：vue-tsc + 冒烟（进入清空、briefing 显示最后更换日期、采纳/换模板带 sessionId）。
- 全套测试保持绿。

## 默认决定（已确认 / 可改）
- 变更时让 agent 总结理由（非机械复用）；进入硬清空旧聊天；prompt 注入最近 5 个版本变更；created_at 缺则迁移补上。
