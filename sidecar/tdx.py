# 通达信(mootdx)数据源：自算前复权 + 带锁单例客户端 + bars/stocks/finance/realtime。
# 注意：不使用 mootdx 内置 adjust（其 qfq 在新版 pandas 下报 fillna(method=) 错误）。
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from mootdx.quotes import Quotes

_lock = threading.Lock()
_client = None
_server = None  # (addr, port) 选定服务器；None = 自动 bestip


def _get_client():
    global _client
    if _client is None:
        if _server:
            _client = Quotes.factory(market="std", server=_server, bestip=False)
        else:
            _client = Quotes.factory(market="std")  # 自动 bestip
    return _client


def _reset():
    global _client
    _client = None


_recover_after = 0.0  # epoch 秒；早于此时间不重新全量扫描服务器（冷却）


def _recover_server():
    """钉的服务器连不上 → 重测服务器列表挑一个真实可用的并切过去（带 5 分钟冷却）。换成功返回 True。
    用于「钉死的公共服务器突然宕机」自愈：bestip 在某些网络连不通，故这里用真实查询校验过的列表挑选。"""
    global _server, _recover_after
    now = time.time()
    if now < _recover_after:
        return False
    _recover_after = now + 300
    try:
        results = test_servers()
    except Exception:
        return False
    best = next((r for r in results if r.get("ok")), None)
    if not best:
        return False
    _server = (best["addr"], int(best["port"]))
    _reset()
    return True


def _call(fn):
    """串行化(连接非线程安全) + 一次重连重试；钉的服务器挂了自动重选；异常返回 None。"""
    with _lock:
        for attempt in (1, 2):
            try:
                return fn(_get_client())
            except Exception:
                _reset()
        # 两次都失败：钉的服务器(或当前选择)连不上 → 自动重选可用服务器(带冷却)，成功再试一次。
        if _recover_server():
            try:
                return fn(_get_client())
            except Exception:
                _reset()
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


def _latest_close_vol(code):
    """最近一日 (收盘, 成交量手)。一次 bars 调用同时取价与量(算换手率用)。"""
    def fn(c):
        raw = c.bars(symbol=code, frequency=9, offset=2)
        if raw is None or len(raw) == 0:
            return (None, None)
        last = raw.iloc[-1]
        vol = last.get("vol") if "vol" in last.index else last.get("volume")
        return (_f(last["close"]), _f(vol))
    r = _call(fn)
    return r if r is not None else (None, None)


def turnover_pct(vol_lots, float_shares):
    """换手率% = 成交量(股) / 流通股本(股) × 100。TDX bars 的 vol 单位是「手」(×100=股)。"""
    if not vol_lots or not float_shares or float_shares <= 0:
        return None
    return round(vol_lots * 100 / float_shares * 100, 2)


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
        # 必须是「分列表头行」(split 出 ≥3 段)，否则会误命中标题行
        # "…★本栏包括【1.主要财务指标】…更新日期:YYYY-MM-DD"——新版「通达信沪深京F10」标题里
        # 就含"财务指标"+日期、却无列分隔，split 后只有 1 段 → 旧逻辑误判致整表解析失败。
        if "财务指标" in ln and re.search(r"\d{4}-\d{2}-\d{2}", ln):
            cells = [x.strip() for x in ln.split("｜")]
            if len(cells) >= 3:
                hdr = cells
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


def _f10_cell(lines, label):
    """在 F10 ｜全角竖线表里找 label 紧邻右侧单元格值。"""
    for ln in lines:
        cells = [x.strip() for x in ln.split("｜")]
        for i, cel in enumerate(cells):
            if cel.startswith(label) and i + 1 < len(cells):
                v = cells[i + 1].strip()
                if v:
                    return v
    return None


def stock_profile(code):
    """F10 公司概况(行业/概述) + 经营分析(主营产品)。返回 {industry, summary, products}，缺失为 None。"""
    out = {"industry": None, "summary": None, "products": None}
    try:
        gk = _call(lambda c: c.F10(symbol=code, name="公司概况"))
        if isinstance(gk, str) and gk:
            lines = gk.split("\n")
            out["industry"] = _f10_cell(lines, "所属行业") or _f10_cell(lines, "行业")
            comp = _f10_cell(lines, "公司名称")
            scope = _f10_cell(lines, "经营范围") or _f10_cell(lines, "主营业务")
            parts = [x for x in [comp, scope] if x]
            if parts:
                out["summary"] = ("；".join(parts))[:200]
    except Exception:
        pass
    try:
        jy = _call(lambda c: c.F10(symbol=code, name="经营分析"))
        if isinstance(jy, str) and jy:
            m = re.search(r"(?m)^【1\.主营业务】(.+?)【", jy, re.S)
            if m:
                txt = re.sub(r"[┌┐└┘├┤┬┴┼─｜\s]", "", m.group(1)).strip()
                if txt:
                    out["products"] = txt[:200]
    except Exception:
        pass
    return out


def _f10_text(code):
    return _call(lambda c: c.F10(symbol=code, name="财务分析"))


def _share_counts(code):
    """(总股本, 流通股本) 均为股。一次 finance 调用取两者(PS 用总股本，换手率用流通股本)。"""
    def fn(c):
        fin = c.finance(symbol=code)
        if fin is None or len(fin) == 0:
            return (None, None)
        r = fin.iloc[0]
        return (_f(r.get("zongguben")), _f(r.get("liutongguben")))
    r = _call(fn)
    return r if r is not None else (None, None)


