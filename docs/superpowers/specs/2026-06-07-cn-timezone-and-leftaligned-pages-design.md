# 中国时区时间修正 + 功能页靠左卡片化（含二级标签推广）

日期：2026-06-07

## Context（背景）

两件事：

1. **时区错乱（bug）**：SQLite `CURRENT_TIMESTAMP` 存的是 **UTC**，前端多数地方把这串时间**原样**显示（`{{ created_at }}`、`.slice(0,16)`），于是看起来比北京时间慢 8 小时。仅有的 `fmtTime`（HomeView）虽然补了 `'Z'` 但用 `toLocaleString('zh-CN')` **不锁时区**（跟随浏览器），且大多数显示点根本没走它。后端 `meetings.today()` 用 `new Date().toISOString().slice(0,10)`（UTC 日期），北京 08:00 前会取到前一天，导致「今日早/晚会」日期错位。

2. **版式**：每个功能页自己 `max-width:720~760px; margin:24px auto` **居中**。用户要：**靠左**（不居中）、**每个功能一张卡片**（像聊天框那样），并把数据页的「二级标签」分组**推广**到账号设置、AI 模型两页。

## Goals

- **时区**：保持 DB 存 UTC（不迁移），新增统一格式化器**锁定 `Asia/Shanghai`**，所有时间显示走它；后端 `today()` 取北京日期；容器设 `TZ=Asia/Shanghai`。无论浏览器/服务器在哪个时区，显示恒为北京时间。
- **版式**：所有功能页内容**靠左**、**最大宽度 960px**（不居中、超宽屏不拉满）；每个功能区块统一为卡片；账号设置 + AI 模型加二级标签分组。

## Non-goals

- 不改 DB 时间存储（仍 UTC `CURRENT_TIMESTAMP`），不做历史数据迁移。
- 核心规则 / 能力插件 / 早晚会历史 / 分析历史**不加**二级标签，只做「靠左 + 卡片化」。
- 不抽 `<Card>`/`<SubTabs>` Vue 组件（沿用 class；YAGNI）。

## 设计

### A. 时区（统一格式化器 + 后端北京日期 + 容器 TZ）

**A1. 新增 `frontend/src/utils/time.ts`：**
```ts
const TZ = 'Asia/Shanghai';

function toDate(ts: string): Date | null {
  let s = ts.includes('T') ? ts : ts.replace(' ', 'T');
  // 无时区标记则按 UTC（SQLite CURRENT_TIMESTAMP）处理
  if (!/[Zz]$|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 把 DB 的 UTC 时间串显示成北京时间。date/time 控制粒度。 */
export function fmtCN(ts?: string | null, opts: { date?: boolean; time?: boolean } = {}): string {
  const { date = true, time = true } = opts;
  if (!ts) return '—';
  const d = toDate(ts);
  if (!d) return ts;
  return d.toLocaleString('zh-CN', {
    timeZone: TZ,
    hour12: false,
    ...(date ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export const fmtCNDate = (ts?: string | null) => fmtCN(ts, { time: false }); // 仅日期 YYYY/MM/DD
/** 当前北京日期 YYYY-MM-DD（用于「今天」比较） */
export const beijingToday = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
```

**A2. 替换前端所有时间显示点**走 `fmtCN`/`fmtCNDate`：
- `DataView.vue`：概览条 `last_success_at` 两处 `.slice(0,10)` → `fmtCNDate(...)`；股票库/行情卡「最后成功：」`{{ ... }}` → `fmtCN(...)`；新闻 `collected_at` `.slice(0,16)` → `fmtCN(...)`；日志 `l.ts` → `fmtCN(l.ts)`；`canRun` 里「今天已成功」判断改用 `beijingToday()` 比对 `toDate(last_success_at)` 的北京日期。
- `RulebookView.vue`：`shown.version.created_at`、`v.created_at` → `fmtCN(...)`。
- `SettingsView.vue`：备份 `b.created_at`、用户 `u.created_at`、登录日志 `l.created_at` → `fmtCN(...)`。
- `AnalysisView.vue`：`report.created_at`、`r.created_at` → `fmtCN(...)`。
- `HomeView.vue`：`fmtTime` 改为 `import { fmtCN } from '../utils/time'` 并 `const fmtTime = (ts: string) => fmtCN(ts)`（保留调用名）；`screenHistory` `created_at` `.slice(0,16)` → `fmtCN(...)`；核心原则 briefing「最后更换」`rb.version.created_at.slice(0,10)` → `fmtCNDate(...)`。
- `MeetingsHistoryView.vue`：其中任何会议时间显示 → `fmtCN(...)`（实现时按文件实际字段处理）。

