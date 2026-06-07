# 通达信行情服务器进「数据源管理」+ 测速选用

日期：2026-06-08

## Context（背景）

通达信(mootdx)已是行情/实时/列表/基本面的首选源，但它有 **142 个候选服务器**，目前由 mootdx 的 bestip 自动选最快。问题：很多服务器**TCP 连得上却不工作**（实测 server#0 连接 0.5ms 但 TDX 握手 `ResponseHeaderRecvFails`），bestip 可能选到慢的/边缘的。用户希望：通达信也像别的源一样出现在「数据源管理」里，能**测各服务器连接速度**，然后**自己选用哪个**。

`数据源管理`（`data_sources` 表）存的是 HTTP `base_url` 行，通达信是 ip:port 的 TCP 协议，不适合塞进同一张表。

## 已验证的 mootdx 0.11.7 能力

- 服务器列表：`from mootdx.server import hosts` → `hosts['HQ']` = `[{site,addr,port,time}]`（142 个）。
- 指定服务器：`Quotes.factory(market='std', server=(addr, int(port)), bestip=False)` 可 pin 到具体服务器。
- 验证可用性必须**做真实 TDX 查询**（如 `stock_count`），仅 socket 连通不够（死服务器也接受 TCP）。

## Goals

- 数据源标签新增「通达信行情服务器」卡片（与 数据源管理 / 行情上游探测 并列）。
- 「测速」：并行测**全部 142 个**服务器（真实 TDX 查询验证 + 延迟），按「可用 + 延迟」排序展示。
- 用户可选「自动选最快(bestip)」或 pin 某个具体服务器；选择**持久化**（后端 settings），sidecar 重启后由后端重新应用。
- 仅 admin 可改（非 admin 只读当前）。

## Non-goals

- 不把 TDX 服务器塞进 `data_sources` 表（协议不同）。
- 不做服务器健康自动巡检/自动切换（沿用 mootdx auto_retry；本期只手动测速+选）。
- 扩展市场(EX/期货)服务器不在范围。

## 设计

### Sidecar `tdx.py`

- 模块状态：`_server: tuple | None = None`（None = 自动 bestip）。
- `_get_client()` 改为：`_server` 有值时 `Quotes.factory(market='std', server=_server, bestip=False)`，否则 `Quotes.factory(market='std')`（保持现状的 bestip）。
- `list_servers()` → `from mootdx.server import hosts`；`[{'site','addr','port'} for h in hosts['HQ']]`。
- `test_servers()` → 用 `ThreadPoolExecutor(max_workers=24)` 并行测全部；每个：
  ```python
  def _probe_one(h):
      t0 = time.perf_counter()
      try:
          c = Quotes.factory(market='std', server=(h['addr'], int(h['port'])), bestip=False, timeout=2, raise_exception=True)
          n = c.stock_count(market=1)            # 真实 TDX 查询验证
          ok = bool(n and n > 0)
          return {**site_addr_port(h), 'ok': ok, 'latency_ms': round((time.perf_counter()-t0)*1000, 1) if ok else None}
      except Exception:
          return {**site_addr_port(h), 'ok': False, 'latency_ms': None}
  ```
  返回按 `(not ok, latency_ms or 9e9)` 排序的列表。整体约 10-20s。
- `set_server(addr, port)`：`addr` 空 → `_server=None`（自动）；否则 `_server=(addr,int(port))`；调用 `_reset()` 让下次重建客户端。
- `get_server()` → `{'addr','port'} | None`。

### Sidecar `main.py` 端点

- `GET /tdx/servers/test` → `{'servers': tdx.test_servers()}`（耗时长）。
- `GET /tdx/server` → `{'server': tdx.get_server()}`。
- `POST /tdx/server?addr=&port=` → `tdx.set_server(addr, port)`；返回 `{'server': tdx.get_server()}`。（用 query 参数，避免 body 模型。）

### 后端 `data/sidecar.ts`

