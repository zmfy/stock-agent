# 数据获取出站代理（admin 配置）Design

> 让 admin 配置一个出站代理（类型 HTTP/SOCKS5、IP、端口、用户名、口令）并用一个开关启停；启用后，sidecar 取数通过该代理出站。

最后更新：2026-06-10。仓库：`github.com/zmfy/stock-agent`。

## 目标 / 动机

- 用户的住宅联通线路对部分 HTTP 金融 CDN（东方财富 push2his / baostock 等）会 RST；有时需要让取数走一个可达线路的代理。
- 通达信(mootdx) 是 TCP 协议主力源；要让它也能走代理，只有 SOCKS5 能承载（HTTP 代理带不了裸 TCP）。

## 关键决策（已与用户确认）

1. **两种代理类型都支持，admin 选**：
   - `scheme=socks5` → sidecar **全局 socket 补丁**，通达信 TCP + 所有 HTTP 源**全部**走代理。
   - `scheme=http` → 只覆盖走 `requests` 的 HTTP 源；通达信**保持直连**。
2. **单个代理 + 一个开关**（非列表、非 per-source）。
3. **全局一套、仅 admin 可设/可见**。
4. **口令不加密**（明文存 `settings`、明文回前端）——因为只有 admin 能设置和查看，无需加密。
5. **带「测试代理」按钮**：真实跑一次取数验证（不只 TCP 连通）。

## 架构

复用 `tdx_server` 已验证的链路：**`settings` 表 → admin 路由（`routes/data.ts`）→ 推送 sidecar（`sidecar.ts`）→ `index.ts` 启动健壮重推**。取数都在 Python sidecar，故代理真正在 sidecar 生效。

```
[DataView.vue 出站代理卡(admin)] --HTTP--> [routes/data.ts /api/data/proxy*]
        |                                          |
        |                                  data/service.ts (settings: proxy_config)
        |                                          |
        |                                  sidecar.ts proxySet/proxyTest/proxyGet
        v                                          v
   (保存/测试/开关)                      [sidecar main.py /proxy*] -> proxy.py apply_proxy()
                                                   |
                                   socks5: 全局 socket 补丁(TDX+HTTP)
                                   http:   requests 注入 proxies(仅 HTTP 源)
```

## 数据模型

`settings` 表单行，`key='proxy_config'`，`value` 为 JSON 字符串：

```jsonc
{
  "enabled": false,
  "scheme": "http",        // 'http' | 'socks5'
  "host": "",
  "port": 0,
  "username": "",          // 可空(无认证代理)
  "password": ""           // 明文(admin-only)
}
```

后端 `data/service.ts` 加：
- `getProxyConfig(): ProxyConfig`（无记录返回默认 `{enabled:false, scheme:'http', host:'', port:0, username:'', password:''}`）
- `setProxyConfig(cfg: ProxyConfig): void`（`INSERT ... ON CONFLICT DO UPDATE`，与 `setTdxServerSetting` 同款）

## sidecar 行为 —— 新模块 `sidecar/proxy.py`

> 必须进 `sidecar/Dockerfile` 的 `COPY *.py ./`（否则 rebuild 后 ModuleNotFoundError）。新增依赖 `PySocks` 到 `requirements.txt`。

模块状态 + 函数：

```python
import socket, socks  # PySocks
_ORIG_SOCKET = socket.socket          # 进程启动时的原始 socket，复位用
_http_proxies = None                  # dict 或 None，供 requests 注入

def build_requests_proxies(cfg) -> dict | None:
    """纯函数：把 HTTP 代理 cfg 翻成 requests 的 proxies dict（带认证）。
       仅处理 scheme=http；未启用/非 http 返回 None（socks5 不走这里，靠全局 socket 补丁）。"""
    if not cfg or not cfg.get("enabled") or not cfg.get("host") or cfg.get("scheme") != "http":
        return None
    user = cfg.get("username") or ""
    pw = cfg.get("password") or ""
    auth = f"{user}:{pw}@" if user else ""
    url = f"http://{auth}{cfg['host']}:{cfg['port']}"
    return {"http": url, "https": url}

def apply_proxy(cfg) -> dict:
    """先复位再按需应用；返回当前生效状态。"""
    global _http_proxies
    # 1) 复位：还原 socket.socket、清 requests 代理
    socket.socket = _ORIG_SOCKET
    socks.set_default_proxy()       # 清 PySocks 默认
    _http_proxies = None
    tdx._reset()                    # mootdx 客户端重连（下次取数）

    if not cfg or not cfg.get("enabled") or not cfg.get("host"):
        return {"enabled": False}

    if cfg.get("scheme") == "socks5":
        # 全局 socket 补丁 → TDX TCP + 所有 HTTP 都走 SOCKS5
        socks.set_default_proxy(socks.SOCKS5, cfg["host"], int(cfg["port"]),
                                username=cfg.get("username") or None,
                                password=cfg.get("password") or None)
        socket.socket = socks.socksocket
    else:
        # HTTP 代理：只给 requests 注入，TDX 直连
        _http_proxies = build_requests_proxies(cfg)
    return {"enabled": True, "scheme": cfg["scheme"]}

def current_proxies():
    return _http_proxies
```

