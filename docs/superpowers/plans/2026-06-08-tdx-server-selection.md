# 通达信行情服务器测速选用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 admin 在数据页测全部 142 个通达信服务器的速度并选用某个（或自动选最快），通达信卡片置顶为主力源、HTTP 数据源降为交叉验证/备选。

**Architecture:** sidecar `tdx.py` 加服务器列表/测速/选用 + `_get_client` 支持 pin；`main.py` 加 `/tdx/servers/test`、`GET/POST /tdx/server`。后端 `service.ts` 存选择于 `settings`、`sidecar.ts` 加调用、`routes/data.ts` 加 admin 代理、`index.ts` 启动重推。前端 DataView 数据源标签重排卡片 + 新「通达信行情服务器」卡片 + 主次说明。

**Tech Stack:** Python/FastAPI/mootdx 0.11.7（sidecar）；Node/Express/better-sqlite3（后端）；Vue 3（前端）；jest+supertest。

**已验证 mootdx 0.11.7 API：** `from mootdx.server import hosts`→`hosts['HQ']`=`[{site,addr,port,time}]`(142)；`Quotes.factory(market='std', server=(addr,int(port)), bestip=False, timeout=2, raise_exception=True)` 可 pin；`c.stock_count(market=1)` 是轻量校验查询；仅 TCP 连通不够（死服务器也接受连接）。

**契约/锚点：**
- `sidecar/tdx.py`：已有 `_lock/_client/_get_client/_reset/_call/_f`、`bars_qfq` 等；`_get_client` 当前 `Quotes.factory(market="std")`。`sidecar/tdx_test.py` 在容器内 `python tdx_test.py` 跑（host 无 mootdx）。
- `sidecar/main.py`：`import tdx` 已有；`_timed(fn, sec)`。
- 后端 `data/service.ts`：`getDb()` 可用；`settings` 为 key/value 表（`INSERT ... ON CONFLICT(key) DO UPDATE SET value=excluded.value`）。
- 后端 `data/sidecar.ts`：`getJson(url, ms)`、`resolveSidecarBase(userId)`。
- 后端 `routes/data.ts`：`adminMiddleware`、`successResponse`、`errorResponse`、`z`、`import * as svc`、`resolveSidecarBase`；新路由注册在 `const SHARED_JOBS`(行 ~168) **之前**（避免被 `/:job/*` 遮蔽）。测试 `routes/data.test.ts`：`h()`=admin、`uh()`=非 admin。
- 后端 `index.ts`：启动块在行 ~100-109（`syncTradeCalendar` 那段）。
- 前端 `DataView.vue`：数据源标签 `<div v-show="tab === 'source'">`(行 26) 内含「数据源管理」card(27-57) 与「行情上游(探测择优)」card(58-77)，组结束 `</div>`(行 78 前)。CSV 卡在「工具」标签 `<h2>上传行情 CSV…</h2>`(行 170)。`api/data.ts` 末尾 dataApi 对象。

---

### Task 1: sidecar `tdx.py` 服务器列表/测速/选用 + pin

**Files:**
- Modify: `sidecar/tdx.py`
- Modify: `sidecar/tdx_test.py`

- [ ] **Step 1: 写失败测试（追加到 `sidecar/tdx_test.py`）**

在 `if __name__` 块**之前**加：
```python
def test_set_get_server():
    from tdx import set_server, get_server
    set_server('1.2.3.4', 7709)
    assert get_server() == {'addr': '1.2.3.4', 'port': 7709}
    set_server('', 0)
    assert get_server() is None

def test_list_servers():
    from tdx import list_servers
    s = list_servers()
    assert len(s) > 100
    assert all('addr' in x and 'port' in x and 'site' in x for x in s[:3])
```
并在 `if __name__ == "__main__":` 的运行序列里加 `test_set_get_server(); test_list_servers();`（在 `print("ALL PASS")` 之前）。

- [ ] **Step 2: 运行确认失败**

```bash
cd /home/zhangjq/projects/stock-agent
docker cp sidecar/tdx_test.py stock-agent-akshare-mcp-1:/app/tdx_test.py
docker exec -w /app stock-agent-akshare-mcp-1 python tdx_test.py
```
Expected: FAIL（`set_server`/`list_servers` 未定义，ImportError）。

- [ ] **Step 3: 实现（编辑 `sidecar/tdx.py`）**

