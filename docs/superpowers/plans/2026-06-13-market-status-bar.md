# 大盘状态条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 普通用户聊天区底部常驻状态条：5 大盘指数点数(盘中实时/否则上一交易日收盘) + 数据更新时间 + 数据异常时整条高亮(复用 getDataAlerts，点击看明细)。

**Architecture:** sidecar 用「显式市场 + 原始 pytdx `get_security_quotes`」取指数实时点;后端 `realtime` cron 顺带把 5 指数写入 `realtime_quote`(带市场前缀 key);`getMarketStatus` 读缓存组装(盘中=实时/否则=缓存里上次收盘) + 内部 `getDataAlerts`;`GET /api/market/status`(用户);前端 `MarketStatusBar` 轮询 + 高亮。

**关键简化(相对 spec)**：不引入 index_daily/nightly 刷指数收盘。`realtime_quote` 缓存**不清除**，cron 仅在交易时段写——故盘后/盘前/休市时缓存里**保留的就是上一交易段的收盘点**，天然满足「非交易时段显示收盘」。单一数据源 = `realtime_quote`。

**Tech Stack:** Python sidecar(mootdx/pytdx) + Express/TS + jest + Vue 3。

参照 spec：`docs/superpowers/specs/2026-06-13-market-status-bar-design.md`。

**已容器验证**：`c.client.get_security_quotes([(market,code)])` 显式 market 取指数 OK：上证(1,000001)=4031、科创50(1,000688)=1663、深证(0,399001)=14963、创业(0,399006)=3830;北证50(2,899050)=None(服务器不供 BJ)→ 需兜底/显示「—」。

---

## 指数定义(全程统一)

| name | key | sidecar 解析 market | code |
|---|---|---|---|
| 上证综指 | `sh000001` | sh→1 | 000001 |
| 深证成指 | `sz399001` | sz→0 | 399001 |
| 创业板指 | `sz399006` | sz→0 | 399006 |
| 科创50 | `sh000688` | sh→1 | 000688 |
| 北证50 | `bj899050` | bj→2 | 899050 |

---

## Task 1: sidecar 指数实时端点

**Files:** Modify `sidecar/tdx.py`、`sidecar/main.py`

- [ ] **Step 1: `tdx.py` 加 `index_realtime`**

```python
_IDX_MARKET = {"sh": 1, "sz": 0, "bj": 2}

def index_realtime(prefixed):
    # prefixed 形如 'sh000001'；前 2 位是市场，后 6 位是代码。用原始 pytdx 显式 market 取指数实时。
    pfx, code = prefixed[:2].lower(), prefixed[-6:]
    market = _IDX_MARKET.get(pfx)
    if market is None:
        return None
    def fn(c):
        raw = getattr(c, "client", None)
        if raw is None:
            return None
        q = raw.get_security_quotes([(market, code)])
        if not q:
            return None
        r = q[0]
        return {
            "price": _f(r.get("price")),
            "prev_close": _f(r.get("last_close")),
            "open": _f(r.get("open")),
            "high": _f(r.get("high")),
            "low": _f(r.get("low")),
            "time": str(r.get("servertime") or ""),
        }
    return _call(fn)
```
> 复用 `_call`(自愈重连)+`_f`。`_call`/`_f` 已在文件中。

- [ ] **Step 2: `main.py` 加 `/index/{code}` 端点**

在 `/realtime` 端点附近加：
```python
@app.get("/index/{code}")
def index_quote(code: str):
    rt = _timed(lambda: tdx.index_realtime(code), 6)
    if rt and rt.get("price") is not None:
        return {"source": "tdx-idx", "data": rt}
    return {"source": None, "data": {}}
```
> 北证(bj899050)预计返回 `{"source": null, "data": {}}`(TDX 不供)——后端据此显示「—」。`_timed` 已存在(realtime 端点已用)。

- [ ] **Step 3: 重建 + 容器验证 5 个指数**

