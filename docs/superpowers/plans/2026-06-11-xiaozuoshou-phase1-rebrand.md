# 小作手 1.0 · 阶段① A+B 改名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把产品从「股票小作手」更名为「小作手」(版本 1.0、广告语「您的决策小助手」)，并把所有用户可见的「核心原则/核心规则」文案改为「当前策略」。

**Architecture:** 纯文案/版本号改动，不动任何内部 key(`core_principle`/`ChatKind`/rulebook 表名/API 路径)。A 块是品牌字符串的定点替换 + 新增版本常量；B 块是 `核心原则`/`核心规则` → `当前策略` 的全量替换(前后端同改以保证 UI 与 AI 措辞一致)，配一处需手工调顺的中文。

**Tech Stack:** Vue 3 (Vite, 无前端测试运行器) + Express/TS (jest)。前端验证靠 `vue-tsc --noEmit` + grep 冒烟；后端靠 `npm test`(改名前后断言同步替换，应保持全绿)。

参照 spec：`docs/superpowers/specs/2026-06-10-xiaozuoshou-1.0-design.md` A、B 两节。

---

## 文件结构

**A 品牌(定点编辑)**
- Create `frontend/src/version.ts` — 导出 `APP_VERSION='1.0'`(登录页/左栏统一引用)
- Modify `frontend/index.html` — `<title>`
- Modify `frontend/src/views/LoginView.vue` — logo、广告语+版本、hint
- Modify `frontend/src/views/HomeView.vue` — 左栏 brand + 版本、问候语
- Modify `frontend/src/views/RegisterView.vue` — `<h1>`、免责声明产品名
- Modify `frontend/package.json` `backend/package.json` — `version` `0.1.0`→`1.0.0`；backend `description`

**B 文案(全量替换 + 一处手工调顺)**
- Modify `frontend/src/**`(HomeView/OnboardingView/RulebookView/SettingsView/AnalysisView/api/rulebook.ts 等)：`核心原则`/`核心规则`→`当前策略`
- Modify `backend/src/**`(chat/meetings/rulebook/agent/screen/analysis/ai/routes + 对应 .test.ts)：`核心原则`/`核心规则`→`当前策略`
- 手工：`frontend/src/views/HomeView.vue` `【当前使用的核心原则 …】` → `【当前策略 …】`

> 说明：`核心原则`/`核心规则` 是纯中文显示词，从不作标识符(内部用英文 `core_principle`)，故全量替换安全。后端 prompt 与其测试断言一起替换 → 断言仍匹配，`npm test` 应保持绿。

---

## Task 1: A — 新增版本常量

**Files:**
- Create: `frontend/src/version.ts`

- [ ] **Step 1: 创建版本常量文件**

`frontend/src/version.ts`:
```ts
// 小作手版本号。登录页与主页左栏统一引用，避免散落硬编码。
export const APP_VERSION = '1.0';
```

- [ ] **Step 2: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0(无新错误)。

- [ ] **Step 3: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/version.ts
git commit -m "feat(brand): 新增 APP_VERSION 版本常量

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: A — LoginView 品牌 + 广告语 + 版本

**Files:**
- Modify: `frontend/src/views/LoginView.vue`

- [ ] **Step 1: 改 logo 文案(line 6)**

把：
```vue
        <div class="logo">📈 股票小作手</div>
```
改为：
```vue
        <div class="logo">📈 小作手</div>
        <div class="tagline">您的决策小助手 · v{{ APP_VERSION }}</div>
```

- [ ] **Step 2: 改 hint(line 52)**

把：
```vue
        <p class="hint">登录后继续和你的股票小作手探讨规则、分析个股。</p>
```
改为：
```vue
        <p class="hint">登录后继续和你的小作手探讨策略、分析个股。</p>
```

- [ ] **Step 3: 引入版本常量(script 顶部)**

在 `<script setup ...>` 内、`const loading = ref(false);`(约 line 80)之前新增一行：
```ts
import { APP_VERSION } from '../version';
```

- [ ] **Step 4: 加 tagline 样式**

在 `<style scoped>` 内 `.logo { ... }`(约 line 110)之后新增：
```css
.tagline { color: var(--muted); font-size: 13px; margin-top: 6px; letter-spacing: 0.3px; }
```

- [ ] **Step 5: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/LoginView.vue
git commit -m "feat(brand): 登录页改名小作手 + 广告语/版本号

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: A — HomeView 左栏品牌 + 版本 + 问候语

**Files:**
- Modify: `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 改左栏 brand + 加版本(line 7)**

把：
```vue
      <div class="brand">股票小作手</div>
```
改为：
```vue
      <div class="brand">小作手 <span class="ver">v{{ APP_VERSION }}</span></div>
```

- [ ] **Step 2: 改问候语(line 55)**

把：
```vue
              <h2>你好，我是股票小作手，来财。🤝</h2>
```
改为：
```vue
              <h2>你好，我是来财。🤝</h2>
```

- [ ] **Step 3: 引入版本常量**

在 `<script setup ...>` 顶部 import 区(与其它 `import ... from '../...'` 同处)新增：
```ts
import { APP_VERSION } from '../version';
```

- [ ] **Step 4: 加版本样式**

在 `<style scoped>` 内 `.brand { ... }` 规则之后(若无 `.ver`)新增：
```css
.brand .ver { font-size: 11px; font-weight: 600; opacity: 0.6; }
```

- [ ] **Step 5: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(brand): 主页左栏改名小作手 + 版本号 + 问候语去产品名

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: A — RegisterView + package.json 版本/描述

**Files:**
- Modify: `frontend/src/views/RegisterView.vue`
- Modify: `frontend/package.json`
- Modify: `backend/package.json`

- [ ] **Step 1: 改注册页标题(RegisterView line 3)**

把：
```vue
    <h1>注册 · 股票小作手</h1>