a) 顶部 import 区加：
```python
import time
from concurrent.futures import ThreadPoolExecutor
```
b) 在 `_lock = threading.Lock()` / `_client = None` 旁加：
```python
_server = None  # (addr, port) 选定服务器；None = 自动 bestip
```
c) 把 `_get_client()` 改为支持 pin：
```python
def _get_client():
    global _client
    if _client is None:
        if _server:
            _client = Quotes.factory(market="std", server=_server, bestip=False)
        else:
            _client = Quotes.factory(market="std")  # 自动 bestip
    return _client
```
d) 文件末尾加：
```python
def list_servers():
    """142 个通达信行情服务器 [{site,addr,port}]（静态列表，无网络）。"""
    from mootdx.server import hosts
    return [{"site": h.get("site"), "addr": h.get("addr"), "port": int(h.get("port"))} for h in hosts.get("HQ", [])]


def _probe_server(h):
    t0 = time.perf_counter()
    try:
        c = Quotes.factory(market="std", server=(h["addr"], int(h["port"])), bestip=False, timeout=2, raise_exception=True)
        n = c.stock_count(market=1)            # 真实 TDX 查询验证（仅 TCP 不够）
        ok = bool(n and int(n) > 0)
        try: c.close()
        except Exception: pass
        return {"site": h["site"], "addr": h["addr"], "port": int(h["port"]),
                "ok": ok, "latency_ms": round((time.perf_counter() - t0) * 1000, 1) if ok else None}
    except Exception:
        return {"site": h["site"], "addr": h["addr"], "port": int(h["port"]), "ok": False, "latency_ms": None}


def test_servers():
    """并行测全部服务器（真实查询校验+延迟），按 可用→延迟 排序。约 10-20s。"""
    servers = list_servers()
    out = []
    with ThreadPoolExecutor(max_workers=24) as ex:
        for r in ex.map(_probe_server, servers):
            out.append(r)
    out.sort(key=lambda x: (not x["ok"], x["latency_ms"] if x["latency_ms"] is not None else 9e9))
    return out


def get_server():
    return {"addr": _server[0], "port": _server[1]} if _server else None


def set_server(addr, port):
    """addr 空 → 自动 bestip；否则 pin (addr,port)。重置客户端以即时生效。"""
    global _server
    if addr and str(addr).strip():
        _server = (str(addr).strip(), int(port))
    else:
        _server = None
    _reset()
```

- [ ] **Step 4: 运行确认通过**

```bash
cd /home/zhangjq/projects/stock-agent
docker cp sidecar/tdx.py stock-agent-akshare-mcp-1:/app/tdx.py
docker cp sidecar/tdx_test.py stock-agent-akshare-mcp-1:/app/tdx_test.py
docker exec -w /app stock-agent-akshare-mcp-1 python tdx_test.py
```
Expected: `ALL PASS`（含 set/get/list；test_servers 不在单测里，靠 Task 2 实连）。

- [ ] **Step 5: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add sidecar/tdx.py sidecar/tdx_test.py
git commit -m "feat(sidecar): tdx 服务器列表/测速(真实查询校验)/选用 + _get_client 支持 pin

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: sidecar `main.py` 端点 + 实连验证

**Files:**
- Modify: `sidecar/main.py`

- [ ] **Step 1: 加端点**

在 `sidecar/main.py` 末尾（任意路由区）加：
```python
@app.get("/tdx/servers/test")
def tdx_servers_test():
    return {"servers": tdx.test_servers()}


@app.get("/tdx/server")
def tdx_server_get():
    return {"server": tdx.get_server()}


@app.post("/tdx/server")
def tdx_server_set(addr: str = "", port: int = 0):
    tdx.set_server(addr, port)
    return {"server": tdx.get_server()}
```

- [ ] **Step 2: 重启 + 实连验证**

```bash
cd /home/zhangjq/projects/stock-agent
docker cp sidecar/main.py stock-agent-akshare-mcp-1:/app/main.py
docker compose restart akshare-mcp && sleep 4
docker exec stock-agent-akshare-mcp-1 python - <<'PY'
import urllib.request, json
def g(path, method="GET"):
    req = urllib.request.Request("http://localhost:8000"+path, method=method)
    return json.load(urllib.request.urlopen(req, timeout=60))
t = g("/tdx/servers/test")["servers"]
ok = [s for s in t if s["ok"]]
print("测速 总数", len(t), "可用", len(ok), "最快", ok[0] if ok else None)
print("set 指定:", g(f"/tdx/server?addr={ok[0]['addr']}&port={ok[0]['port']}", "POST"))
print("get:", g("/tdx/server"))
print("set 自动:", g("/tdx/server?addr=&port=0", "POST"))
PY
```
Expected: 总数 ~142、可用若干、`set 指定` 返回该 server、`get` 一致、`set 自动` 返回 `{"server": null}`。若 0 可用，报告（可能线路/服务器列表问题，不要伪造）。