- 加 `postJson(url, timeoutMs)`（与现有 `getJson` 对称，POST 无 body）。
- 加：`tdxTestServers(base)`、`tdxGetServer(base)`、`tdxSetServer(base, addr, port)`（拼 query）。

### 后端 `routes/data.ts`（均 adminMiddleware，注册在 `/:job/*` 之前以免被遮蔽）

- `GET /api/data/tdx/servers/test` → 解析 `resolveSidecarBase(req.user.userId)` → `tdxTestServers(base)` → 返回 servers（超时给 ~30s）。base 为空返回空数组。
- `GET /api/data/tdx/server` → 返回**后端持久化**的选择（`settings.tdx_server`，形如 "addr:port" 或空），用于 UI 显示当前。
- `POST /api/data/tdx/server`（body `{addr?:string, port?:number}`，zod 校验，空=自动）→ 调 `tdxSetServer(base, addr, port)` 应用到 sidecar + 写 `settings.tdx_server`（空串=自动）；返回当前。
- settings 读写沿用现有 key/value 模式：`INSERT INTO settings(key,value) VALUES('tdx_server',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`；读 `SELECT value FROM settings WHERE key='tdx_server'`。

### 后端启动重新应用 `index.ts`

- 启动后（紧跟现有 `syncTradeCalendar` 那段）：读 `settings.tdx_server`，若非空，解析 addr:port，`resolveSidecarBase(admin)` → `tdxSetServer(base, addr, port)`（best-effort，扛 sidecar 重启）。

### 前端 `api/data.ts`

```ts
tdxTestServers: () => api.get('/data/tdx/servers/test').then(r => r.data.data as { servers: Array<{site:string;addr:string;port:number;ok:boolean;latency_ms:number|null}> }),
tdxGetServer: () => api.get('/data/tdx/server').then(r => r.data.data as { server: string }),   // "addr:port" | ""
tdxSetServer: (addr: string, port: number | null) => api.post('/data/tdx/server', { addr, port }).then(r => r.data),
```

### 前端 `DataView.vue`（数据源标签新卡片）

- 「通达信行情服务器」卡片：
  - 显示当前：`tdxGetServer()` → 空="自动选最快(bestip)"，否则显示 "addr:port"。
  - 「⚡测速(约 10-20s)」按钮(admin)：loading → `tdxTestServers()` → 表格列出 `site / addr:port / 延迟 / 可用✓✗`（可用置顶、按延迟排序；可只展示前 ~30 + 当前）。
  - 每行（admin）可「选用」；顶部一个「自动选最快」选项。点选 → `tdxSetServer(...)` → 刷新当前显示。
  - 非 admin：只读显示当前 + 列表（不显示选用按钮），或仅显示当前。

## Testing

- **sidecar**：`tdx.list_servers()` 返回 ~142；`tdx.test_servers()` 返回带 ok/latency 且至少有若干 ok（实连，selfcheck 脚本里加一项或单跑）；`set_server('','')` → `get_server()` None；`set_server(addr,port)` → `get_server()` 匹配且 `bars_qfq` 仍能取数（pin 到一个 ok 服务器）。这些需网络，归入手动/ selfcheck。
- **后端**：路由 admin-only（非 admin 403）；`POST /tdx/server` 写入 settings 且 `GET /tdx/server` 读回一致（可 mock sidecar 调用或只验 settings 持久化 + 403）。Node 全套保持绿。
- **前端**：`vue-tsc` 干净 + 冒烟（卡片显示当前；测速列出服务器；选用某个后当前更新；选「自动」恢复 bestip）。
- **端到端**：重建容器后，数据源标签见「通达信行情服务器」卡片;测速能列出可用服务器;选一个 ok 的 → 个股快照/EOD 仍正常取数。

## 默认决定（已确认）

- 全测 142 个（并行 + 真实 TDX 查询验证，非仅 TCP）。
- 单独「通达信行情服务器」卡片，不进 data_sources 表。
- 选择持久化于后端 settings，启动时重推 sidecar。
- 仅 admin 可改。
