# 小作手 1.0 · 阶段③ E：数据异常站内告警 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** admin 能在运维主页一眼看到数据是否异常——从现有状态(sync_status / cron_status / market_sentiment / sidecar 健康)**实时计算**告警，顶部红/黄条提示条数 + 「数据告警」页列明细，问题修复后自动消失。

**Architecture:** 新增纯计算模块 `backend/src/data/alerts.ts`(无新表，读现有状态)，导出 `getDataAlerts(sidecar, nowCN?)`。后端加 `GET /api/data/alerts`(admin)路由：先解析 sidecar 可达性，再调 `getDataAlerts`。前端新增 `DataAlertsView.vue`(admin 菜单「数据告警」)列明细 + 30s 轮询；`HomeView.vue` admin 运维主页顶部加告警条(30s 轮询条数)。

**Tech Stack:** Express/TS + jest(后端 284 测试现绿) + Vue 3(无前端单测运行器 → `vue-tsc` + 走查)。

参照 spec：`docs/superpowers/specs/2026-06-10-xiaozuoshou-1.0-design.md` E 节。

**本阶段的设计取舍(实现时遵循)：**
- 告警源(本期)：`sync_status` 的 `stock_universe`/`eod`(state=error / 数据陈旧)、`cron_status` 的 `nightly`(last_status=error)、`market_sentiment` 最新日期陈旧/缺失、sidecar 不可达/未配置。
- **去重**：`eod`/`stock_universe` 的失败由 `sync_status` 覆盖(信息更全：含 error+finished_at)；cron 检查**只查 `nightly`**(它无 sync_status 对应；`realtime` 在阶段④F 加入)，避免同一次 EOD 失败同时从 `sync_status[eod]` 和 `cron_status[eod]` 各报一条。
- 「上一交易日」= `lastTradingDayBefore(北京今天)`(无 trade_calendar 时自动按非周末兜底)。

---

## 数据结构

```ts
// backend/src/data/alerts.ts
export type AlertLevel = 'error' | 'warn';
export type SidecarState = 'ok' | 'down' | 'unconfigured';
export interface Alert {
  level: AlertLevel;
  source: string;        // 如 'eod' / 'cron:nightly' / 'market' / 'sidecar'
  message: string;
  since: string | null;  // 相关时间(失败时刻/最后成功/数据日期)，可空
}
```

## 文件结构

- Create `backend/src/data/alerts.ts` — `getDataAlerts()` 纯计算(E 核心)
- Create `backend/src/data/alerts.test.ts` — 单测
- Modify `backend/src/routes/data.ts` — `GET /alerts`(admin)
- Modify `backend/src/routes/data.test.ts` — 路由 403/200 测试
- Create `frontend/src/views/DataAlertsView.vue` — 告警明细页
- Modify `frontend/src/api/data.ts` — `getAlerts` + `DataAlert` 类型
- Modify `frontend/src/views/HomeView.vue` — admin 菜单加「数据告警」+ 顶部告警条 + 30s 轮询

---

## Task 1: 后端 `alerts.ts` + 单测（TDD）