Run:
```bash
cd ~/projects/stock-agent && docker compose up -d --build
for k in sh000001 sz399001 sz399006 sh000688 bj899050; do
  docker exec stock-agent-akshare-mcp-1 sh -c "curl -s localhost:8000/index/$k"; echo
done
```
Expected: 前 4 个返回 `{"source":"tdx-idx","data":{"price":...}}`(上证~4000、深证~15000、创业~3800、科创50~1600)；`bj899050` 返回 `{"source":null,"data":{}}`。若某指数点数明显错误(像个股价)→ 检查 market 映射。北证若确实取不到,保持 null(后端兜底)。

- [ ] **Step 4: 提交**

```bash
cd ~/projects/stock-agent
git add sidecar/tdx.py sidecar/main.py
git commit -m "feat(sidecar): /index/{code} 指数实时(显式市场 raw get_security_quotes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端 缓存指数 + getMarketStatus（TDD）

**Files:** Modify `backend/src/data/sidecar.ts`、`backend/src/data/service.ts`；Create `backend/src/data/market-status.ts`、`backend/src/data/market-status.test.ts`

- [ ] **Step 1: `sidecar.ts` 加 `fetchIndexRealtime`**（仿 `fetchRealtime`，line ~61）

```ts
export async function fetchIndexRealtime(base: string, key: string): Promise<{ source: string | null; data: Record<string, unknown> } | null> {
  return getJson(`${base}/index/${key}`, 1500);
}
```
> `getJson` 已在文件中(fetchRealtime 用)。

- [ ] **Step 2: `service.ts` 的 `ingestRealtime` 顺带缓存 5 指数**

2a. 顶部 import 增补 `fetchIndexRealtime`：把现有 `import { ... fetchRealtime, fetchIndexBars } from './sidecar';` 加上 `fetchIndexRealtime`。
2b. 加指数常量(靠近 `RT_COLS`)：
```ts
export const MARKET_INDICES: Array<{ key: string; name: string }> = [
  { key: 'sh000001', name: '上证综指' },
  { key: 'sz399001', name: '深证成指' },
  { key: 'sz399006', name: '创业板指' },
  { key: 'sh000688', name: '科创50' },
  { key: 'bj899050', name: '北证50' },
];
```
2c. 在 `ingestRealtime` 个股循环之后、`return` 之前，加指数循环：
```ts
  for (const idx of MARKET_INDICES) {
    try {
      const rt = await fetchIndexRealtime(base, idx.key);
      if (rt && rt.data && (rt.data as any).price != null) {
        cacheRealtime(idx.key, rt.data as Record<string, any>, rt.source ?? 'tdx-idx');
      }
    } catch {
      /* 单个指数失败跳过 */
    }
  }
```
> `cacheRealtime` 接受任意 code key(含 `sh000001`)，与个股隔离。指数无五档,相关列写 null,无碍。

- [ ] **Step 3: 写失败测试 `backend/src/data/market-status.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mktstatus-'));

const { getDb } = require('../db');
const svc = require('./service');
const { getMarketStatus } = require('./market-status');

const WED_SESSION = Date.UTC(2026, 5, 10, 2, 0, 0); // 周三北京10:00 盘中
const WED_PRE = Date.UTC(2026, 5, 10, 0, 0, 0);      // 周三北京08:00 盘前

beforeEach(() => {
  getDb().exec("DELETE FROM realtime_quote; DELETE FROM sync_status; DELETE FROM cron_status; DELETE FROM market_sentiment;");
});

