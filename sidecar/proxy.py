"""出站代理：admin 配置后由后端推送生效。
socks5 → 全局 socket 补丁（TDX TCP + 所有 HTTP 都走代理）；
http  → 仅给 requests 注入 proxies（通达信直连）。

tdx 延迟导入（避免在 import 时拉起 mootdx，单测才能脱离重依赖运行）。"""
import socket
import socks  # PySocks

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
        import tdx
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