**Files:**
- Create: `backend/src/data/alerts.ts`
- Create: `backend/src/data/alerts.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/data/alerts.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-alerts-'));

const { getDb } = require('../db');
const { getDataAlerts } = require('./alerts');

// NOW=2026-06-11(周四) → 上一交易日(无日历兜底)=2026-06-10(周三)
const NOW = '2026-06-11';
const PREV = '2026-06-10';

beforeEach(() => {
  getDb().exec('DELETE FROM sync_status; DELETE FROM cron_status; DELETE FROM market_sentiment;');
});

function setMarket(date: string) {
  getDb().prepare("INSERT INTO market_sentiment (date, source) VALUES (?, 'test')").run(date);
}
function setSync(job: string, fields: Record<string, any>) {
  const cols = Object.keys(fields);
  getDb()
    .prepare(`INSERT INTO sync_status (job, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`)
    .run(job, ...cols.map((c) => fields[c]));
}
function setCron(key: string, fields: Record<string, any>) {
  const cols = Object.keys(fields);
  getDb()
    .prepare(`INSERT INTO cron_status (key, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`)
    .run(key, ...cols.map((c) => fields[c]));
}

describe('getDataAlerts', () => {
  it('全部正常时无告警', () => {
    setMarket(PREV); // 大盘到上一交易日 = 不陈旧
    setSync('eod', { state: 'done', last_success_at: `${PREV} 02:00:00` });
    setSync('stock_universe', { state: 'done', last_success_at: `${PREV} 02:00:00` });
    setCron('nightly', { last_status: 'ok', last_run_at: `${PREV} 23:00:00` });
    expect(getDataAlerts('ok', NOW)).toEqual([]);
  });

  it('sync_status error → error 告警(含 since=finished_at)', () => {
    setMarket(PREV);
    setSync('eod', { state: 'error', error: '取数失败', finished_at: `${PREV} 01:30:00` });
    const a = getDataAlerts('ok', NOW);
    const eod = a.find((x: any) => x.source === 'eod');
    expect(eod).toMatchObject({ level: 'error', since: `${PREV} 01:30:00` });
    expect(eod.message).toContain('取数失败');
  });

  it('sync_status 成功但陈旧 → warn 告警', () => {
    setMarket(PREV);
    setSync('stock_universe', { state: 'done', last_success_at: '2026-06-05 02:00:00' });
    const a = getDataAlerts('ok', NOW);
    expect(a.find((x: any) => x.source === 'stock_universe')).toMatchObject({ level: 'warn' });
  });

  it('cron nightly 失败 → error 告警', () => {
    setMarket(PREV);
    setCron('nightly', { last_status: 'error', last_error: '夜间任务崩了', last_run_at: `${PREV} 23:05:00` });
    const a = getDataAlerts('ok', NOW);
    expect(a.find((x: any) => x.source === 'cron:nightly')).toMatchObject({ level: 'error', since: `${PREV} 23:05:00` });
  });

  it('大盘数据陈旧 / 缺失 → warn 告警', () => {
    setMarket('2026-06-05');
    expect(getDataAlerts('ok', NOW).find((x: any) => x.source === 'market')).toMatchObject({ level: 'warn' });
    getDb().exec('DELETE FROM market_sentiment;');
    expect(getDataAlerts('ok', NOW).find((x: any) => x.source === 'market')).toMatchObject({ level: 'warn' });
  });

  it('sidecar 不可达 → error；未配置 → warn', () => {
    setMarket(PREV);
    expect(getDataAlerts('down', NOW).find((x: any) => x.source === 'sidecar')).toMatchObject({ level: 'error' });
    expect(getDataAlerts('unconfigured', NOW).find((x: any) => x.source === 'sidecar')).toMatchObject({ level: 'warn' });
    expect(getDataAlerts('ok', NOW).find((x: any) => x.source === 'sidecar')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ~/projects/stock-agent/backend && npx jest data/alerts -i`
Expected: FAIL（`Cannot find module './alerts'`）。

- [ ] **Step 3: 实现 `backend/src/data/alerts.ts`**

```ts
import { getSyncStatus, getCronStatus, getMarketSentimentSeries } from './service';
import { lastTradingDayBefore } from './trade-calendar';

export type AlertLevel = 'error' | 'warn';
export type SidecarState = 'ok' | 'down' | 'unconfigured';
export interface Alert {
  level: AlertLevel;
  source: string;
  message: string;
  since: string | null;
}

// 有 sync_status 的数据同步任务(失败/陈旧由 sync_status 覆盖)
const SYNC_JOBS: Array<{ key: string; label: string }> = [
  { key: 'stock_universe', label: '股票库同步' },
  { key: 'eod', label: '行情 EOD 入库' },
];
// 无 sync_status 对应的数据类 cron(realtime 在阶段④加入)
const DATA_CRONS: Array<{ key: string; label: string }> = [{ key: 'nightly', label: '夜间数据刷新' }];

function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
// SQLite CURRENT_TIMESTAMP 是 UTC；转北京日期再比，避免跨零点误判陈旧
function cnDate(ts: string | null): string | null {
  if (!ts) return null;
  const t = new Date(ts.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return ts.slice(0, 10);
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function getDataAlerts(sidecar: SidecarState, nowCN: string = beijingToday()): Alert[] {
  const alerts: Alert[] = [];
  const prevTd = lastTradingDayBefore(nowCN);

  // sidecar
  if (sidecar === 'down') {
    alerts.push({ level: 'error', source: 'sidecar', message: '数据 sidecar(akshare-mcp)不可达，取数将失败', since: null });
  } else if (sidecar === 'unconfigured') {
    alerts.push({ level: 'warn', source: 'sidecar', message: '尚未配置数据 sidecar，无法取数', since: null });
  }

  // 数据同步任务：失败 / 陈旧
  for (const { key, label } of SYNC_JOBS) {
    const st = getSyncStatus(key);
    if (st?.state === 'error') {
      alerts.push({ level: 'error', source: key, message: `${label}上次同步失败：${st.error || st.message || '未知错误'}`, since: st.finished_at });
    } else if (st?.last_success_at) {
      const d = cnDate(st.last_success_at)!;
      if (d < prevTd) {
        alerts.push({ level: 'warn', source: key, message: `${label}数据陈旧（最后成功 ${d}，应至 ${prevTd}）`, since: st.last_success_at });
      }
    }
  }

  // 数据类 cron 执行失败
  for (const { key, label } of DATA_CRONS) {
    const cs = getCronStatus(key);
    if (cs?.last_status === 'error') {
      alerts.push({ level: 'error', source: `cron:${key}`, message: `定时任务[${label}]上次执行失败：${cs.last_error || '未知错误'}`, since: cs.last_run_at });
    }
  }

  // 大盘情绪数据陈旧 / 缺失
  const latest = getMarketSentimentSeries(1)[0];
  if (!latest) {
    alerts.push({ level: 'warn', source: 'market', message: '大盘情绪数据缺失（尚无任何记录）', since: null });
  } else if (latest.date < prevTd) {
    alerts.push({ level: 'warn', source: 'market', message: `大盘数据陈旧（最新 ${latest.date}，应至 ${prevTd}）`, since: latest.date });
  }

  return alerts;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd ~/projects/stock-agent/backend && npx jest data/alerts -i`
Expected: PASS(6 例全绿)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/data/alerts.ts backend/src/data/alerts.test.ts
git commit -m "feat(alerts): getDataAlerts 从 sync/cron/market/sidecar 状态实时算数据告警 + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端路由 `GET /api/data/alerts`（admin）+ 测试

**Files:**
- Modify: `backend/src/routes/data.ts`
- Modify: `backend/src/routes/data.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `data.test.ts` 的 `describe('data routes', ...)` 内，紧跟刚加的「数据读类接口普通用户仍可用」之后）

```ts
  it('GET /api/data/alerts 仅 admin', async () => {
    expect((await request(app).get('/api/data/alerts').set(uh())).status).toBe(403);
    const ok = await request(app).get('/api/data/alerts').set(h());
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.data.alerts)).toBe(true);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ~/projects/stock-agent/backend && npx jest routes/data -i -t "alerts"`
Expected: FAIL（404，路由不存在）。

- [ ] **Step 3: 实现路由**

3a. 在 `backend/src/routes/data.ts` 顶部加 import(放在第 9 行 sidecar 解构 import 之后)：
```ts
import { getDataAlerts, type SidecarState } from '../data/alerts';
```

3b. 在 `// GET /api/data/source` 路由(约 line 261)之前插入：
```ts
// GET /api/data/alerts — 数据异常告警(实时计算，仅 admin)
router.get('/alerts', adminMiddleware, async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  let sidecar: SidecarState;
  if (!base) sidecar = 'unconfigured';
  else sidecar = (await pingHealth(base)) ? 'ok' : 'down';
  successResponse(res, { alerts: getDataAlerts(sidecar) });
});
```
(`resolveSidecarBase`、`pingHealth` 已在第 9 行的 import 中。)

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `cd ~/projects/stock-agent/backend && npx jest routes/data -i`
Expected: 全绿(含新例)。

Run: `cd ~/projects/stock-agent/backend && npm test`
Expected: 全绿(原 284 + alerts 单测 6 + 路由 1 ≈ 291)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(api): GET /api/data/alerts(admin) — sidecar 可达性 + 数据告警

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 前端 API + 告警明细页 `DataAlertsView.vue`

**Files:**
- Modify: `frontend/src/api/data.ts`
- Create: `frontend/src/views/DataAlertsView.vue`

- [ ] **Step 1: api/data.ts 加类型 + 方法**

在类型区加：
```ts
export interface DataAlert {
  level: 'error' | 'warn';
  source: string;
  message: string;
  since: string | null;
}
```
在 `dataApi` 对象内(与 `getProxy` 等并列)加：
```ts
  getAlerts: () => api.get('/data/alerts').then((r) => r.data.data as { alerts: DataAlert[] }),
```
> 实现前先读 `frontend/src/api/data.ts` 顶部，确认 axios 实例名(此处按现有写法记为 `api`)与 `dataApi` 的导出结构，沿用之。

- [ ] **Step 2: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3: 创建 `frontend/src/views/DataAlertsView.vue`**

```vue
<template>
  <div class="alerts-view">
    <div class="head">
      <h1>数据告警</h1>
      <button class="mini" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '🔄 刷新' }}</button>
    </div>
    <p class="hint">从同步状态、定时任务、大盘数据、sidecar 健康实时计算；问题修复后自动消失。每 30 秒自动刷新。</p>

    <div v-if="!alerts.length" class="ok-box">✅ 一切正常，暂无数据告警。</div>
    <ul v-else class="alert-list">
      <li v-for="(a, i) in alerts" :key="i" class="alert-item" :class="a.level">
        <span class="badge">{{ a.level === 'error' ? '错误' : '警告' }}</span>
        <span class="src">{{ a.source }}</span>
        <span class="msg">{{ a.message }}</span>
        <span v-if="a.since" class="since">{{ a.since }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { dataApi, type DataAlert } from '../api/data';

const alerts = ref<DataAlert[]>([]);
const loading = ref(false);
let timer: number | undefined;

async function load() {
  loading.value = true;
  try {
    alerts.value = (await dataApi.getAlerts()).alerts;
  } catch {
    /* ignore */
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  timer = window.setInterval(load, 30000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.alerts-view { padding: 18px 22px; }
.head { display: flex; align-items: center; gap: 12px; }
.hint { color: var(--muted); font-size: 13px; margin: 6px 0 16px; }
.ok-box { padding: 16px; background: var(--card, #fff); border-radius: 8px; color: var(--muted); }
.alert-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.alert-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; border-left: 4px solid; background: var(--card, #fff); }
.alert-item.error { border-color: #d33; }
.alert-item.warn { border-color: #d9a300; }
.badge { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 10px; color: #fff; }
.alert-item.error .badge { background: #d33; }
.alert-item.warn .badge { background: #d9a300; }
.src { font-family: monospace; font-size: 12px; color: var(--muted); }
.msg { flex: 1; }
.since { color: var(--muted); font-size: 12px; }
</style>
```

- [ ] **Step 4: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/data.ts frontend/src/views/DataAlertsView.vue
git commit -m "feat(alerts-ui): DataAlertsView 告警明细页 + dataApi.getAlerts(30s 轮询)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: HomeView — admin 菜单加「数据告警」+ 顶部告警条

**Files:**
- Modify: `frontend/src/views/HomeView.vue`

- [ ] **Step 1: import 视图组件**

在 HomeView `<script setup>` 顶部、与其它 `import XxxView from './XxxView.vue'` 同处，加：
```ts
import DataAlertsView from './DataAlertsView.vue';
```

- [ ] **Step 2: SETTINGS 加「数据告警」项(admin)**

在 `data` 项之后、`ai` 项之前插入一行：
```ts
  { key: 'alerts', label: '数据告警', icon: '🚨', comp: DataAlertsView, roles: 'admin' },
```
(结果 admin 菜单 = 数据管理 | 数据告警 | AI模型 | 能力插件 | 定时任务 | 账号设置。)

- [ ] **Step 3: 顶部告警条状态 + 轮询(script)**

3a. 顶部 import 处确认/补：`import { ref, reactive, computed, nextTick, onMounted, onUnmounted } from 'vue';`(现有缺 `onUnmounted` 则补上)；并确认有 `import { dataApi, type DataAlert } from '../api/data';`(无则补；若已 import dataApi 则只补类型)。

3b. 在 script 中(与其它 ref 同区)加状态与方法：
```ts
const dataAlerts = ref<DataAlert[]>([]);
const alertErrorCount = computed(() => dataAlerts.value.filter((a) => a.level === 'error').length);
const alertWarnCount = computed(() => dataAlerts.value.filter((a) => a.level === 'warn').length);
let alertsTimer: number | undefined;
async function loadDataAlerts() {
  try {
    dataAlerts.value = (await dataApi.getAlerts()).alerts;
  } catch {
    /* ignore */
  }
}
```

3c. 在 `onMounted` 的 admin 分支里(`if (auth.isAdmin) { ... return; }`)加载并起轮询：
把：
```ts
  if (auth.isAdmin) {
    if (!settingsKey.value) settingsKey.value = 'data';
    return;
  }
```
改为：
```ts
  if (auth.isAdmin) {
    if (!settingsKey.value) settingsKey.value = 'data';
    await loadDataAlerts();
    alertsTimer = window.setInterval(loadDataAlerts, 30000);
    return;
  }
```

3d. 在 `onMounted(...)` 之后加卸载清理：
```ts
onUnmounted(() => {
  if (alertsTimer) clearInterval(alertsTimer);
});
```

- [ ] **Step 4: 顶部告警条(template)**

在 `<main class="main">`(约 line 29)之内、`<nav class="topnav">` 之前插入：
```vue
      <div
        v-if="auth.isAdmin && dataAlerts.length"
        class="alert-bar"
        :class="alertErrorCount ? 'err' : 'warn'"
        @click="settingsKey = 'alerts'"
      >
        {{ alertErrorCount ? '🔴' : '🟡' }} 数据告警 {{ dataAlerts.length }} 条（{{ alertErrorCount }} 错误 / {{ alertWarnCount }} 警告）— 点击查看
      </div>
```

- [ ] **Step 5: 告警条样式**

在 `<style scoped>` 末尾加：
```css
.alert-bar { cursor: pointer; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #fff; }
.alert-bar.err { background: #d33; }
.alert-bar.warn { background: #d9a300; }
```

- [ ] **Step 6: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 7: 逻辑走查**

确认：
- admin 菜单含「🚨 数据告警」，点开即 `DataAlertsView`。
- admin 主页有告警时顶部出现红/黄条(有 error→红、仅 warn→黄)，点击跳到告警页(`settingsKey='alerts'`)；无告警不显示条。
- 普通用户：`auth.isAdmin` 假 → 不轮询、不显示条、菜单无该项(roles:'admin')。
- 离开页面 `onUnmounted` 清掉定时器，无泄漏。

- [ ] **Step 8: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(alerts-ui): admin 运维主页顶部告警条 + 「数据告警」菜单 + 30s 轮询

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收(全部 Task 完成后)

1. `cd ~/projects/stock-agent/backend && npm test` → 全绿(约 291)。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(可选)：`docker compose up -d --build` 后 admin 登录——
   - 正常时「数据告警」页显示「✅ 一切正常」，无顶部条。
   - 造一个异常(如停掉 akshare-mcp 容器 → sidecar down)刷新 → 顶部红条 + 告警页列出 sidecar error；恢复后 30s 内自动消失。
   - 普通用户登录无「数据告警」入口、无顶部条。
