# 通达信(mootdx)数据源：自算前复权 + 带锁单例客户端 + bars/stocks/finance/realtime。
# 注意：不使用 mootdx 内置 adjust（其 qfq 在新版 pandas 下报 fillna(method=) 错误）。
import threading
from mootdx.quotes import Quotes

_lock = threading.Lock()
_client = None


def _get_client():
    global _client
    if _client is None:
        _client = Quotes.factory(market="std")  # 内部 bestip 选最快服务器，缓存于实例
    return _client


def _reset():
    global _client
    _client = None


def _call(fn):
    """串行化(连接非线程安全) + 一次重连重试；异常返回 None。"""
    with _lock:
        for attempt in (1, 2):
            try:
                return fn(_get_client())
            except Exception:
                _reset()
                if attempt == 2:
                    return None


def _f(x):
    try:
        return None if x is None else float(x)
    except Exception:
        return None


def qfq_adjust(bars, events):
    """前复权（保持最新价不变，向前调整历史价）。
    bars: 升序 [{date,open,high,low,close,volume}]（原始不复权）。
    events: [{date,fenhong,songzhuangu,peigu,peigujia}]，fenhong/songzhuangu/peigu 为每 10 股口径。
    """
    bars_sorted = sorted(bars, key=lambda b: b["date"])
    factors = []  # [(ex_date, factor)]
    for e in sorted(events, key=lambda x: x["date"]):
        exd = e["date"]
        prev_close = None
        for b in bars_sorted:
            if b["date"] < exd:
                prev_close = b["close"]
            else:
                break
        if prev_close is None or prev_close == 0:
            continue
        cash = (e.get("fenhong") or 0) / 10.0
        song = (e.get("songzhuangu") or 0) / 10.0
        pei = (e.get("peigu") or 0) / 10.0
        peijia = e.get("peigujia") or 0
        ref = (prev_close + pei * peijia - cash) / (1 + song + pei)
        factors.append((exd, ref / prev_close))
    out = []
    for b in bars_sorted:
        f = 1.0
        for exd, fac in factors:
            if exd > b["date"]:
                f *= fac
        nb = dict(b)
        for k in ("open", "high", "low", "close"):
            if nb.get(k) is not None:
                nb[k] = round(nb[k] * f, 2)
        out.append(nb)
    return out


def bars_qfq(code, days=120):
    """原始日线 + xdxr → 前复权，返回升序 [{date,open,high,low,close,volume}]。"""
    def fn(c):
        raw = c.bars(symbol=code, frequency=9, offset=days)
        if raw is None or len(raw) == 0:
            return None
        bars = []
        for _, r in raw.iterrows():
            bars.append({
                "date": str(r["datetime"])[:10],
                "open": _f(r.get("open")), "high": _f(r.get("high")),
                "low": _f(r.get("low")), "close": _f(r.get("close")),
                "volume": _f(r.get("vol") if "vol" in r else r.get("volume")),
            })
        bars.sort(key=lambda b: b["date"])
        try:
            x = c.xdxr(symbol=code)
            events = []
            if x is not None and len(x):
                for _, r in x[x["category"] == 1].iterrows():
                    events.append({
                        "date": f"{int(r['year']):04d}-{int(r['month']):02d}-{int(r['day']):02d}",
                        "fenhong": _f(r.get("fenhong")) or 0,
                        "songzhuangu": _f(r.get("songzhuangu")) or 0,
                        "peigu": _f(r.get("peigu")) or 0,
                        "peigujia": _f(r.get("peigujia")) or 0,
                    })
            return qfq_adjust(bars, events)
        except Exception:
            return bars  # xdxr 拉不到则退回原始价（避免无数据）
    return _call(fn)


def _latest_raw_close(code):
    def fn(c):
        raw = c.bars(symbol=code, frequency=9, offset=2)
        if raw is None or len(raw) == 0:
            return None
        return _f(raw.iloc[-1]["close"])
    return _call(fn)


def finance_fundamentals(code):
    """用 finance() + 当前价算 roe_ttm/pe/pb/ps/net_profit。"""
    price = _latest_raw_close(code)   # 先取价（独立 _call，避免嵌套加锁死锁）
    def fn(c):
        fin = c.finance(symbol=code)
        if fin is None or len(fin) == 0:
            return None
        row = fin.iloc[0]
        shares = _f(row.get("zongguben"))
        eq = _f(row.get("jingzichan"))
        rev = _f(row.get("zhuyingshouru"))
        profit = _f(row.get("jinglirun"))
        bvps = _f(row.get("meigujingzichan"))
        out = {}
        if profit and eq:
            out["roe_ttm"] = round(profit / eq * 100, 2)
        if price and bvps:
            out["pb"] = round(price / bvps, 2)
        if price and shares and profit and profit > 0:
            out["pe"] = round(price * shares / profit, 2)
        if price and shares and rev and rev > 0:
            out["ps"] = round(price * shares / rev, 2)
        out["net_profit"] = profit
        return out
    return _call(fn)


def _is_a_stock(market, code):
    if market == 1:   # 沪市：主板60/科创688/沪主板605
        return code.startswith(("60", "688", "605"))
    return code.startswith(("00", "30", "301", "002"))  # 深市：主板00/创业板30


def stocks():
    """全 A 股 [{code,name}]（py 由 main.py 补）。c.stocks(market) 返回全量(含指数/基金)，按前缀筛 A 股。"""
    def fn(c):
        out = []
        for market in (0, 1):
            df = c.stocks(market=market)
            if df is None or len(df) == 0:
                continue
            for _, r in df.iterrows():
                code = str(r.get("code", ""))
                name = str(r.get("name", "")).strip()
                if len(code) == 6 and _is_a_stock(market, code):
                    out.append({"code": code, "name": name})
        return out or None
    return _call(fn)


def realtime(code):
    def fn(c):
        q = c.quotes(symbol=code)
        if q is None or len(q) == 0:
            return None
        r = q.iloc[0]
        return {
            "price": _f(r.get("price")), "open": _f(r.get("open")),
            "high": _f(r.get("high")), "low": _f(r.get("low")),
            "prev_close": _f(r.get("last_close")),
            "volume": _f(r.get("vol")), "name": None,
            "time": str(r.get("servertime") or ""),
        }
    return _call(fn)
