"""出站代理：admin 配置后由后端推送生效。
socks5 → 全局 socket 补丁（TDX TCP + 所有 HTTP 都走代理）；
http  → 仅给 requests 注入 proxies（通达信直连）。

tdx 延迟导入（避免在 import 时拉起 mootdx，单测才能脱离重依赖运行）。"""
import json
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


def proxy_active():
    """当前是否有出站代理生效（socks5 全局 socket 补丁，或 http requests 注入）。"""
    return socket.socket is not _ORIG_SOCKET or _http_proxies is not None


def run_direct_json(kind, arg=20, timeout=40):
    """在「无代理补丁」的独立子进程里直连抓取（kind=news/sentiment），返回解析后的 JSON 或 None。

    子进程是干净的新解释器，没有本进程的 socket 补丁/注入，等同直连，借此绕开出站代理
    （eastmoney 新闻/涨停跌停 经 socks5 代理会被掐断，但直连可达）。
    同时剥离 *_PROXY 环境变量，确保子进程内 requests 也不经代理。
    """
    import os
    import sys as _sys
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))
    env = {k: v for k, v in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    try:
        r = subprocess.run(
            [_sys.executable, os.path.join(here, "direct_sources.py"), str(kind), str(arg)],
            capture_output=True, text=True, timeout=timeout, env=env,
        )
        if r.returncode == 0 and r.stdout.strip():
            return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return None
    return None


def restore_last():
    """测试临时 cfg 后恢复持久 cfg。"""
    apply_proxy(_last_cfg, remember=False)
