# 数据获取出站代理（admin 配置）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.
>
> 计划目标位置（实现时落地）：`docs/superpowers/plans/2026-06-10-data-fetch-proxy.md`（现因 plan mode 暂存于此文件）。

## Context

用户的住宅联通线路对部分 HTTP 金融 CDN（东方财富 push2his / baostock）会 RST，有时需要让取数走一个可达线路的代理。本功能让 **admin** 配置一个出站代理（类型 HTTP/SOCKS5、IP、端口、用户名、口令）并用开关启停；启用后 sidecar 取数通过该代理出站。通达信(mootdx) 是 TCP 主力源，只有 **SOCKS5** 能承载（全局 socket 补丁覆盖 TCP+HTTP）；**HTTP** 代理只覆盖走 `requests` 的 HTTP 源、通达信直连。

Spec：`docs/superpowers/specs/2026-06-10-data-fetch-proxy-design.md`（已提交 `33eb3a2`）。

**已确认**：单个全局代理 + 开关；仅 admin 可设/可见；口令不加密（明文存 `settings`、明文回 admin 前端）；带「测试代理」按钮（真实跑一次取数）。

## Architecture & 复用

复用 `tdx_server` 那套成熟链路：**`settings` 表 → admin 路由（`routes/data.ts`）→ 推送 sidecar（`sidecar.ts`）→ `index.ts` 启动健壮重推**。代理在 Python sidecar 生效（取数都在那）。

复用点：
- `data/service.ts:582` `getTdxServerSetting/setTdxServerSetting`（settings 单行 JSON 存取模板）。
- `data/sidecar.ts:19` `postJson`、`:29` `getJson`（需新增带 body 的 `postJsonBody`）；`tdxSetServer`/`tdxGetServerLive` 为镜像样板。
- `routes/data.ts:4` `adminMiddleware`、`:9` 从 `../data/sidecar` 解构导入（TS 编译为模块属性访问，故测试可 `jest.spyOn(require('../data/sidecar'), 'proxySet')`）。
- `index.ts:110-141` TDX 启动健壮重推块（紧邻处加 proxy 重推；**先推 proxy 再推 tdx server**）。
- `main.py:19-65` `_install_http_hardening` 的 `_patched(self, method, url, **kwargs)` 猴补丁（注入 HTTP 代理的位置）。
- `tdx.py` `_reset()`（代理变更后让 mootdx 重连）。
- 前端 `stores/auth.ts:18` `isAdmin` getter；`DataView.vue:35` `<div v-show="tab === 'source'">` 内（TDX 卡片之后）放代理卡；`api/data.ts:46` `dataApi` 加方法。

## 关键文件

**sidecar**
- 新建 `sidecar/proxy.py`、`sidecar/proxy_test.py`
- 改 `sidecar/main.py`（import proxy + `_patched` 注入 + 3 端点）
- 改 `sidecar/requirements.txt`（+`PySocks==1.7.1`）；`Dockerfile` 已 `COPY *.py ./`，无需改

**backend**
- 改 `backend/src/data/service.ts`（+`ProxyConfig`/`getProxyConfig`/`setProxyConfig`）、`service.test.ts`
- 改 `backend/src/data/sidecar.ts`（+`postJsonBody`/`proxyGet`/`proxySet`/`proxyTest`）
- 改 `backend/src/routes/data.ts`（+3 路由）、`routes/data.test.ts`
- 改 `backend/src/index.ts`（启动重推 proxy）

**frontend**
- 改 `frontend/src/api/data.ts`（+`getProxy`/`setProxy`/`testProxy`）
- 改 `frontend/src/views/DataView.vue`（出站代理卡，admin only）

测试命令：后端 `cd backend && npm test`（当前 236 绿）；前端 `cd frontend && npx vue-tsc --noEmit`；sidecar 容器内 `docker exec ... python proxy_test.py`。

---

## Task 1: sidecar `proxy.py` + 纯函数单测 + 依赖

**Files:** Create `sidecar/proxy.py`、`sidecar/proxy_test.py`；Modify `sidecar/requirements.txt`