def finance_fundamentals(code):
    """F10 财务分析(干净) + 当前价/量 + 总/流通股本 → roe_ttm/pe/pb/ps/net_profit/turnover_rate。
    PE/PS/ROE/净利润用最近年报(静态)，PB 用最新每股净资产(MRQ)，换手率用最近一日量/流通股本。"""
    price, vol = _latest_close_vol(code)        # 独立 _call（价+量）
    total_shares, float_shares = _share_counts(code)  # 独立 _call（总+流通股本）
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
    if price and total_shares and ind["revenue"]:
        out["ps"] = round(price * total_shares / ind["revenue"], 2)
    if ind["net_profit"] is not None:
        out["net_profit"] = ind["net_profit"]
    tr = turnover_pct(vol, float_shares)
    if tr is not None:
        out["turnover_rate"] = tr
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


_IDX_MARKET = {"sh": 1, "sz": 0, "bj": 2}


def index_realtime(prefixed):
    # prefixed 形如 'sh000001'：前2位市场，后6位代码。用原始 pytdx 显式 market 取指数实时。
    pfx, code = prefixed[:2].lower(), prefixed[-6:]
    market = _IDX_MARKET.get(pfx)
    if market is None:
        return None
    def fn(c):
        raw = getattr(c, "client", None)
        if raw is None:
            return None
        q = raw.get_security_quotes([(market, code)])
        if not q:
            return None
        r = q[0]
        return {
            "price": _f(r.get("price")),
            "prev_close": _f(r.get("last_close")),
            "open": _f(r.get("open")),
            "high": _f(r.get("high")),
            "low": _f(r.get("low")),
            "time": str(r.get("servertime") or ""),
        }
    return _call(fn)


def realtime(code):
    def fn(c):
        q = c.quotes(symbol=code)
        if q is None or len(q) == 0:
            return None
        r = q.iloc[0]
        out = {
            "price": _f(r.get("price")), "open": _f(r.get("open")),
            "high": _f(r.get("high")), "low": _f(r.get("low")),
            "prev_close": _f(r.get("last_close")),
            "volume": _f(r.get("vol")), "name": None,
            "time": str(r.get("servertime") or ""),
        }
        for i in range(1, 6):
            out[f"bid{i}"] = _f(r.get(f"bid{i}"))
            out[f"bid{i}_vol"] = _f(r.get(f"bid_vol{i}"))
            out[f"ask{i}"] = _f(r.get(f"ask{i}"))
            out[f"ask{i}_vol"] = _f(r.get(f"ask_vol{i}"))
        return out
    return _call(fn)


def list_servers():
    """142 个通达信行情服务器 [{site,addr,port}]（静态列表，无网络）。"""
    from mootdx.server import hosts
    return [{"site": h.get("site"), "addr": h.get("addr"), "port": int(h.get("port"))} for h in hosts.get("HQ", [])]


def _probe_server(h):
    t0 = time.perf_counter()
    try:
        c = Quotes.factory(market="std", server=(h["addr"], int(h["port"])), bestip=False, timeout=2, raise_exception=True)
        try:
            n = c.stock_count(market=1)
            ok = bool(n and int(n) > 0)
        finally:
            try:
                c.close()
            except Exception:
                pass
        return {"site": h["site"], "addr": h["addr"], "port": int(h["port"]),
                "ok": ok, "latency_ms": round((time.perf_counter() - t0) * 1000, 1) if ok else None}
    except Exception:
        return {"site": h["site"], "addr": h["addr"], "port": int(h["port"]), "ok": False, "latency_ms": None}


def test_servers():
    """并行测全部服务器（真实查询校验+延迟），按 可用→延迟 排序。约 10-20s。"""
    servers = list_servers()
    out = []
    with ThreadPoolExecutor(max_workers=24) as ex:
        for r in ex.map(_probe_server, servers):
            out.append(r)
    out.sort(key=lambda x: (not x["ok"], x["latency_ms"] if x["latency_ms"] is not None else 9e9))
    return out


def index_bars(code, days=120):
    """上证/深证指数日线（不复权）。返回升序 [{date,open,high,low,close,volume}]。
    code: '000001'(上证), '399001'(深成指), '399006'(创业板指)。
    通达信 c.index() 直接以这三个 symbol 返回指数点位（非个股价格）。
    """
    def fn(c):
        raw = c.index(symbol=code, frequency=9, offset=days)
        if raw is None or len(raw) == 0:
            return []
        bars = []
        for _, r in raw.iterrows():
            d = str(r.get("datetime") or r.get("date"))[:10]
            bars.append({
                "date": d,
                "open": _f(r.get("open")),
                "high": _f(r.get("high")),
                "low": _f(r.get("low")),
                "close": _f(r.get("close")),
                "volume": _f(r.get("vol") if "vol" in r.index else r.get("volume")),
            })
        bars.sort(key=lambda b: b["date"])
        return bars
    result = _call(fn)
    return result if result is not None else []


def get_server():
    return {"addr": _server[0], "port": _server[1]} if _server else None


def set_server(addr, port):
    """addr 空 → 自动 bestip；否则 pin (addr,port)。重置客户端即时生效。"""
    global _server
    if addr and str(addr).strip():
        _server = (str(addr).strip(), int(port))
    else:
        _server = None
    _reset()