```
改为：
```vue
    <h1>注册 · 小作手</h1>
```

- [ ] **Step 2: 改免责声明产品名(RegisterView line 13)**

把：
```vue
        <p>1. 本系统（股票小作手）是个人投资研究的<b>辅助工具</b>，
```
改为(仅产品名，其余不动)：
```vue
        <p>1. 本系统（小作手）是个人投资研究的<b>辅助工具</b>，
```

- [ ] **Step 3: 改前端版本号(frontend/package.json line 3)**

把 `"version": "0.1.0",` 改为 `"version": "1.0.0",`

- [ ] **Step 4: 改后端版本号 + 描述(backend/package.json line 3-4)**

把：
```json
  "version": "0.1.0",
  "description": "股票小作手 backend",
```
改为：
```json
  "version": "1.0.0",
  "description": "小作手 backend",
```

- [ ] **Step 5: 类型检查 + 确认无遗漏品牌**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

Run: `cd ~/projects/stock-agent && grep -rn "股票小作手" frontend/src backend/src frontend/index.html`
Expected: 仅剩 `frontend/src/assets/theme.css` 顶部注释一行(主题文件注释，可保留)；无其它命中。
> 若 `frontend/index.html` 的 `<title>股票小作手</title>` 仍在，本步顺手改为 `<title>小作手</title>`(见 Task 5 由 index.html 单独处理；此处仅核对前端 src)。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/RegisterView.vue frontend/package.json backend/package.json
git commit -m "feat(brand): 注册页/免责声明改名 + version 1.0.0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: A — index.html title

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: 改 title(line 6)**

把：
```html
    <title>股票小作手</title>
```
改为：
```html
    <title>小作手</title>
```
> `backend/public/index.html` 是前端构建产物(gitignored)，由 `npm run build` 重新生成，无需手改。

- [ ] **Step 2: 核对**

Run: `cd ~/projects/stock-agent && grep -rn "股票小作手" frontend/index.html`
Expected: 无命中。

- [ ] **Step 3: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/index.html
git commit -m "feat(brand): index.html title 改名小作手

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: B — 核心原则/核心规则 → 当前策略(全量替换)

**Files:**
- Modify: `frontend/src/**`(多文件)
- Modify: `backend/src/**`(多文件，含 `.test.ts`)

- [ ] **Step 1: 替换前快照(记录命中数)**

Run:
```bash
cd ~/projects/stock-agent
echo "frontend 核心原则:"; grep -rc "核心原则" frontend/src | grep -v ':0' || true
echo "frontend 核心规则:"; grep -rc "核心规则" frontend/src | grep -v ':0' || true
echo "backend 核心原则:";  grep -rc "核心原则" backend/src | grep -v ':0' || true
echo "backend 核心规则:";  grep -rc "核心规则" backend/src | grep -v ':0' || true
```
Expected: 列出若干文件及命中数(前端 HomeView 约 32 等)。记下总体范围。

- [ ] **Step 2: 全量替换两个词**

Run:
```bash
cd ~/projects/stock-agent
grep -rlZ -e "核心原则" -e "核心规则" frontend/src backend/src \
  | xargs -0 sed -i -e 's/核心原则/当前策略/g' -e 's/核心规则/当前策略/g'
```
> `core_principle`/`ChatKind`/表名/路径均为英文，本替换不触及。

- [ ] **Step 3: 手工调顺一处叠词(HomeView)**

替换后 `frontend/src/views/HomeView.vue` 约 line 459 会出现 `【当前使用的当前策略 ...】`。把：
```ts
    `【当前使用的当前策略 ${rb.version.version_label}${changed}】\n` +
```
改为：
```ts
    `【当前策略 ${rb.version.version_label}${changed}】\n` +
```

- [ ] **Step 4: 确认无残留 + 无新叠词**

Run:
```bash
cd ~/projects/stock-agent
echo "残留旧词(应为空):"; grep -rn -e "核心原则" -e "核心规则" frontend/src backend/src || echo "OK 无残留"
echo "叠词(应为空):"; grep -rn "当前使用的当前策略\|当前策略策略\|当前当前策略" frontend/src backend/src || echo "OK 无叠词"
```
Expected: 两项均 `OK ...`(无命中)。

- [ ] **Step 5: 前端类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 6: 后端全量测试(断言随 prompt 同步替换，应保持绿)**

Run: `cd ~/projects/stock-agent/backend && npm test`
Expected: 全绿(与改名前同样的通过数；无因 `核心原则`→`当前策略` 导致的断言失配)。
> 若个别测试因外部快照/独立写死的字符串失配，按实际把该断言里的 `核心原则`/`核心规则` 一并改为 `当前策略` 后重跑。

- [ ] **Step 7: 提交**

```bash
cd ~/projects/stock-agent
git add -A
git commit -m "feat(copy): 核心原则/核心规则 用户可见文案统一改为当前策略

前后端 prompt 与 UI 同步替换，保持来财措辞与界面一致；内部 key core_principle 不变。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收(全部 Task 完成后)

1. `cd ~/projects/stock-agent && grep -rn "股票小作手" frontend/src frontend/index.html backend/src` → 仅 `theme.css` 注释或空。
2. `grep -rn -e "核心原则" -e "核心规则" frontend/src backend/src` → 空。
3. `cd frontend && npx vue-tsc --noEmit` → exit 0。
4. `cd backend && npm test` → 全绿。
5. 容器验证(可选)：`docker compose up -d --build` 后浏览器看登录页(📈 小作手 / 您的决策小助手 · v1.0)、主页左栏(小作手 v1.0)、问候语(你好，我是来财。)、设置里菜单/标题为「当前策略」。