- [ ] **Step 3: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add sidecar/main.py
git commit -m "feat(sidecar): /tdx/servers/test 与 GET/POST /tdx/server 端点

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 后端 settings 持久化 + sidecar 调用 + admin 路由 + 启动重推

**Files:**
- Modify: `backend/src/data/service.ts`（settings 读写）
- Modify: `backend/src/data/sidecar.ts`（postJson + tdx 调用）
- Modify: `backend/src/routes/data.ts`（admin 代理路由）
- Modify: `backend/src/index.ts`（启动重推）
- Test: `backend/src/routes/data.test.ts`

- [ ] **Step 1: 写失败测试（`routes/data.test.ts`，`describe('data routes')` 内）**

```ts
  it('TDX 服务器选择：admin 可设并读回；非 admin 403', async () => {
    const forbidden = await request(app).post('/api/data/tdx/server').set(uh()).send({ addr: '1.2.3.4', port: 7709 });
    expect(forbidden.status).toBe(403);
    const setOk = await request(app).post('/api/data/tdx/server').set(h()).send({ addr: '1.2.3.4', port: 7709 });
    expect(setOk.status).toBe(200);
    const get1 = await request(app).get('/api/data/tdx/server').set(h());
    expect(get1.body.data.server).toBe('1.2.3.4:7709');
    const auto = await request(app).post('/api/data/tdx/server').set(h()).send({ addr: '' });
    expect(auto.status).toBe(200);
    const get2 = await request(app).get('/api/data/tdx/server').set(h());
    expect(get2.body.data.server).toBe('');
  });
```
Run `cd backend && npx jest src/routes/data.test.ts -t "TDX 服务器" 2>&1 | tail -12` → FAIL（路由不存在）。

- [ ] **Step 2: service.ts settings 读写**

在 `backend/src/data/service.ts` 末尾加：
```ts
// 通达信选定服务器（持久化于 settings；"" = 自动 bestip）
export function getTdxServerSetting(): string {
  const r = getDb().prepare("SELECT value FROM settings WHERE key='tdx_server'").get() as { value: string } | undefined;
  return r?.value || '';
}
export function setTdxServerSetting(val: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('tdx_server', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(val);
}
```

- [ ] **Step 3: sidecar.ts postJson + tdx 调用**

在 `backend/src/data/sidecar.ts` 的 `getJson` 之后加：
```ts
async function postJson(url: string, timeoutMs = 30000): Promise<any | null> {
  try {
    const resp = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function tdxTestServers(base: string): Promise<Array<{ site: string; addr: string; port: number; ok: boolean; latency_ms: number | null }>> {
  const r = await getJson(`${base}/tdx/servers/test`, 40000);
  return Array.isArray(r?.servers) ? r.servers : [];
}

export async function tdxSetServer(base: string, addr: string, port: number): Promise<void> {
  await postJson(`${base}/tdx/server?addr=${encodeURIComponent(addr)}&port=${port}`, 8000);
}
```

- [ ] **Step 4: routes/data.ts admin 代理路由**

在 `import { resolveSidecarBase, pingHealth, probe, probeList, probeOne } from '../data/sidecar';` 改为同时引入新函数：
```ts
import { resolveSidecarBase, pingHealth, probe, probeList, probeOne, tdxTestServers, tdxSetServer } from '../data/sidecar';
```
在 `const SHARED_JOBS = new Set(...)`（行 ~168）**之前**插入：
```ts
// ---- 通达信(TDX)行情服务器：测速 + 选用 ----
router.get('/tdx/servers/test', adminMiddleware, async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  if (!base) return successResponse(res, { servers: [] });
  successResponse(res, { servers: await tdxTestServers(base) });
});
router.get('/tdx/server', (_req: Request, res: Response) => {
  successResponse(res, { server: svc.getTdxServerSetting() });
});
router.post('/tdx/server', adminMiddleware, async (req: Request, res: Response) => {
  const parsed = z.object({ addr: z.string().optional(), port: z.number().int().optional() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  const addr = (parsed.data.addr || '').trim();
  const port = parsed.data.port || 0;
  const base = resolveSidecarBase(req.user!.userId);
  if (base) await tdxSetServer(base, addr, port);
  const val = addr ? `${addr}:${port}` : '';
  svc.setTdxServerSetting(val);
  successResponse(res, { server: val });
});
```

