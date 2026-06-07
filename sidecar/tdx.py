# 通达信(mootdx)数据源：自算前复权 + 带锁单例客户端 + bars/stocks/finance/realtime。
# 注意：不使用 mootdx 内置 adjust（其 qfq 在新版 pandas 下报 fillna(method=) 错误）。
import re
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


def _num_cn(s):
    """解析中文数字串：去全角空格，支持 亿/万 后缀，'-' 或空 → None。"""
    s = (s or "").replace("　", "").strip()
    if not s or s == "-":
        return None
    mult = 1.0
    if s.endswith("亿"):
        mult, s = 1e8, s[:-1]
    elif s.endswith("万"):
        mult, s = 1e4, s[:-1]
    try:
        return float(s) * mult
    except Exception:
        return None


def parse_f10_indicators(txt):
    """解析 F10「财务分析」主要财务指标表（｜全角竖线分隔）。
    eps/roe/revenue/net_profit 取最近年报列(YYYY-12-31)，bvps 取最新列(MRQ)。无表返回 None。"""
    if not txt:
        return None
    lines = txt.split("\n")
    hdr = None
    for ln in lines:
        if "财务指标" in ln and re.search(r"\d{4}-\d{2}-\d{2}", ln):
            hdr = [x.strip() for x in ln.split("｜")]
            break
    if not hdr or len(hdr) < 3:
        return None
    dates = hdr[2:]
    col_latest = 0
    col_annual = next((i for i, d in enumerate(dates) if d.endswith("-12-31")), 0)

    def cell(label, col):
        for ln in lines:
            cells = [x.strip() for x in ln.split("｜")]
            if len(cells) > 2 and cells[1].startswith(label):
                vals = cells[2:]
                return vals[col] if col < len(vals) else None
        return None

    return {
        "eps": _num_cn(cell("基本每股收益", col_annual)),
        "roe": _num_cn(cell("加权净资产收益率", col_annual)),
        "revenue": _num_cn(cell("营业总收入", col_annual)),
        "net_profit": _num_cn(cell("净利润", col_annual)),
        "bvps": _num_cn(cell("每股净资产", col_latest)),
    }


def _f10_text(code):
    return _call(lambda c: c.F10(symbol=code, name="财务分析"))


def _shares(code):
    def fn(c):
        fin = c.finance(symbol=code)
        if fin is None or len(fin) == 0:
            return None
        return _f(fin.iloc[0].get("zongguben"))
    return _call(fn)


def finance_fundamentals(code):
    """F10 财务分析(干净) + 当前价 + 总股本 → roe_ttm/pe/pb/ps/net_profit。
    PE/PS/ROE/净利润用最近年报(静态)，PB 用最新每股净资产(MRQ)。"""
    price = _latest_raw_close(code)   # 独立 _call
    shares = _shares(code)            # 独立 _call
    ind = parse_f10_indicators(_f10_text(code))  # 独立 _call + 纯解析
    if not ind:
        return None
    out = {}
    if ind["roe"] is not None:
        out["roe_ttm"] = round(ind["roe"], 2)
    if price and ind["eps"]:
        out["pe"] = round(price / ind["eps"], 2)
    if price and ind["bvps"]:
        out["pb"] = round(price / ind["bvps"], 2)
    if price and shares and ind["revenue"]:
        out["ps"] = round(price * shares / ind["revenue"], 2)
    if ind["net_profit"] is not None:
        out["net_profit"] = ind["net_profit"]
    return out


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