describe('getMarketStatus', () => {
  it('盘中且当天有缓存 → basis=实时,带点数与涨跌幅', () => {
    svc.cacheRealtime('sh000001', { price: 4031.5, prev_close: 3987.0, time: '10:00' }, 'tdx-idx');
    const st = getMarketStatus(WED_SESSION, 'ok');
    const sh = st.indices.find((x: any) => x.code === 'sh000001');
    expect(sh).toMatchObject({ name: '上证综指', point: 4031.5, basis: '实时' });
    expect(Math.round(sh.changePct * 100) / 100).toBeCloseTo(1.12, 1);
    expect(st.updatedAt).toBeTruthy();
  });
  it('非盘中(盘前) → basis=收盘(用缓存里上次收盘点)', () => {
    svc.cacheRealtime('sh000001', { price: 4031.5, prev_close: 3987.0 }, 'tdx-idx');
    const sh = getMarketStatus(WED_PRE, 'ok').indices.find((x: any) => x.code === 'sh000001');
    expect(sh.basis).toBe('收盘');
    expect(sh.point).toBe(4031.5);
  });
  it('无缓存指数 → point=null', () => {
    const bj = getMarketStatus(WED_SESSION, 'ok').indices.find((x: any) => x.code === 'bj899050');
    expect(bj.point).toBeNull();
  });
  it('alerts 汇总：sidecar down → alertLevel=error', () => {
    const st = getMarketStatus(WED_SESSION, 'down');
    expect(st.alertLevel).toBe('error');
    expect(st.alerts.some((a: any) => a.source === 'sidecar')).toBe(true);
  });
  it('数据正常 → alertLevel=null', () => {
    // 造大盘不陈旧,避免 market 告警(上一交易日=2026-06-09)
    getDb().prepare("INSERT INTO market_sentiment (date, source) VALUES ('2026-06-10','t')").run();
    const st = getMarketStatus(WED_SESSION, 'ok');
    expect(st.alertLevel).toBeNull();
  });
});
```

- [ ] **Step 4: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest market-status -i`。Expected: FAIL（模块不存在）。

- [ ] **Step 5: 实现 `backend/src/data/market-status.ts`**

```ts
import { getRealtime, inTradingSession, MARKET_INDICES } from './service';
import { getDataAlerts, Alert, SidecarState, AlertLevel } from './alerts';

export interface IndexStatus {
  name: string;
  code: string;
  point: number | null;
  prevClose: number | null;
  changePct: number | null;
  basis: '实时' | '收盘';
}
export interface MarketStatus {
  updatedAt: string | null;
  indices: IndexStatus[];
  alerts: Alert[];
  alertLevel: AlertLevel | null;
}

function cnDate(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const t = new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return String(ts).slice(0, 10);
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function beijingDate(nowMs: number): string {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function getMarketStatus(nowMs: number, sidecar: SidecarState): MarketStatus {
  const session = inTradingSession(nowMs);
  const today = beijingDate(nowMs);
  let updatedAt: string | null = null;

  const indices: IndexStatus[] = MARKET_INDICES.map((d) => {
    const r = getRealtime(d.key) as any;
    if (!r || r.price == null) {
      return { name: d.name, code: d.key, point: null, prevClose: null, changePct: null, basis: '收盘' as const };
    }
    if (r.fetched_at && (!updatedAt || r.fetched_at > updatedAt)) updatedAt = r.fetched_at;
    const isToday = cnDate(r.fetched_at) === today;
    const prev = r.prev_close ?? null;
    const changePct = prev ? ((r.price - prev) / prev) * 100 : null;
    return {
      name: d.name,
      code: d.key,
      point: r.price,
      prevClose: prev,
      changePct,
      basis: session && isToday ? '实时' : '收盘',
    };
  });

  const alerts = getDataAlerts(sidecar);
  const alertLevel: AlertLevel | null = alerts.some((a) => a.level === 'error')
    ? 'error'
    : alerts.some((a) => a.level === 'warn')
      ? 'warn'
      : null;

  return { updatedAt, indices, alerts, alertLevel };
}
```
> 确认 `alerts.ts` 已 export `Alert`/`SidecarState`/`AlertLevel`(已 export AlertLevel/SidecarState/Alert)。`getRealtime`/`inTradingSession`/`MARKET_INDICES` 来自 service。