- [ ] **Step 5: index.ts 启动重推**

在 `backend/src/index.ts` 的 `if (admin) syncTradeCalendar(admin.id).catch(() => {});` 之后加：
```ts
    // 重新应用持久化的通达信服务器选择（扛 sidecar 重启）
    const { tdxSetServer } = require('./data/sidecar');
    const { resolveSidecarBase: resolveBase } = require('./data/sidecar');
    const { getTdxServerSetting } = require('./data/service');
    if (admin) {
      const sv = getTdxServerSetting();
      if (sv) {
        const [a, p] = sv.split(':');
        const base = resolveBase(admin.id);
        if (base) tdxSetServer(base, a, Number(p)).catch(() => {});
      }
    }
```
（`resolveSidecarBase` 可能已在该作用域 require 过；若未，用上面的 `resolveBase` 别名导入即可，避免重复声明。实现时若已有 `resolveSidecarBase` 引用则复用，删掉别名行。）

- [ ] **Step 6: 验证 + 全套**

```bash
cd /home/zhangjq/projects/stock-agent/backend
npx jest src/routes/data.test.ts -t "TDX 服务器" 2>&1 | tail -8     # PASS
npm test 2>&1 | tail -5                                            # 全绿（203 + 本用例）
```

- [ ] **Step 7: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add backend/src/data/service.ts backend/src/data/sidecar.ts backend/src/routes/data.ts backend/src/index.ts backend/src/routes/data.test.ts
git commit -m "feat(data): TDX 服务器测速/选用 admin 路由 + settings 持久化 + 启动重推

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 前端 DataView 卡片重排 + 通达信服务器卡片 + 主次说明

**Files:**
- Modify: `frontend/src/api/data.ts`
- Modify: `frontend/src/views/DataView.vue`

- [ ] **Step 1: api 方法**

在 `frontend/src/api/data.ts` 的 dataApi 对象内（`forceStopJob` 之后即可）加：
```ts
  tdxTestServers: () => api.get('/data/tdx/servers/test').then((r) => r.data.data.servers as Array<{ site: string; addr: string; port: number; ok: boolean; latency_ms: number | null }>),
  tdxGetServer: () => api.get('/data/tdx/server').then((r) => r.data.data.server as string),
  tdxSetServer: (addr: string, port: number) => api.post('/data/tdx/server', { addr, port }).then((r) => r.data.data.server as string),
```

- [ ] **Step 2: DataView 脚本状态 + 方法**

在 `frontend/src/views/DataView.vue` `<script setup>` 中（与其它 ref 一起）加：
```ts
const tdxCurrent = ref('');                 // "" = 自动选最快
const tdxServers = ref<Array<{ site: string; addr: string; port: number; ok: boolean; latency_ms: number | null }>>([]);
const tdxTesting = ref(false);
async function loadTdxCurrent() {
  try { tdxCurrent.value = await dataApi.tdxGetServer(); } catch { /* ignore */ }
}
async function testTdx() {
  tdxTesting.value = true;
  try { tdxServers.value = await dataApi.tdxTestServers(); } catch { /* ignore */ } finally { tdxTesting.value = false; }
}
async function pickTdx(addr: string, port: number) {
  try { tdxCurrent.value = await dataApi.tdxSetServer(addr, port); } catch { /* ignore */ }
}
```
并在已有的 `onMounted(...)` 里调用 `loadTdxCurrent()`（与其它初始化加载并列；若 onMounted 是 async 函数，加 `await loadTdxCurrent();`）。

- [ ] **Step 3: 模板——在数据源标签顶部插入通达信卡片**

