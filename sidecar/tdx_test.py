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

if __name__ == "__main__":
    test_cash_dividend(); test_split(); test_no_events()
    print("ALL PASS")
