# 纯函数测试：前复权 qfq_adjust（无网络）。运行: python sidecar/tdx_test.py
from tdx import qfq_adjust

def approx(a, b, tol=0.01):
    return abs(a - b) <= tol

def test_cash_dividend():
    bars = [
        {"date": "2025-01-01", "open": 100, "high": 100, "low": 100, "close": 100, "volume": 1},
        {"date": "2025-01-02", "open": 110, "high": 110, "low": 110, "close": 110, "volume": 1},
        {"date": "2025-01-03", "open": 90,  "high": 90,  "low": 90,  "close": 90,  "volume": 1},
        {"date": "2025-01-04", "open": 95,  "high": 95,  "low": 95,  "close": 95,  "volume": 1},
    ]
    events = [{"date": "2025-01-03", "fenhong": 100, "songzhuangu": 0, "peigu": 0, "peigujia": 0}]
    out = {b["date"]: b["close"] for b in qfq_adjust(bars, events)}
    assert approx(out["2025-01-01"], 90.91), out["2025-01-01"]
    assert approx(out["2025-01-02"], 100.0), out["2025-01-02"]
    assert approx(out["2025-01-03"], 90.0), out["2025-01-03"]
    assert approx(out["2025-01-04"], 95.0), out["2025-01-04"]

def test_split():
    bars = [
        {"date": "2025-02-01", "open": 22, "high": 22, "low": 22, "close": 22, "volume": 1},
        {"date": "2025-02-02", "open": 24, "high": 24, "low": 24, "close": 24, "volume": 1},
        {"date": "2025-02-03", "open": 12, "high": 12, "low": 12, "close": 12, "volume": 1},
    ]
    events = [{"date": "2025-02-03", "fenhong": 0, "songzhuangu": 10, "peigu": 0, "peigujia": 0}]
    out = {b["date"]: b["close"] for b in qfq_adjust(bars, events)}
    assert approx(out["2025-02-01"], 11.0), out["2025-02-01"]
    assert approx(out["2025-02-02"], 12.0), out["2025-02-02"]
    assert approx(out["2025-02-03"], 12.0), out["2025-02-03"]

def test_no_events():
    bars = [{"date": "2025-03-01", "open": 5, "high": 5, "low": 5, "close": 5, "volume": 1}]
    assert qfq_adjust(bars, [])[0]["close"] == 5

F10_FIXTURE = """☆财务分析☆ ◇600519 贵州茅台◇
【1.财务指标】
【主要财务指标】
｜财务指标              ｜    2026-03-31｜    2025-12-31｜    2024-12-31｜
｜净利润(元)            ｜    272.4251亿｜    823.2007亿｜    862.2815亿｜
｜营业总收入(元)        ｜    547.0291亿｜   1720.5417亿｜   1741.4407亿｜
｜加权净资产收益率(%)   ｜         10.57｜         32.53｜         36.02｜
｜基本每股收益(元)      ｜         21.76｜         65.66｜         68.64｜
｜每股净资产(元)        ｜      216.3224｜      195.3555｜      185.5647｜
"""

def test_parse_f10():
    from tdx import parse_f10_indicators
    d = parse_f10_indicators(F10_FIXTURE)
    assert d is not None
    assert abs(d["eps"] - 65.66) < 0.01, d            # 最近年报列 2025-12-31
    assert abs(d["roe"] - 32.53) < 0.01, d
    assert abs(d["revenue"] - 1.7205417e11) < 1e6, d  # 1720.5417亿
    assert abs(d["net_profit"] - 8.232007e10) < 1e5, d
    assert abs(d["bvps"] - 216.3224) < 0.01, d        # 最新列 2026-03-31（MRQ）

def test_parse_f10_empty():
    from tdx import parse_f10_indicators
    assert parse_f10_indicators("") is None
    assert parse_f10_indicators("no table here") is None

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

if __name__ == "__main__":
    test_cash_dividend(); test_split(); test_no_events()
    test_parse_f10(); test_parse_f10_empty()
    test_set_get_server(); test_list_servers();
    print("ALL PASS")