把 `<div v-show="tab === 'source'">`（行 ~26）下面紧接的 `<section class="card"><h2>数据源管理</h2>` **之前**插入通达信卡片：
```html
      <section class="card">
        <h2>通达信行情服务器（主力源）</h2>
        <p class="hint">通达信(TDX)是行情 / 实时 / 列表 / 基本面的<b>主力数据源</b>。当前：<b>{{ tdxCurrent || '自动选最快(bestip)' }}</b></p>
        <div v-if="isAdmin" class="row">
          <button @click="testTdx" :disabled="tdxTesting">{{ tdxTesting ? '测速中…(约 10-20s)' : '⚡ 测速全部服务器' }}</button>
          <button @click="pickTdx('', 0)">自动选最快</button>
        </div>
        <table v-if="tdxServers.length" class="srctable">
          <thead><tr><th>服务器</th><th>地址</th><th>延迟</th><th>状态</th><th v-if="isAdmin">操作</th></tr></thead>
          <tbody>
            <tr v-for="s in tdxServers.slice(0, 30)" :key="s.addr + ':' + s.port">
              <td>{{ s.site }}</td>
              <td class="url">{{ s.addr }}:{{ s.port }}</td>
              <td>{{ s.latency_ms != null ? s.latency_ms + 'ms' : '—' }}</td>
              <td><span :class="s.ok ? 'probe-ok' : 'probe-bad'">{{ s.ok ? '可用' : '不可用' }}</span></td>
              <td v-if="isAdmin"><button v-if="s.ok" @click="pickTdx(s.addr, s.port)">选用</button></td>
            </tr>
          </tbody>
        </table>
        <p v-if="tdxServers.length" class="hint">仅显示前 30（已按可用+延迟排序）。</p>
      </section>
```
（复用既有 `.srctable`/`.url`/`.probe-ok`/`.probe-bad` 样式。）

- [ ] **Step 4: 给「数据源管理」卡片加备选说明**

在「数据源管理」card 的 `<h2>数据源管理</h2>` 之后、紧跟现有 `<p class="hint">…` 之前，插入一行：
```html
      <p class="hint">以下为<b>交叉验证与备选</b>数据源（仅在主力源缺失时补充/校验）；主力行情请用上方的通达信。</p>
```

- [ ] **Step 5: CSV 卡片加用途说明（工具标签）**

在 `<h2>上传行情 CSV（通达信导出）</h2>` 之后插入：
```html
      <p class="hint">仅在<b>极端情况</b>（数据源都取不到）或需导入<b>特殊 / 自有数据</b>时使用；日常行情走通达信主力源。</p>
```

- [ ] **Step 6: 类型检查**

Run: `cd /home/zhangjq/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: 干净。

- [ ] **Step 7: 提交**

```bash
cd /home/zhangjq/projects/stock-agent
git add frontend/src/api/data.ts frontend/src/views/DataView.vue
git commit -m "feat(ui): 数据源标签 通达信服务器卡片(测速选用)置顶 + 数据源/CSV 主次说明

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：**
- 服务器列表/全测(真实查询校验)/get/set + pin → Task 1。✓
- sidecar 端点 `/tdx/servers/test`、`GET/POST /tdx/server` → Task 2。✓
- 后端 settings 持久化 + admin 路由 + sidecar 调用 + 启动重推 → Task 3。✓
- 前端 通达信卡片(测速/选用/自动)置顶为主力源 → Task 4 Step 3。✓
- 数据源管理降到其后 + 交叉验证/备选说明 → Task 4 Step 3(插入顺序)+Step 4。✓
- CSV 用途说明 → Task 4 Step 5。✓
- 仅 admin 可改 → 路由 adminMiddleware(Task 3)+ 前端按钮 v-if isAdmin(Task 4)。✓
- 测试:sidecar set/get/list 单测(Task 1)+ 实连测速(Task 2)+ 后端 admin-only/持久化(Task 3)+ vue-tsc(Task 4)+ Node 全套。✓

**Placeholder scan：** 无 TBD；每步含完整代码与命令。Task 3 Step 5 的 `resolveBase` 别名注明「若已有引用则复用」——是明确指引非占位。

**Type/契约一致性：** sidecar `list_servers/test_servers/get_server/set_server` ↔ main 端点 ↔ 后端 `tdxTestServers/tdxSetServer` ↔ 路由 ↔ api `tdxTestServers/tdxGetServer/tdxSetServer` ↔ DataView。服务器对象形 `{site,addr,port,ok,latency_ms}` 全程一致；`server` 设置串 "addr:port"|"" 一致；settings key `tdx_server` 一致。`getTdxServerSetting/setTdxServerSetting` 命名一致。