- [ ] **Step 1: 加依赖** — `sidecar/requirements.txt` 末尾加一行 `PySocks==1.7.1`

- [ ] **Step 2: 写失败测试 `sidecar/proxy_test.py`**
```python
import socket
import proxy

def test_build_http_with_auth():
    cfg = {"enabled": True, "scheme": "http", "host": "1.2.3.4", "port": 8080, "username": "u", "password": "p"}
    assert proxy.build_requests_proxies(cfg) == {"http": "http://u:p@1.2.3.4:8080", "https": "http://u:p@1.2.3.4:8080"}

def test_build_http_no_auth():
    cfg = {"enabled": True, "scheme": "http", "host": "1.2.3.4", "port": 8080, "username": "", "password": ""}
    assert proxy.build_requests_proxies(cfg) == {"http": "http://1.2.3.4:8080", "https": "http://1.2.3.4:8080"}

def test_build_socks5_returns_none():
    cfg = {"enabled": True, "scheme": "socks5", "host": "1.2.3.4", "port": 1080}
    assert proxy.build_requests_proxies(cfg) is None

def test_build_disabled_returns_none():
    assert proxy.build_requests_proxies({"enabled": False, "scheme": "http", "host": "x", "port": 1}) is None
    assert proxy.build_requests_proxies({"enabled": True, "scheme": "http", "host": "", "port": 1}) is None

def test_apply_disabled_resets():
    proxy.apply_proxy({"enabled": False})
    assert socket.socket is proxy._ORIG_SOCKET
    assert proxy.current_proxies() is None

def test_apply_http_sets_requests_proxies_only():
    proxy.apply_proxy({"enabled": True, "scheme": "http", "host": "1.2.3.4", "port": 8080, "username": "", "password": ""})
    assert proxy.current_proxies() == {"http": "http://1.2.3.4:8080", "https": "http://1.2.3.4:8080"}
    assert socket.socket is proxy._ORIG_SOCKET   # http 不动 socket
    proxy.apply_proxy({"enabled": False})         # 复位

if __name__ == "__main__":
    import sys
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for f in fns:
        f(); print("ok", f.__name__)
    print(f"{len(fns)} passed")
```

- [ ] **Step 3: 运行确认失败** — `docker exec -w /app stock-agent-akshare-mcp-1 python proxy_test.py`（若容器未起则本地 `cd sidecar && python proxy_test.py`）。Expected: `ModuleNotFoundError: No module named 'proxy'`。

- [ ] **Step 4: 实现 `sidecar/proxy.py`**
```python
"""出站代理：admin 配置后由后端推送生效。
socks5 → 全局 socket 补丁（TDX TCP + 所有 HTTP 都走代理）；
http  → 仅给 requests 注入 proxies（通达信直连）。"""
import socket
import socks  # PySocks
import tdx

_ORIG_SOCKET = socket.socket   # 进程启动时的原始 socket，复位用
_http_proxies = None           # dict 或 None，供 requests 注入
_last_cfg = None               # 最近一次应用的持久 cfg（供 test 后恢复）


def build_requests_proxies(cfg):
    """仅处理 scheme=http；未启用/非 http 返回 None（socks5 靠全局 socket 补丁）。"""
    if not cfg or not cfg.get("enabled") or not cfg.get("host") or cfg.get("scheme") != "http":
        return None
    user = cfg.get("username") or ""
    pw = cfg.get("password") or ""
    auth = f"{user}:{pw}@" if user else ""
    url = f"http://{auth}{cfg['host']}:{cfg['port']}"
    return {"http": url, "https": url}


def _reset_transport():
    global _http_proxies
    socket.socket = _ORIG_SOCKET
    try:
        socks.set_default_proxy()
    except Exception:
        pass
    _http_proxies = None
    try:
        tdx._reset()
    except Exception:
        pass


def apply_proxy(cfg, remember=True):
    """先复位再按需应用；返回当前生效状态。remember=False 用于临时测试。"""
    global _http_proxies, _last_cfg
    _reset_transport()
    if remember:
        _last_cfg = cfg

    if not cfg or not cfg.get("enabled") or not cfg.get("host"):
        return {"enabled": False}

    if cfg.get("scheme") == "socks5":
        socks.set_default_proxy(
            socks.SOCKS5, cfg["host"], int(cfg["port"]),
            username=(cfg.get("username") or None),
            password=(cfg.get("password") or None),
        )
        socket.socket = socks.socksocket
    else:
        _http_proxies = build_requests_proxies(cfg)
    return {"enabled": True, "scheme": cfg.get("scheme")}


def current_proxies():
    return _http_proxies


def restore_last():
    """测试临时 cfg 后恢复持久 cfg。"""
    apply_proxy(_last_cfg, remember=False)
```