- [ ] **Step 6: 运行确认通过 + 回归** — `cd ~/projects/stock-agent/backend && npx jest market-status -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/data/sidecar.ts backend/src/data/service.ts backend/src/data/market-status.ts backend/src/data/market-status.test.ts
git commit -m "feat(market): ingestRealtime 顺带缓存5指数 + getMarketStatus(实时/收盘 + 复用告警)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端路由 `GET /api/market/status`（TDD）

**Files:** Create `backend/src/routes/market.ts`、`backend/src/routes/market.test.ts`；Modify `backend/src/index.ts`

- [ ] **Step 1: 写失败测试 `backend/src/routes/market.test.ts`**（仿 strategy.test.ts 的 app/userTok/h）

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mktroute-'));
delete process.env.REGISTRATION_MODE;

const { createApp } = require('../index');
const app = createApp();

let userTok = '';
beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'stock-agent', password: 'sg123456', agreed: true });
  const tok = login.body.data.accessToken;
  const inv = await request(app).post('/api/settings/users/invite').set('Authorization', `Bearer ${tok}`);
  const reg = await request(app).post('/api/auth/register').send({ username: 'plainu', password: 'secret123', inviteCode: inv.body.data.code, agreed: true });
  userTok = reg.body.data.accessToken;
});
const h = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('market status route', () => {
  it('GET /api/market/status 返回结构(普通用户可访问)', async () => {
    const res = await request(app).get('/api/market/status').set(h(userTok));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.indices)).toBe(true);
    expect(res.body.data.indices).toHaveLength(5);
    expect(res.body.data).toHaveProperty('updatedAt');
    expect(res.body.data).toHaveProperty('alertLevel');
  });
  it('未登录 401', async () => {
    expect((await request(app).get('/api/market/status')).status).toBe(401);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest routes/market -i`。Expected: FAIL（404）。

- [ ] **Step 3: 实现 `backend/src/routes/market.ts`**

```ts
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { successResponse } from '../utils/response';
import { resolveSidecarBase, pingHealth } from '../data/sidecar';
import { getMarketStatus } from '../data/market-status';
import { SidecarState } from '../data/alerts';

const router = Router();
router.use(authMiddleware);

router.get('/status', async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  let sidecar: SidecarState;
  if (!base) sidecar = 'unconfigured';
  else sidecar = (await pingHealth(base)) ? 'ok' : 'down';
  successResponse(res, getMarketStatus(Date.now(), sidecar));
});

export default router;
```

- [ ] **Step 4: 挂载 `backend/src/index.ts`** — import `import marketRoutes from './routes/market';`;在 `app.use('/api/strategy', ...)` 附近加 `app.use('/api/market', marketRoutes);`(纯读，不挂 aiLimiter)。

- [ ] **Step 5: 运行确认通过 + 回归** — `cd ~/projects/stock-agent/backend && npx jest routes/market -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/routes/market.ts backend/src/routes/market.test.ts backend/src/index.ts
git commit -m "feat(api): GET /api/market/status(用户,大盘状态+告警)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前端 状态条

**Files:** Create `frontend/src/api/market.ts`、`frontend/src/views/MarketStatusBar.vue`；Modify `frontend/src/views/HomeView.vue`

- [ ] **Step 1: `frontend/src/api/market.ts`**

```ts
import api from './client';

export interface IndexStatus { name: string; code: string; point: number | null; prevClose: number | null; changePct: number | null; basis: '实时' | '收盘' }
export interface MarketAlert { level: 'error' | 'warn'; source: string; message: string }
export interface MarketStatus { updatedAt: string | null; indices: IndexStatus[]; alerts: MarketAlert[]; alertLevel: 'error' | 'warn' | null }

