# Phase A：提议内联 + 菜单重排 + 探测进度条 + easyquotation 实时快照

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"提议修改规则"的反馈/确认/新原则展示全部搬进对话框；顶栏菜单重排；数据源探测加进度条；接入 easyquotation 作为个股快照的实时现价源。

**Architecture:** 纯前端改 `HomeView.vue`（提议内联+采纳后追加助手消息+菜单重排）；探测改为 sidecar 按 provider 单独探测 + 前端进度条；easyquotation 作为 sidecar `/realtime/{code}` 端点 + Node `fetchRealtime` + `getStockSnapshot` 增 `realtime` 字段。

**Tech Stack:** Vue3+TS（前端无单测，gate=`cd frontend && npx vue-tsc --noEmit`）；Node/Express+TS（jest，tmp DATA_DIR+require，fetch mock）；Python FastAPI sidecar（无 pytest，一次性脚本验证）。本地 dev 容器：`stock-agent-app-1`、`stock-agent-akshare-mcp-1`，`docker compose up -d --build` 重建。

**约定：** ChatMessage 形状 `{ id, role, content, created_at }`（HomeView 渲染用）。ProbeResult `{ key,label,reachable,latencyMs,error }`。

---

## Task 1: A4 顶栏菜单重排

**Files:** Modify `frontend/src/views/HomeView.vue`（`SETTINGS` 数组，约 206–214 行）

- [ ] **Step 1: 改 SETTINGS 顺序**

把 `SETTINGS` 数组改为（聊天为默认首 tab，不在数组内；其余按指定顺序）：
```ts
const SETTINGS = [
  { key: 'rulebook', label: '核心规则', icon: '📜', comp: RulebookView },
  { key: 'meetings', label: '早晚会历史', icon: '🗓', comp: MeetingsHistoryView },
  { key: 'analysis', label: '分析历史', icon: '📊', comp: AnalysisView },
  { key: 'data', label: '数据', icon: '📈', comp: DataView },
  { key: 'ai', label: 'AI 模型', icon: '🤖', comp: AiSettingsView },
  { key: 'plugins', label: '能力插件', icon: '🧩', comp: PluginsView },
  { key: 'account', label: '账号设置', icon: '👤', comp: SettingsView },
];
```

- [ ] **Step 2: 验证**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 0 errors。冒烟：顶栏顺序为 聊天 · 核心规则 · 早晚会历史 · 分析历史 · 数据 · AI模型 · 能力插件 · 账号设置。

- [ ] **Step 3: Commit**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 顶栏菜单重排（核心规则·早晚会·分析·数据·AI·插件·账号）"
```

---

## Task 2: A1 提议反馈内联进对话框

**Files:** Modify `frontend/src/views/HomeView.vue`（模板：把 `.proposal` 块从 `<aside>` 移到 `.msgs` 消息流内）

- [ ] **Step 1: 把提议结果卡片移入对话流**

在 `<div class="msgs" ref="msgsEl">` 内、消息 `v-for` 与 `sending` typing 提示之后，追加提议卡片（作为一条助手样式的内联卡）：
```html
        <div v-if="sending" class="msg assistant"><div class="bubble typing">思考中…</div></div>

        <!-- 提议卡片：内联在对话流里 -->
        <div v-if="proposal" class="msg assistant">
          <div class="bubble proposal-card">
            <h4>修改提议（{{ proposal.magnitude === 'major' ? '较大改动' : '微调' }}）：{{ proposal.currentLabel }} → <b>{{ proposal.suggestedLabel }}</b></h4>
            <p v-if="proposal.delta.personaChanged">· 人设有改动</p>
            <p v-for="c in proposal.delta.gates.changed" :key="c.gate_key">· 门槛 <b>{{ c.gate_key }}</b>：{{ c.from.threshold }} → {{ c.to.threshold }}</p>
            <p v-for="k in proposal.delta.gates.added" :key="'a'+k">· 新增门槛 {{ k }}</p>
            <p v-for="k in proposal.delta.gates.removed" :key="'r'+k">· 删除门槛 {{ k }}</p>
            <p v-if="proposal.delta.softRules.added.length || proposal.delta.softRules.removed.length">· 软判断 +{{ proposal.delta.softRules.added.length }} / -{{ proposal.delta.softRules.removed.length }}</p>
            <p v-if="proposal.delta.positionRulesChangedKeys.length">· 仓位规则改动：{{ proposal.delta.positionRulesChangedKeys.join('、') }}</p>
            <p v-if="noChange" class="muted">无实质改动</p>
            <p v-if="proposal.proposal.note" class="muted">理由：{{ proposal.proposal.note }}</p>
            <div class="ops">
              <button :disabled="applying || noChange" @click="applyProposal">采纳并升级到 {{ proposal.suggestedLabel }}</button>
              <button @click="proposal = null">放弃</button>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: 从 `<aside>` 删除原 `.proposal` 块**