- [ ] **Step 5: 装 PySocks 后运行确认通过** — 镜像尚未重建（Task 2 才 `--build`），先在容器内临时装：
`docker exec stock-agent-akshare-mcp-1 pip install -q PySocks==1.7.1`，再 `docker exec -w /app stock-agent-akshare-mcp-1 python proxy_test.py`。Expected: `6 passed`。（容器名以 `docker ps` 实际为准；本地无容器时 `cd sidecar && pip install PySocks==1.7.1 && python proxy_test.py`。）

- [ ] **Step 6: 提交**
```bash
git add sidecar/proxy.py sidecar/proxy_test.py sidecar/requirements.txt
git commit -m "feat(sidecar): proxy.py 出站代理(http requests 注入 / socks5 全局 socket 补丁)+单测"
```

---

## Task 2: sidecar `main.py` 接线（注入 + 3 端点）

**Files:** Modify `sidecar/main.py`

- [ ] **Step 1: import** — `import tdx` 那行（约 72 行）下加：`import proxy`

- [ ] **Step 2: `_patched` 注入 HTTP 代理** — 在 `_patched` 内 `kwargs["headers"] = headers` 之后、`if not getattr(self, "_hardened", False):` 之前加：
```python
            # 出站代理（仅 http 模式经此注入；socks5 走全局 socket 补丁，current_proxies() 为 None）
            if proxy.current_proxies() and "proxies" not in kwargs:
                kwargs["proxies"] = proxy.current_proxies()
```

- [ ] **Step 3: 加 3 个端点**（放在文件末尾、其它 `@app` 路由旁；用现有 `Body`/dict 风格，参考既有 POST 端点）
```python
from fastapi import Body

@app.get("/proxy")
def proxy_get():
    return {"enabled": bool(proxy.current_proxies()) or socket_socks_active(), "http_proxies": proxy.current_proxies()}

def socket_socks_active():
    import socket as _s
    return _s.socket is not proxy._ORIG_SOCKET

@app.post("/proxy")
def proxy_set(cfg: dict = Body(default={})):
    return proxy.apply_proxy(cfg)

@app.post("/proxy/test")
def proxy_test(cfg: dict = Body(default=None)):
    import time
    temp = cfg is not None and len(cfg) > 0
    if temp:
        proxy.apply_proxy(cfg, remember=False)
    t0 = time.time()
    ok, source, err = False, None, None
    try:
        r = tdx.realtime("600519")           # 轻量：拉一只实时行情
        if r and r.get("price"):
            ok, source = True, "tdx"
    except Exception as e:
        err = f"tdx: {e}"
    if not ok:
        try:
            import akshare as ak
            q = ak.stock_zh_a_daily(symbol="sh600519", adjust="qfq")
            if q is not None and len(q) > 0:
                ok, source = True, "sina"
        except Exception as e:
            err = (err + " | " if err else "") + f"sina: {e}"
    latency_ms = int((time.time() - t0) * 1000)
    if temp:
        proxy.restore_last()
    return {"ok": ok, "latency_ms": latency_ms, "source": source, "error": err}
```
> 注：`tdx.realtime(code)`（`sidecar/tdx.py:235`）返回 `{price,...}` 或 None，已核对。`socket_socks_active` 定义需在 `proxy_get` 之前，实现时把它放到 `proxy_get` 上方。