export const marketApi = {
  status: () => api.get<{ data: MarketStatus }>('/market/status'),
};
```

- [ ] **Step 2: 创建 `frontend/src/views/MarketStatusBar.vue`**

```vue
<template>
  <div v-if="st" class="market-bar" :class="st.alertLevel || ''">
    <div class="indices">
      <span v-for="ix in st.indices" :key="ix.code" class="ix">
        <span class="ix-name">{{ ix.name }}</span>
        <template v-if="ix.point != null">
          <b :class="pctClass(ix.changePct)">{{ ix.point.toFixed(2) }}</b>
          <span v-if="ix.changePct != null" class="ix-pct" :class="pctClass(ix.changePct)">{{ ix.changePct >= 0 ? '+' : '' }}{{ ix.changePct.toFixed(2) }}%</span>
        </template>
        <span v-else class="muted">—</span>
      </span>
    </div>
    <div class="right">
      <button v-if="st.alertLevel" class="alert-toggle" @click="alertsOpen = !alertsOpen">⚠ 数据异常 {{ st.alerts.length }} 条</button>
      <span class="muted updated">数据更新于 {{ fmtUpdated(st.updatedAt) }}</span>
    </div>
    <div v-if="alertsOpen && st.alerts.length" class="alert-pop">
      <div v-for="(a, i) in st.alerts" :key="i" class="alert-row" :class="a.level">
        <span class="badge">{{ a.level === 'error' ? '错误' : '警告' }}</span> {{ a.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { marketApi, type MarketStatus } from '../api/market';

const st = ref<MarketStatus | null>(null);
const alertsOpen = ref(false);
let timer: number | undefined;

function pctClass(p: number | null) { return p == null ? '' : p >= 0 ? 'up' : 'down'; }
function fmtUpdated(s: string | null) { return s ? String(s).slice(0, 16) : '—'; }
async function load() {
  try { st.value = (await marketApi.status()).data.data; } catch { /* ignore */ }
}
onMounted(() => { load(); timer = window.setInterval(load, 30000); });
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.market-bar { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 6px 12px; border-top: 1px solid var(--border, #e5e5e5); font-size: 12px; background: var(--surface, #fff); }
.market-bar.error { background: #fdecec; }
.market-bar.warn { background: #fff7e6; }
.indices { display: flex; gap: 14px; flex-wrap: wrap; }
.ix { display: inline-flex; align-items: center; gap: 4px; }
.ix-name { color: var(--muted, #888); }
.ix-pct { font-size: 11px; }
.up { color: #d33; }
.down { color: #2a8a2a; }
.right { display: flex; align-items: center; gap: 12px; }
.alert-toggle { background: none; border: none; cursor: pointer; color: #a40000; font-weight: 600; }
.market-bar.warn .alert-toggle { color: #a76b00; }
.updated { white-space: nowrap; }
.alert-pop { position: absolute; bottom: 110%; right: 8px; z-index: 60; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.12); padding: 8px 10px; max-width: 480px; }
.alert-row { font-size: 12px; padding: 2px 0; }
.alert-row .badge { font-size: 10px; padding: 0 6px; border-radius: 8px; color: #fff; margin-right: 6px; }
.alert-row.error .badge { background: #d33; }
.alert-row.warn .badge { background: #d9a300; }
</style>
```

- [ ] **Step 3: HomeView 挂载(普通用户聊天区底部)**

3a. 顶部 import：`import MarketStatusBar from './MarketStatusBar.vue';`。
3b. 在聊天区 `<section v-else class="chat">` 的**末尾**(该 section 闭合 `</section>` 之前、聊天主体之后)加：
```vue
        <MarketStatusBar v-if="!auth.isAdmin" />
```
> 放在 `.chat` section 内底部,常驻于聊天区下方。admin 无该 section(admin 走 settingsKey 面板),`v-if="!auth.isAdmin"` 双保险。先 Read 该 section 结构确认插入点(聊天主体 `chat-row`/`msgs` 之后、`</section>` 前)。

- [ ] **Step 4: 类型检查 + 走查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。
走查：聊天区底部出现状态条(5 指数+涨跌色+更新时间);有 error→红条/warn→黄条 + 「⚠ 数据异常 N 条」点击展开明细;30s 轮询;admin 不显示。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/market.ts frontend/src/views/MarketStatusBar.vue frontend/src/views/HomeView.vue
git commit -m "feat(home): 聊天区底部大盘状态条(5指数+更新时间+数据告警高亮,30s轮询)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收

1. `cd ~/projects/stock-agent/backend && npx jest market-status routes/market -i` → 全绿;`npm test` 全绿。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证：`docker compose up -d --build` 后——
   - `curl localhost:8000/index/sh000001` 等 5 个返回(北证可能 null)。
   - 交易时段触发 realtime cron(或等)→ `realtime_quote` 出现 `sh000001` 等行。
   - 普通用户聊天区底部状态条显示 5 指数点数(盘中实时/否则收盘)+更新时间;停掉 sidecar → 状态条变红 + 「数据异常」点击见 sidecar 告警明细。
   - admin 登录无状态条。