**A3. 后端北京日期** `backend/src/meetings/service.ts`：
```ts
export function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // 北京 YYYY-MM-DD
}
```
（DB 仍 UTC；`today()` 仅用于「当天会议」键与展示标题，取北京日历日。）

**A4. 容器时区** `docker-compose.yml`：给后端 app 服务（及 sidecar）加 `environment: - TZ=Asia/Shanghai`。让 Node `new Date()` 日志、`toLocaleString` 默认值、cron 边界与北京一致。SQLite `CURRENT_TIMESTAMP` 不受影响（恒 UTC，前端负责转换）。

### B. 版式：靠左 + 卡片化 + 二级标签

**B1. 全局样式 `frontend/src/assets/theme.css`** 新增可复用类（供 Data/Settings/AI 等共用，DRY）：
```css
.subtabs { display: flex; gap: 6px; margin: 12px 0 14px; border-bottom: 1px solid var(--border-soft); }
.subtabs button { border: none; background: none; padding: 8px 16px; font-size: 14px; cursor: pointer; color: #555; border-bottom: 2px solid transparent; }
.subtabs button.active { color: #1677ff; border-bottom-color: #1677ff; font-weight: 600; }
```
（DataView 已有 scoped `.subtabs`，改为依赖此全局后删除其 scoped 副本，避免重复。）

**B2. 各功能页根容器靠左 + 限宽**：把以下根类的 `max-width: 720/760px; margin: 24px auto`（或 `32px auto`）统一改为 `max-width: 960px; margin: 0`（左对齐、不居中；上下间距交给 panelbox/各卡 margin）：
`DataView .data`、`SettingsView .settings`、`AiSettingsView .ai`、`AnalysisView .analysis`、`PluginsView .plugins`、`RulebookView` 根类、`MeetingsHistoryView` 根类。

**B3. 卡片化**：各页功能区块沿用 `.card`（多数页已用）。补齐：
- `MeetingsHistoryView`（当前 0 张卡）：把其内容块包进 `.card`（与其它页一致的白底圆角阴影）。
- `AnalysisView`（1 张卡）：确保列表/详情区块为卡片。
- 各页 scoped `.card` 视觉值保持一致即可（不强制抽全局，沿用现状）。

**B4. 二级标签分组**（仅这两页）：

`AiSettingsView.vue` 加 `const tab = ref<'models' | 'tasks'>('models')` + `<nav class="subtabs">`：
- **模型配置**（`models`，默认）：配置提供商 + 已配置的模型
- **任务分工**（`tasks`）：任务分工
分组用 `<div v-show="tab==='...'">` 包对应卡片（保留各卡内部 DOM/逻辑不变）。

`SettingsView.vue` 加 `const tab = ref<'account' | 'backup' | 'users'>('account')` + `<nav class="subtabs">`：
- **账号安全**（`account`，默认）：修改密码
- **数据备份**（`backup`）：数据备份与重置
- **用户管理**（`users`，仅 admin 可见该标签）：用户管理 + 登录日志
非 admin 不渲染「用户管理」标签（`v-if="isAdmin"` 包按钮）；默认仍 `account`。

## Testing

- `cd frontend && npx vue-tsc --noEmit` 干净。
- `cd backend && npm test` 全绿（`meetings.today()` 改动后相关测试仍通过；如有断言依赖 UTC 当天，按北京日期校正——见下）。
- 后端补一条测试：`today()` 返回 `Asia/Shanghai` 日历日（mock 一个 UTC 时刻落在北京次日的边界，断言取北京日）。
- 手动冒烟：
  1. 任一含时间的页面（数据/分析历史/登录日志/规则版本/选股历史/聊天消息）显示**北京时间**（比改前 +8h）。
  2. 数据页/账号/AI 三页内容靠左、不居中；账号、AI 出现二级标签且默认落在 账号安全 / 模型配置；非 admin 看不到「用户管理」标签。
  3. 各页功能为独立卡片；切标签只看该组。
  4. 早/晚会按钮在北京 08:00 前生成时，会议日期为当天北京日（非前一天）。

## 默认决定（已确认）

- 靠左 + 最大宽度 **960px**（不居中）。
- 二级标签仅推广到 **账号设置 + AI 模型**；其余页只靠左卡片化。
- 时区方案：DB 存 UTC、显示锁 `Asia/Shanghai`、`today()` 取北京日、容器 `TZ=Asia/Shanghai`（已说明为技术正确做法）。