- [ ] **Step 4: 重建并冒烟** — `docker compose up -d --build`；
`docker exec stock-agent-akshare-mcp-1 sh -c 'curl -s localhost:8000/proxy'` → 应返回 JSON（`{"enabled":false,...}`）。

- [ ] **Step 5: 提交**
```bash
git add sidecar/main.py
git commit -m "feat(sidecar): /proxy /proxy/test 端点 + requests 注入 http 代理"
```

---

## Task 3: backend `data/service.ts` 配置存取 + 单测

**Files:** Modify `backend/src/data/service.ts`、`backend/src/data/service.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `service.test.ts` 末尾）
```ts
describe('proxy config', () => {
  it('returns disabled default when unset', () => {
    const c = svc.getProxyConfig();
    expect(c).toEqual({ enabled: false, scheme: 'http', host: '', port: 0, username: '', password: '' });
  });
  it('round-trips set/get incl password', () => {
    svc.setProxyConfig({ enabled: true, scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' });
    expect(svc.getProxyConfig()).toEqual({ enabled: true, scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' });
  });
});
```
> `svc` = 该文件顶部已有的 `require('./service')`（参照文件现有写法；若文件用 `const svc = require('./service')` 之外的导入名，沿用之）。

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest data/service -i -t "proxy config"`。Expected: FAIL（`getProxyConfig is not a function`）。

- [ ] **Step 3: 实现**（加在 `setTdxServerSetting` 之后，约 590 行）
```ts
export interface ProxyConfig {
  enabled: boolean;
  scheme: 'http' | 'socks5';
  host: string;
  port: number;
  username: string;
  password: string;
}

const DEFAULT_PROXY: ProxyConfig = { enabled: false, scheme: 'http', host: '', port: 0, username: '', password: '' };

export function getProxyConfig(): ProxyConfig {
  const r = getDb().prepare("SELECT value FROM settings WHERE key='proxy_config'").get() as { value: string } | undefined;
  if (!r?.value) return { ...DEFAULT_PROXY };
  try {
    return { ...DEFAULT_PROXY, ...JSON.parse(r.value) };
  } catch {
    return { ...DEFAULT_PROXY };
  }
}

export function setProxyConfig(cfg: ProxyConfig): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('proxy_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(cfg));
}
```

- [ ] **Step 4: 运行确认通过** — 同 Step 2。Expected: PASS。

- [ ] **Step 5: 提交**
```bash
git add backend/src/data/service.ts backend/src/data/service.test.ts
git commit -m "feat(data): getProxyConfig/setProxyConfig(settings 单行 JSON)"
```

---

## Task 4: backend `sidecar.ts` 代理推送/测试客户端

**Files:** Modify `backend/src/data/sidecar.ts`

- [ ] **Step 1: 加带 body 的 POST 辅助 + 3 函数**（`postJson` 之后加 `postJsonBody`；文件末尾加 proxy 函数）
```ts
async function postJsonBody(url: string, body: unknown, timeoutMs = 15000): Promise<any | null> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function proxyGet(base: string): Promise<any | null> {
  return getJson(`${base}/proxy`, 8000);
}

export async function proxySet(base: string, cfg: unknown): Promise<any | null> {
  return postJsonBody(`${base}/proxy`, cfg, 10000);
}

export async function proxyTest(base: string, cfg?: unknown): Promise<any | null> {
  // cfg 省略 → 测当前；传 cfg → sidecar 临时应用后测，测完恢复
  return postJsonBody(`${base}/proxy/test`, cfg ?? {}, 40000);
}
```
> 注：`proxyTest` 给 40s（真实取数可能慢）。

- [ ] **Step 2: 编译检查** — `cd backend && npx tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 提交**
```bash
git add backend/src/data/sidecar.ts
git commit -m "feat(data): sidecar proxyGet/proxySet/proxyTest + postJsonBody"
```

---

## Task 5: backend `routes/data.ts` 3 路由 + 测试

**Files:** Modify `backend/src/routes/data.ts`、`backend/src/routes/data.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `data.test.ts` 的 `describe('data routes', ...)` 内）
```ts
  it('GET /proxy requires admin', async () => {
    expect((await request(app).get('/api/data/proxy').set(uh())).status).toBe(403);
  });

  it('admin saves + reads proxy config (plaintext password)', async () => {
    jest.spyOn(require('../data/sidecar'), 'proxySet').mockResolvedValue({ enabled: true, scheme: 'socks5' });
    const save = await request(app).post('/api/data/proxy').set(h()).send({
      enabled: true, scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p',
    });
    expect(save.status).toBe(200);
    const get = await request(app).get('/api/data/proxy').set(h());
    expect(get.body.data.config).toMatchObject({ enabled: true, scheme: 'socks5', host: '1.2.3.4', port: 1080, password: 'p' });
  });

  it('rejects bad scheme', async () => {
    const r = await request(app).post('/api/data/proxy').set(h()).send({ enabled: true, scheme: 'ftp', host: 'x', port: 1 });
    expect(r.status).toBe(422);
  });
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest routes/data -i -t "proxy"`。Expected: FAIL（404，路由不存在）。

- [ ] **Step 3: 实现路由**（加在 `/tdx/server` 路由附近、`/:job` 通配之前；`proxyGet/proxySet/proxyTest` 加进顶部第 9 行解构 import）
```ts
const proxySchema = z.object({
  enabled: z.boolean(),
  scheme: z.enum(['http', 'socks5']),
  host: z.string(),
  port: z.number().int().min(0).max(65535),
  username: z.string().default(''),
  password: z.string().default(''),
});

router.get('/proxy', adminMiddleware, async (req: Request, res: Response) => {
  const config = svc.getProxyConfig();
  const base = resolveSidecarBase(req.user!.userId);
  const live = base ? await proxyGet(base) : null;
  successResponse(res, { config, live });
});

router.post('/proxy', adminMiddleware, async (req: Request, res: Response) => {
  const parsed = proxySchema.safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '代理参数不合法');
  const cfg = parsed.data;
  if (cfg.enabled && !cfg.host.trim()) return errorResponse(res, 422, 'VALIDATION_ERROR', '启用代理时必须填写地址');
  svc.setProxyConfig(cfg);
  const base = resolveSidecarBase(req.user!.userId);
  const live = base ? await proxySet(base, cfg) : null;
  successResponse(res, { config: cfg, live }, live ? '代理已保存并生效' : '代理已保存（sidecar 未即时生效，重启后自动重推）');
});

router.post('/proxy/test', adminMiddleware, async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  if (!base) return errorResponse(res, 503, 'UPSTREAM_ERROR', 'sidecar 不可达');
  const cfg = req.body && Object.keys(req.body).length ? req.body : undefined;
  const result = await proxyTest(base, cfg);
  if (!result) return errorResponse(res, 502, 'UPSTREAM_ERROR', '测试请求失败');
  successResponse(res, result);
});
```
> 顶部 import 改：`import { resolveSidecarBase, pingHealth, probe, probeList, probeOne, tdxTestServers, tdxSetServer, proxyGet, proxySet, proxyTest } from '../data/sidecar';`

- [ ] **Step 4: 运行确认通过 + 回归** — `cd backend && npx jest routes/data -i` 然后 `npm test`。Expected: 全绿（含新 3 例）。

- [ ] **Step 5: 提交**
```bash
git add backend/src/routes/data.ts backend/src/routes/data.test.ts
git commit -m "feat(api): /api/data/proxy GET/POST + /proxy/test(admin)"
```

---

## Task 6: backend `index.ts` 启动重推代理

**Files:** Modify `backend/src/index.ts`

- [ ] **Step 1: 在 TDX 重推块之前插入 proxy 重推**（`if (admin) { const sv = getTdxServerSetting(); ...` 之前）
```ts
    // 先重推出站代理（保证 tdx 在代理生效后再连）
    if (admin) {
      const adminId = admin.id;
      const { getProxyConfig } = require('./data/service');
      const pc = getProxyConfig();
      (async () => {
        for (let i = 0; i < 24; i++) {
          const base = sidecarMod.resolveSidecarBase(adminId);
          if (base && (await sidecarMod.pingHealth(base).catch(() => false))) {
            const r = await sidecarMod.proxySet(base, pc).catch(() => null);
            if (r) {
              console.log(`[startup] 出站代理已应用到 sidecar：enabled=${pc.enabled} scheme=${pc.scheme}`);
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        console.warn('[startup] 未能把出站代理应用到 sidecar（已重试 ~2 分钟）');
      })();
    }
```
> 该块用到的 `sidecarMod`、`admin` 已在上文定义（在 `const sidecarMod = require('./data/sidecar');` 之后插入）。

- [ ] **Step 2: 编译检查** — `cd backend && npx tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 提交**
```bash
git add backend/src/index.ts
git commit -m "feat(startup): 启动重推出站代理到 sidecar(先于 tdx server)"
```

---

## Task 7: frontend `api/data.ts`

**Files:** Modify `frontend/src/api/data.ts`

- [ ] **Step 1: 加类型 + 3 方法**（`dataApi` 对象内，`tdxSetServer` 旁）
```ts
  getProxy: () =>
    api.get('/data/proxy').then((r) => r.data.data as { config: ProxyConfig; live: any }),
  setProxy: (cfg: ProxyConfig) =>
    api.post('/data/proxy', cfg).then((r) => r.data.data as { config: ProxyConfig; live: any }),
  testProxy: (cfg?: ProxyConfig) =>
    api.post('/data/proxy/test', cfg || {}).then((r) => r.data.data as { ok: boolean; latency_ms: number; source: string | null; error: string | null }),
```
在文件类型区加：
```ts
export interface ProxyConfig {
  enabled: boolean;
  scheme: 'http' | 'socks5';
  host: string;
  port: number;
  username: string;
  password: string;
}
```

- [ ] **Step 2: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 提交**
```bash
git add frontend/src/api/data.ts
git commit -m "feat(api): dataApi.getProxy/setProxy/testProxy + ProxyConfig"
```

---

## Task 8: frontend `DataView.vue` 出站代理卡（admin）

**Files:** Modify `frontend/src/views/DataView.vue`

- [ ] **Step 1: 模板** — 在 `<div v-show="tab === 'source'">` 内、通达信卡片 `</div>`（约 56 行）之后插入：
```vue
      <div v-if="isAdmin" class="card">
        <h2>出站代理</h2>
        <p class="hint"><b>SOCKS5</b>＝全部源（含通达信）走代理；<b>HTTP</b>＝仅 HTTP 源走代理，通达信直连。仅管理员可见可改。</p>
        <div class="row"><label><input type="checkbox" v-model="proxy.enabled" /> 启用代理</label></div>
        <div class="row">
          类型
          <select v-model="proxy.scheme"><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select>
          IP <input v-model="proxy.host" placeholder="代理服务器地址" />
          端口 <input v-model.number="proxy.port" type="number" style="width:90px" />
        </div>
        <div class="row">
          用户名 <input v-model="proxy.username" placeholder="可空" />
          口令 <input v-model="proxy.password" placeholder="可空" />
        </div>
        <div class="row">
          <button @click="saveProxy" :disabled="proxySaving">{{ proxySaving ? '保存中…' : '保存' }}</button>
          <button @click="testProxy" :disabled="proxyTesting">{{ proxyTesting ? '测试中…(约 10-40s)' : '测试代理' }}</button>
          <span v-if="proxyMsg" class="muted">{{ proxyMsg }}</span>
          <span v-if="proxyTestResult" :class="proxyTestResult.ok ? 'okmsg' : 'err'">
            {{ proxyTestResult.ok ? `✅ 通（${proxyTestResult.source} ${proxyTestResult.latency_ms}ms）` : `❌ ${proxyTestResult.error || '失败'}` }}
          </span>
        </div>
      </div>
```

- [ ] **Step 2: script** — `<script setup>` 内加 state 与方法（与其它 ref 同区；`dataApi`、`isAdmin` 已在文件中可用，沿用现有 `onMounted` 加载）：
```ts
import type { ProxyConfig } from '../api/data';
const proxy = reactive<ProxyConfig>({ enabled: false, scheme: 'http', host: '', port: 0, username: '', password: '' });
const proxySaving = ref(false);
const proxyTesting = ref(false);
const proxyMsg = ref('');
const proxyTestResult = ref<{ ok: boolean; latency_ms: number; source: string | null; error: string | null } | null>(null);

async function loadProxy() {
  if (!isAdmin.value) return;
  try { Object.assign(proxy, (await dataApi.getProxy()).config); } catch { /* ignore */ }
}
async function saveProxy() {
  proxySaving.value = true; proxyMsg.value = '';
  try { const r = await dataApi.setProxy({ ...proxy }); proxyMsg.value = r.live ? '已保存并生效' : '已保存（重启后生效）'; }
  catch (e: any) { proxyMsg.value = e.response?.data?.message || '保存失败'; }
  finally { proxySaving.value = false; }
}
async function testProxy() {
  proxyTesting.value = true; proxyTestResult.value = null;
  try { proxyTestResult.value = await dataApi.testProxy({ ...proxy }); }
  catch (e: any) { proxyTestResult.value = { ok: false, latency_ms: 0, source: null, error: e.response?.data?.message || '测试失败' }; }
  finally { proxyTesting.value = false; }
}
```
在已有的 `onMounted(...)` 回调里加一行：`loadProxy();`。确认 `reactive`、`ref` 已 import（文件其它地方已用，应已 import；若无则补 `import { reactive, ref, onMounted } from 'vue'`）。

- [ ] **Step 3: 样式**（`<style scoped>` 末尾，若无 `.okmsg`）
```css
.okmsg { color: var(--accent, #2a8a2a); }
```

- [ ] **Step 4: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 5: 提交**
```bash
git add frontend/src/views/DataView.vue
git commit -m "feat(data-ui): 出站代理卡(admin)：启用/类型/IP端口/认证/保存/测试"
```

---

## 端到端验证（实现完成后）

1. `cd backend && npm test` → 全绿（236 + 新增）。
2. `cd frontend && npx vue-tsc --noEmit` → exit 0。
3. `docker exec -w /app stock-agent-akshare-mcp-1 python proxy_test.py` → `6 passed`。
4. `docker compose up -d --build` 重建 app+sidecar。
5. 浏览器以 admin 登录 → 数据 → 数据源标签 → 「出站代理」卡：
   - 关闭代理 + 「测试代理」→ 应直连成功（绿 ✅）。
   - 填一个可达代理（http 或 socks5）、保存、测试 → 看延迟/来源；普通用户登录看不到该卡（`isAdmin` 守卫），直接 `GET /api/data/proxy` 返回 403。
   - SOCKS5 启用后，`docker exec stock-agent-akshare-mcp-1 sh -c 'curl -s localhost:8000/proxy'` 的 `enabled` 应为 true。
6. 关掉代理保存 → 确认复位为直连（`/proxy` enabled=false、socket 还原）。

## 风险 / 注意
- **复位可靠性**是硬约束：关开关/切直连必须真还原 `socket.socket` 与 requests 代理（`apply_proxy` 先 `_reset_transport()`）。
- `proxy_test` 临时应用 cfg 会短暂影响并发请求（admin 偶发操作，可接受）；测完 `restore_last()` 恢复。
- sidecar 新增 `.py` 已被 `COPY *.py ./` 覆盖；新增依赖 `PySocks` 要 `--build` 重装（Task 1 测试前先在容器临时 `pip install`）。
- SOCKS5 全局 socket 补丁会影响 sidecar 内**所有**出站连接（这正是"全部走代理"想要的）；复位逻辑必须可靠。
