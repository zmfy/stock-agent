# 「历史分析」聊天室（合并策略历史 + 分析历史）Design

> 新增第 5 个固定聊天室「历史分析」：把「策略历史」「分析历史」两个设置页的入口以标题栏按钮（与 AI 模型探讨一致）搬进该房间；聊天复用主 agent「来财」(core)，并注入最近策略历史 + 分析报告摘要作上下文。

最后更新：2026-06-13。仓库：`github.com/zmfy/stock-agent`。

## 背景（现状）

- 固定房间 4 个：`chat/service.ts` `FIXED_ROOM_KINDS = ['ai_model','core_principle','daily','screen']`（前端 `FIXED_ORDER` 控制顺序）。`ensureFixedRooms` 幂等建齐并置顶；`routes/chat.ts` 可创建 `KINDS` 不含 `daily`/`ai_model`（仅 ensure 建）。
- AI 模型探讨房间已确立模式：标题栏按钮（`<template v-if="active.kind === 'ai_model'">` 两个 `mini` 按钮）+ `<Modal v-if="xOpen">` 包设置视图 + 导航移除对应项。
- 设置导航 `SETTINGS`：`strategy_history`(StrategyHistoryView, `roles:'user'`)、`analysis`(AnalysisView, `roles:'user'`)；`account` 项用 `hidden: true` 从菜单隐藏但保留在数组（供组件解析）。`settingsMenu` 过滤 `!s.hidden && (roles 匹配)`。
- 聊天 `postMessage`：默认用 core 角色 + `getCorePersona`；按 kind 注入 `extraContext`。`defaultAiCall(userId, prompt, role='core')` 已参数化（AI 模型探讨那次改的）。
- 取数：`strategy/service.ts` `listStrategyHistory(userId, limit=120)` → `{date, phase, content, created_at, updated_at}`；`analysis/report-service.ts` `listReports(userId)` → `{id, stock_code, stock_name, one_liner, …, created_at}`。

## A. 新固定房间 `history`

### 后端 `chat/service.ts`
- `ChatKind` 增加 `'history'`。
- `FIXED_ROOM_KINDS` 增加 `'history'`（数组顺序不影响展示，前端 `FIXED_ORDER` 决定顺序）。
- `FIXED_ROOM_TITLES['history'] = '历史分析'`。
- `KIND_FRAMING['history']`：`'用户在和你回顾历史。结合下方“历史摘要”（最近的策略预判/盘中/复盘记录与个股分析报告），与用户讨论过往策略对错、个股分析结论与经验总结。要看明细可点本房间标题栏的「🗂 策略历史」「📊 分析历史」。基于已有记录作答，不杜撰没发生过的历史。'`

### `routes/chat.ts`
- 可创建 `KINDS` **不**加 `history`（与 daily/ai_model 一致，仅 ensure 建）；注释同步。

### 前端 `HomeView.vue` / `api/chat.ts`
- `api/chat.ts` `ChatKind` 增加 `'history'`。
- `FIXED_ORDER`：在末尾加 `'history'` → `['ai_model','core_principle','daily','screen','history']`。
- 图标表加 `history: '🗂'`；`sessionLabel`/标题映射「历史分析」。

## B. 聊天：复用主 agent「来财」(core) + 注入历史摘要

- `postMessage` 对 `history` 房间用现有 core 角色（无需新角色；`role` 推导：`ai_model→ai_helper`，其余含 `history` 均 `core`，无需改 role 推导逻辑）。
- 在 `postMessage` 的 extra 注入链里（`ai_model` 分支旁）加 `history` 分支：`if (!extra && session.kind === 'history') extra = buildHistoryContext(userId);`
- 新增 `buildHistoryContext(userId)`（chat/service.ts）：
  - 策略历史：`listStrategyHistory(userId, 8)`，每条 `{北京日期} {阶段中文} {内容首行/前 40 字}`。阶段映射 `prejudge→预判, intraday→盘中, review→复盘, holiday→休市`。
  - 分析报告：`listReports(userId).slice(0, 8)`，每条 `{stock_name||code} {code}：{one_liner}（{created_at 前 10 位}）`。
  - 拼 `历史摘要：\n最近策略：\n…\n最近个股分析：\n…`；都为空时给「（暂无历史记录）」。
  - try/catch 安静降级（任一段失败不影响其余）。

## C. 标题按钮 + 两个 Modal（与 AI 模型探讨一致）

- `title-actions` 内、`🧹 清理` **之前**加：
```vue
                  <template v-if="active.kind === 'history'">
                    <button class="mini" @click="strategyHistOpen = true">🗂 策略历史</button>
                    <button class="mini" @click="analysisHistOpen = true">📊 分析历史</button>
                  </template>
```
- 模板末尾加两个 Modal：
```vue
    <Modal v-if="strategyHistOpen" title="策略历史" @close="strategyHistOpen = false"><StrategyHistoryView /></Modal>
    <Modal v-if="analysisHistOpen" title="分析历史" @close="analysisHistOpen = false"><AnalysisView /></Modal>
```
- 新增 `const strategyHistOpen = ref(false)`、`const analysisHistOpen = ref(false)`。`StrategyHistoryView`、`AnalysisView` 已 import（现为 SETTINGS 组件），直接复用。

## D. 导航调整

- `SETTINGS` 里 `strategy_history`、`analysis` 两项加 `hidden: true`（同 `account` 做法）：从设置下拉移除，组件保留供 Modal 复用。两者本为 `roles:'user'`，admin 无此入口，无影响。

## 数据流

普通用户进「历史分析」房间 → 发问 → `postMessage` 用 core(来财) + 注入 `buildHistoryContext`（最近策略历史 + 分析报告摘要）→ 来财据此作答 → 点 `🗂 策略历史`/`📊 分析历史` 开 Modal 看完整明细。

## 错误处理 / 边界

- 无历史记录 → `buildHistoryContext` 返回「（暂无历史记录）」，不报错。
- `listStrategyHistory`/`listReports` 异常 → 该段降级为空。
- 老用户首次进入由 `ensureFixedRooms` 补建第 5 间。
- 仅 ensure 建，用户不能手建/删 `history`（固定房间规则既有）。

## 范围 / 测试

- **后端 jest（`chat/service.test.ts`）**：① `ensureFixedRooms` 建齐 5 间含 `history`（存在、pinned=1、title='历史分析'）；② `postMessage(history)` 注入「历史摘要」——先 `recordStrategy` 落一条策略，再用注入 aiCall 抓 prompt，断言含「历史摘要」与该策略内容片段。
- **前端无 runner** → `vue-tsc --noEmit` + 走查：普通用户左侧固定房间末尾多出「历史分析」（🗂、置顶、不可删）；标题栏 `🗂 策略历史`/`📊 分析历史`/`🧹 清理`，点开各自 Modal 即原历史页内容；普通用户设置下拉**不再有** 策略历史/分析历史。

## 不在本次范围

- 不重写 `StrategyHistoryView`/`AnalysisView`（原样嵌入 Modal）。
- 不新增子 agent（聊天复用 core「来财」）。
- 不改其它房间行为。