`main.py` 改动：
- 顶部 `import proxy`。
- requests 猴补丁 `_patched` 内，在已有 header/adapter 注入之后加一句：
  `if proxy.current_proxies() and "proxies" not in kwargs: kwargs["proxies"] = proxy.current_proxies()`
  （HTTP 代理仅在 scheme=http 时生效；scheme=socks5 时 `current_proxies()` 为 None，靠全局 socket 补丁覆盖，避免双重代理。）
- 端点：
  - `GET /proxy` → 返回 sidecar 当前生效状态。
  - `POST /proxy` → body 收 cfg → `proxy.apply_proxy(cfg)` → 返回状态。
  - `POST /proxy/test` → body 可带待测 cfg（不持久、临时 `apply_proxy` 后测、测完恢复持久 cfg）或测当前；跑一次真实取数（优先 TDX `tdx.stocks` 轻量计数 / 失败再试新浪一条行情），返回 `{ok, latency_ms, source, error}`。

## API（`routes/data.ts`，全部 `adminMiddleware`，注册在 `/:job` 通配前）

- `GET /api/data/proxy` → `{ config: ProxyConfig（含明文口令）, live: <sidecar GET /proxy> }`
- `POST /api/data/proxy` → 校验（`zod`：scheme∈{http,socks5}、enabled bool、port 1-65535 当 enabled 时、host 非空当 enabled 时）→ `setProxyConfig` → 推送 sidecar `proxySet` → 返回保存后的 config + live。
- `POST /api/data/proxy/test` → body 可带待测 cfg（不存，直接让 sidecar 用该 cfg 测）或测当前 → 返回 sidecar test 结果。

`sidecar.ts` 加：`proxyGet(base)`、`proxySet(base, cfg)`、`proxyTest(base, cfg?)`（沿用 `postJson`/`getJson`）。

`index.ts` 启动：在现有 `tdx_server` 健壮重推附近，同样把 `getProxyConfig()` 推给 sidecar（等 healthy → POST /proxy → 可选 GET 校验）。**顺序：先推 proxy 再推 tdx server**，保证 tdx 在代理生效后再连。

## 前端（`DataView.vue` → 数据源标签，仅 `isAdmin`）

通达信卡片附近加「**出站代理**」卡（`v-if="isAdmin"`）：
- 「启用代理」开关（checkbox）
- 类型下拉：HTTP / SOCKS5
- IP / 端口 / 用户名 / 口令（普通 input，口令明文显示）
- 「保存」按钮（保存即推送 sidecar）
- 「测试代理」按钮（转圈 → 显示 ok/延迟/来源 或 错误）
- 卡上说明：**SOCKS5＝全部源（含通达信）走代理；HTTP＝仅 HTTP 源走代理，通达信直连**。

`api/data.ts` 加 `getProxy()` / `setProxy(cfg)` / `testProxy(cfg?)`。

## 错误处理

- 后端路由校验失败 → 422 VALIDATION_ERROR；sidecar 不可达 → 保存仍写 settings（下次启动重推会补），但返回 live=null + 提示「已保存，sidecar 未即时生效」。
- 测试失败 → 返回 sidecar 的 `{ok:false, error}`，前端红字显示。
- `apply_proxy` 内任何异常都先保证「复位」已执行，避免半套状态把 sidecar 出站打死。

## 测试

- **后端 Jest**：`getProxyConfig/setProxyConfig` 存取与默认值；`POST /proxy` 校验（坏 scheme/缺 host/坏 port 422）、admin 守卫（非 admin 403）；`GET /proxy` 返回明文 config 结构。sidecar 推送在测试里 mock（注入或 stub `sidecar` 模块），不真连。
- **sidecar 单测 `proxy_test.py`**：`build_requests_proxies` 各分支（未启用→None、scheme=socks5→None、http 带认证→`http://user:pass@host:port`、http 无认证→`http://host:port`）；`apply_proxy` 复位语义（enabled=false 后 `socket.socket is _ORIG_SOCKET` 且 `current_proxies() is None`）。
- **全局 socket 补丁的真实代理行为**：靠容器内手动验证（无现成代理不强测）。

## 安全 / 范围

- 仅 admin 可读写（`adminMiddleware`）；口令明文存 settings、明文回 admin 前端——符合「只有 admin 能设置和看到」。
- YAGNI：不做 per-source 代理、不做代理列表、不做按 URL 规则分流。
- 复位可靠性是硬约束（切回直连/关开关必须真还原 `socket.socket` 与 requests 代理）。

## 不在本次范围

代理健康自动巡检/自动切换、多代理、per-user 代理、代理白/黑名单分流。