删除 aside 里原来的 `<div v-if="proposal" class="proposal"> … </div>` 整块（保留 `.propose-bar` 触发按钮不动）。同时把原块里的 `<p v-if="applyMsg" class="ok-msg">` 也一并删除（采纳后改为对话消息，见 Task 3）。

- [ ] **Step 3: 加一点卡片样式（scoped）**

在 `<style scoped>` 加：
```css
.proposal-card h4 { margin: 0 0 6px; font-size: 14px; }
.proposal-card p { margin: 2px 0; font-size: 13px; }
.proposal-card .ops { margin-top: 8px; display: flex; gap: 8px; }
```

- [ ] **Step 4: 验证**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 0 errors。冒烟：核心原则会话里点「让 agent 提议修改规则」，提议结果与采纳/放弃按钮出现在**对话流**底部（不在右侧面板）。

- [ ] **Step 5: Commit**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 规则修改提议改为内联在对话流展示（含采纳/放弃）"
```

---

## Task 3: A2 采纳后在对话框展示最新核心原则

**Files:** Modify `frontend/src/views/HomeView.vue`（`applyProposal()`）

- [ ] **Step 1: 采纳成功后向对话追加一条助手消息（新原则）**

把 `applyProposal()` 改为：
```ts
async function applyProposal() {
  if (!proposal.value) return;
  applying.value = true;
  try {
    const label = proposal.value.suggestedLabel;
    await rulebookApi.apply(label, proposal.value.proposal);
    proposal.value = null;
    activeRulebook.value = (await rulebookApi.getActive()).data.data;   // 顶部 briefing 自动刷新
    messages.value.push({
      id: 'local-applied-' + Date.now(),
      role: 'assistant',
      content: `✅ 已采纳，规则升级到 ${label}。\n\n` + buildCpBriefing(activeRulebook.value),
      created_at: new Date().toISOString(),
    } as ChatMessage);
    await nextTick();
    if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '采纳失败';
  } finally {
    applying.value = false;
  }
}
```
确保 `nextTick` 已从 `vue` 导入（若未导入，在顶部 `import { ..., nextTick } from 'vue'`）。`ChatMessage` 类型若已在文件中 import 即复用；`buildCpBriefing` 已存在。删除已不再使用的 `applyMsg` ref（若别处无引用）。

- [ ] **Step 2: 验证**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 0 errors。冒烟：采纳后对话里出现「✅ 已采纳，规则升级到 Vx.y … 当前核心原则…」，顶部 briefing 同步更新。

- [ ] **Step 3: Commit**
```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(ui): 采纳规则后在对话框展示最新核心原则"
```

---

## Task 4: A5 sidecar 按 provider 单独探测 + 列表端点

**Files:** Modify `sidecar/main.py`（`/probe` 加 `provider` 参数；新增 `/probe/list`）

- [ ] **Step 1: 改 `/probe` 支持单 provider + 加 `/probe/list`**

替换现有 `@app.get("/probe")`：
```python
@app.get("/probe/list")
def probe_list(kind: str = "quote"):
    return [{"key": r["key"], "label": r["label"]} for r in PROVIDERS.get(kind, [])]

@app.get("/probe")
def probe(kind: str = "quote", provider: str = ""):
    regs = PROVIDERS.get(kind, [])
    if provider:
        regs = [r for r in regs if r["key"] == provider]
    return [_probe_one(reg, kind) for reg in regs]
