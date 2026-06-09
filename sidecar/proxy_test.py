import socket
import socks
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


def test_apply_socks5_patches_socket():
    proxy.apply_proxy({"enabled": True, "scheme": "socks5", "host": "1.2.3.4", "port": 1080, "username": "", "password": ""})
    assert socket.socket is socks.socksocket      # 全局 socket 补丁生效
    assert proxy.current_proxies() is None         # socks5 不走 requests 注入
    proxy.apply_proxy({"enabled": False})          # 复位
    assert socket.socket is proxy._ORIG_SOCKET


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for f in fns:
        f()
        print("ok", f.__name__)
    print(f"{len(fns)} passed")