```

- [ ] **Step 2: 重建并验证**
```bash
docker compose up -d --build akshare-mcp
docker exec stock-agent-akshare-mcp-1 python -c "import urllib.request,json; print('list', urllib.request.urlopen('http://localhost:8000/probe/list?kind=quote').read().decode()); print('one', urllib.request.urlopen('http://localhost:8000/probe?kind=quote&provider=sina').read().decode()[:200])"
```
Expected: list 返回 4 个 `{key,label}`；one 只返回 sina 一条探测结果。

- [ ] **Step 3: Commit**
```bash
git add sidecar/main.py
git commit -m "feat(sidecar): /probe 支持单 provider 探测 + /probe/list"
```

---

## Task 5: A5 Node 客户端 + 路由（TDD）

**Files:** Modify `backend/src/data/sidecar.ts`、`backend/src/routes/data.ts`、`frontend/src/api/data.ts`；Test `backend/src/data/sidecar.test.ts`、`backend/src/routes/data.test.ts`

- [ ] **Step 1: 写失败测试（sidecar 客户端）**

`backend/src/data/sidecar.test.ts` 加：
```ts
it('probeList 返回 provider 列表；probeOne 返回单条', async () => {
  const sc = require('./sidecar');
  (global as any).fetch = jest.fn((u: string) =>
    u.includes('/probe/list')
      ? Promise.resolve({ ok: true, json: async () => [{ key: 'sina', label: '新浪' }, { key: 'tx', label: '腾讯' }] })
      : Promise.resolve({ ok: true, json: async () => [{ key: 'sina', label: '新浪', reachable: true, latency_ms: 100, error: null }] }));
  expect((await sc.probeList('http://x', 'quote')).map((p: any) => p.key)).toEqual(['sina', 'tx']);
  const one = await sc.probeOne('http://x', 'quote', 'sina');
  expect(one.key).toBe('sina'); expect(one.latencyMs).toBe(100);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data/sidecar.test.ts -t "probeList" -i` → FAIL。

- [ ] **Step 3: 实现 sidecar.ts**

加（`probe` 已存在，复用其映射逻辑）：
```ts
export async function probeList(base: string, kind: string): Promise<Array<{ key: string; label: string }>> {
  const data = await getJson(`${base}/probe/list?kind=${encodeURIComponent(kind)}`);
  if (!Array.isArray(data)) return [];
  return data.map((p: any) => ({ key: String(p.key), label: String(p.label ?? p.key) }));
}

export async function probeOne(base: string, kind: string, provider: string): Promise<ProbeResult | null> {
  const data = await getJson(`${base}/probe?kind=${encodeURIComponent(kind)}&provider=${encodeURIComponent(provider)}`);
  if (!Array.isArray(data) || !data[0]) return null;
  const p = data[0];
  return { key: String(p.key), label: String(p.label ?? p.key), reachable: !!p.reachable, latencyMs: p.latency_ms == null ? null : Number(p.latency_ms), error: p.error == null ? null : String(p.error) };
}
```

- [ ] **Step 4: 路由 + 前端 api**

`backend/src/routes/data.ts`：在现有 `/probe` 路由旁加 `/probe/list`，并让 `/probe` 透传 `provider`：
```ts
router.get('/probe/list', async (req, res) => {
  const base = resolveSidecarBase(req.user!.userId);
  if (!base) return successResponse(res, []);
  successResponse(res, await probeList(base, String(req.query.kind || 'quote')));
});
```
把现有 `/probe` handler 改为透传 provider：`successResponse(res, await probe(base, kind, String(req.query.provider || '')))`，并把 `sidecar.ts` 的 `probe(base, kind)` 签名加可选 `provider?: string` 透传到 URL（`&provider=` 当有值时）。导入 `probeList, probeOne`。
`frontend/src/api/data.ts` 加：
```ts
probeList: (kind = 'quote') => api.get('/data/probe/list?kind=' + kind).then((r) => r.data.data as Array<{ key: string; label: string }>),
probeOne: (kind: string, provider: string) => api.get(`/data/probe?kind=${kind}&provider=${provider}`).then((r) => (r.data.data[0] || null) as { key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null } | null),
```

- [ ] **Step 5: 跑测试确认通过 + 全套 + tsc**

Run: `cd backend && npx jest -i && npx tsc --noEmit` → 全绿、tsc 干净。

- [ ] **Step 6: Commit**
```bash
git add backend/src/data/sidecar.ts backend/src/data/sidecar.test.ts backend/src/routes/data.ts frontend/src/api/data.ts
git commit -m "feat(data): probeList/probeOne 客户端 + 路由 + 前端 api（按源单独探测）"
```

---

## Task 6: A5 前端探测进度条

**Files:** Modify `frontend/src/views/DataView.vue`

- [ ] **Step 1: runProbe 改为逐源探测 + 进度**

把 `runProbe` 改为：
```ts
const probeProgress = ref<{ done: number; total: number } | null>(null);
async function runProbe() {
  busy.value = true;
  providers.value = [];
  try {
    const list = await dataApi.probeList('quote');
    probeProgress.value = { done: 0, total: list.length };
    for (const it of list) {
      const r = await dataApi.probeOne('quote', it.key);
      providers.value.push(r ?? { key: it.key, label: it.label, reachable: false, latencyMs: null, error: '探测失败' });
      probeProgress.value.done++;
    }
  } finally {
    busy.value = false;
    probeProgress.value = null;
  }
}
```
（`providers` ref 已存在；确保 `ref` 已导入。）

- [ ] **Step 2: 模板加进度条**

在「行情上游」section 的探测按钮下方加：
```html
        <div v-if="probeProgress" class="probe-progress">
          探测中… {{ probeProgress.done }}/{{ probeProgress.total }}
          <div class="bar"><div class="fill" :style="{ width: (probeProgress.total ? probeProgress.done / probeProgress.total * 100 : 0) + '%' }"></div></div>
        </div>
```
`<style scoped>` 加：
```css
.probe-progress { margin: 6px 0; font-size: 13px; color: #666; }
.probe-progress .bar { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin-top: 4px; }
.probe-progress .fill { height: 100%; background: var(--accent, #e5484d); transition: width .2s; }
```

- [ ] **Step 3: 验证**

Run: `cd frontend && npx vue-tsc --noEmit` → 0 errors。冒烟：点「探测」出现进度条，逐个源填入结果。

- [ ] **Step 4: Commit**
```bash
git add frontend/src/views/DataView.vue
git commit -m "feat(ui): 数据源探测加进度条（逐源探测、实时进度）"
```

---

## Task 7: easyquotation sidecar 实时快照端点

**Files:** Modify `sidecar/requirements.txt`、`sidecar/main.py`

- [ ] **Step 1: 加依赖**

`sidecar/requirements.txt` 追加一行：
```
easyquotation
```

- [ ] **Step 2: 加 `/realtime/{code}` 端点**

`sidecar/main.py` 加（放在 quote 相关路由附近）：
```python
@app.get("/realtime/{code}")
def realtime(code: str):
    code = code[-6:]
    def _fn():
        import easyquotation
        eq = easyquotation.use("sina")
        d = eq.real([code], prefix=False) or {}
        row = d.get(code) or {}
        if not row:
            return None
        return {
            "price": _f(row.get("now")),
            "open": _f(row.get("open")),
            "high": _f(row.get("high")),
            "low": _f(row.get("low")),
            "prev_close": _f(row.get("close")),
            "volume": _f(row.get("volume") or row.get("turnover")),
            "name": row.get("name"),
            "time": (str(row.get("date", "")) + " " + str(row.get("time", ""))).strip(),
        }
    data = _timed(_fn, 8)
    return {"source": "sina-rt" if data else None, "data": data or {}}
```

- [ ] **Step 3: 重建并验证**
```bash
docker compose up -d --build akshare-mcp
docker exec stock-agent-akshare-mcp-1 python -c "import urllib.request,json; print(urllib.request.urlopen('http://localhost:8000/realtime/600519').read().decode()[:300])"
```
Expected: `{"source":"sina-rt","data":{"price":<现价>,...,"name":"贵州茅台",...}}`（新浪在本机可达）。

- [ ] **Step 4: Commit**
```bash
git add sidecar/requirements.txt sidecar/main.py
git commit -m "feat(sidecar): /realtime/{code} 实时快照（easyquotation·新浪）"
```

---

## Task 8: easyquotation Node 客户端 + 个股快照实时现价（TDD）

**Files:** Modify `backend/src/data/sidecar.ts`、`backend/src/data/service.ts`、`backend/src/types/index.ts`；Test `backend/src/data/sidecar.test.ts`、`backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**

`sidecar.test.ts`：
```ts
it('fetchRealtime 解析 {source, data}', async () => {
  (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({ source: 'sina-rt', data: { price: 1688.5, name: '贵州茅台', time: '2026-06-07 15:00:00' } }) }));
  const r = await require('./sidecar').fetchRealtime('http://x', '600519');
  expect(r.source).toBe('sina-rt'); expect(r.data.price).toBe(1688.5);
});
```
`service.test.ts`（getStockSnapshot 含 realtime）：
```ts
it('getStockSnapshot 带 realtime 现价(best-effort)', async () => {
  const svc = require('./service');
  require('./sources-service').ensureSeedGlobal?.();
  (global as any).fetch = jest.fn((u: string) =>
    u.includes('/realtime') ? Promise.resolve({ ok: true, json: async () => ({ source: 'sina-rt', data: { price: 10.5, time: 't' } }) })
    : Promise.resolve({ ok: true, json: async () => ({ source: null, rows: [], data: {} }) }));
  const snap = await svc.getStockSnapshot('u1', '600519');
  expect(snap).toHaveProperty('realtime');
  expect(snap.realtime?.price).toBe(10.5);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx jest src/data -t "fetchRealtime|realtime 现价" -i` → FAIL。

- [ ] **Step 3: 实现**

`sidecar.ts`：
```ts
export async function fetchRealtime(base: string, code: string): Promise<{ source: string | null; data: Record<string, unknown> } | null> {
  const d = await getJson(`${base}/realtime/${code}`);
  if (!d || !d.data) return null;
  return { source: d.source ?? null, data: d.data };
}
```
`types/index.ts`：在 `StockSnapshot` 接口加 `realtime?: { price: number; time: string; source: string | null } | null;`。
`service.ts getStockSnapshot`：在 `return snap;` 之前加（best-effort，不阻塞）：
```ts
  snap.realtime = null;
  try {
    const base = resolveSidecarBase(userId);
    if (base) {
      const rt = await fetchRealtime(base, code);
      const price = rt?.data?.price;
      if (rt && price != null) snap.realtime = { price: Number(price), time: String(rt.data.time ?? ''), source: rt.source };
    }
  } catch { /* ignore */ }
```
导入 `fetchRealtime`。

- [ ] **Step 4: 跑测试确认通过 + 全套 + tsc**

Run: `cd backend && npx jest -i && npx tsc --noEmit` → 全绿、tsc 干净。

- [ ] **Step 5: Commit**
```bash
git add backend/src/data/sidecar.ts backend/src/data/service.ts backend/src/types/index.ts backend/src/data/*.test.ts
git commit -m "feat(data): fetchRealtime + getStockSnapshot 实时现价字段（easyquotation）"
```

---

## Task 9: 前端个股快照展示实时现价

**Files:** Modify `frontend/src/views/DataView.vue`（个股快照展示处）、`frontend/src/types`（若 StockSnapshot 在前端另有类型，补 `realtime?`）

- [ ] **Step 1: 快照区展示实时现价**

在 DataView 的个股快照展示块（渲染 snapshot 字段处）加一行：
```html
        <div v-if="snapshot?.realtime" class="rt">
          实时现价：<b>{{ snapshot.realtime.price }}</b>
          <span class="muted" v-if="snapshot.realtime.time"> @ {{ snapshot.realtime.time }}（{{ snapshot.realtime.source }}）</span>
        </div>
```
若前端有独立的 `StockSnapshot` TS 类型（如 `frontend/src/types`），补 `realtime?: { price: number; time: string; source: string | null } | null`。

- [ ] **Step 2: 验证**

Run: `cd frontend && npx vue-tsc --noEmit` → 0 errors。冒烟：查个股快照时显示「实时现价 … @ 时间（sina-rt）」。

- [ ] **Step 3: Commit**
```bash
git add frontend/src/views/DataView.vue frontend/src/types
git commit -m "feat(ui): 个股快照展示实时现价"
```

---

## Task 10: 端到端验证

- [ ] **Step 1: 重建全栈**
```bash
docker compose up -d --build
```

- [ ] **Step 2: 后端全套 + 前端类型**
```bash
cd backend && npx jest
cd ../frontend && npx vue-tsc --noEmit
```
Expected: 后端全绿；前端 0 errors。

- [ ] **Step 3: 冒烟（容器内）**
```bash
docker exec stock-agent-akshare-mcp-1 python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/realtime/600519').read().decode()[:200])"
```
Expected: 实时快照有 price。手动在 UI 验证：菜单顺序、提议内联+采纳后新原则消息、探测进度条、个股快照实时现价。

---

## Self-Review

- **Spec 覆盖（Phase A）**：A1 提议内联(Task2)、A2 采纳后展示新原则(Task3)、A4 菜单(Task1)、A5 探测进度条(Task4/5/6)、easyquotation 实时快照(Task7/8/9)、e2e(Task10) —— 均有任务。账号设置可见性 spec 判定无需改，未列任务（正确）。
- **Placeholder**：无 TBD；每改代码步含真实代码。
- **类型一致**：`ProbeResult{key,label,reachable,latencyMs,error}`、`probeList/probeOne`、`fetchRealtime{source,data}`、`StockSnapshot.realtime{price,time,source}` 贯穿 sidecar→Node→前端一致；ChatMessage `{id,role,content,created_at}` 与现有渲染一致。
