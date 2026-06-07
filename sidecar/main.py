"""股票小作手 — AkShare data sidecar.

A thin, defensive HTTP wrapper over AkShare. Every field is computed in its own
try/except so a partial response is fine — the Node side fills what it can and
reports the rest as `_missing`. AkShare call→field mappings may need tuning on a
real run; keep them isolated so one broken endpoint never sinks the whole response.
"""
from datetime import datetime
import time

import socket
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

# Bound all upstream network calls so a blocked/slow source fails fast instead of hanging.
socket.setdefaulttimeout(20)

from fastapi import FastAPI
import akshare as ak

app = FastAPI(title="stock-agent akshare sidecar")

# BaoStock: free, no-token A-share source for fundamentals (PE/PB/PS/ROE/净利/换手).
# IMPORTANT: never login at import — that network call can hang and block uvicorn startup.
try:
    import baostock as bs
except Exception:
    bs = None

_BS_LOGGED_IN = False


_EXEC = ThreadPoolExecutor(max_workers=6)


def _timed(fn, seconds=10):
    """Run a blocking upstream call but never wait longer than `seconds`."""
    try:
        return _EXEC.submit(fn).result(timeout=seconds)
    except Exception:
        return None


def _ensure_bs() -> bool:
    global _BS_LOGGED_IN
    if bs is None:
        return False
    if _BS_LOGGED_IN:
        return True
    try:
        lg = bs.login()
        _BS_LOGGED_IN = getattr(lg, "error_code", "1") == "0"
        return _BS_LOGGED_IN
    except Exception:
        return False


def _bs_code(code: str) -> str:
    code = code[-6:]
    return ("sh." if code[0] == "6" else "sz.") + code


def _recent_quarters(n: int = 6):
    y = datetime.now().year
    q = (datetime.now().month - 1) // 3 + 1
    out = []
    for _ in range(n):
        out.append((y, q))
        q -= 1
        if q == 0:
            q = 4
            y -= 1
    return out


def _f(x):
    try:
        v = float(x)
        return v if v == v else None  # NaN guard
    except Exception:
        return None


@app.get("/health")
def health():
    return {"status": "ok", "ts": datetime.now().isoformat()}


_NAME_DF = None

try:
    from pypinyin import pinyin, Style

    def _py_initials(name: str) -> str:
        """拼音首字母缩写。多音字(如"长" cháng/zhǎng)生成所有候选组合(空格分隔)，
        这样无论按哪种读音输入(clkj 或 zlkj)都能搜到长亮科技。"""
        try:
            per_char = pinyin(name, style=Style.FIRST_LETTER, heteronym=True)
            opts_list = []
            for opts in per_char:
                seen = []
                for p in opts:
                    if p and p[0].lower() not in seen:
                        seen.append(p[0].lower())
                opts_list.append(seen or [''])
            combos = ['']
            for opts in opts_list:
                combos = [c + o for c in combos for o in opts]
                if len(combos) > 24:  # 防多音字组合爆炸
                    combos = combos[:24]
            return ' '.join(dict.fromkeys(combos))
        except Exception:
            return ''
except Exception:
    def _py_initials(name: str) -> str:
        return ''


@app.get("/stocks")
def stocks_all():
    """全量 A 股 code+name+拼音首字母（静态、低失效性，供本地缓存与搜索）。"""
    try:
        df = ak.stock_info_a_code_name()
        out = []
        for _, r in df.iterrows():
            code = str(r.get("code"))[-6:]
            name = str(r.get("name"))
            out.append({"code": code, "name": name, "py": _py_initials(name)})
        return out
    except Exception:
        return []


@app.get("/name/{code}")
def stock_name(code: str):
    """Code -> name via the full A-share list (reliable, independent of the spot endpoint)."""
    global _NAME_DF
    code = code[-6:]
    try:
        if _NAME_DF is None:
            _NAME_DF = ak.stock_info_a_code_name()
        row = _NAME_DF[_NAME_DF["code"].astype(str).str[-6:] == code]
        if not row.empty:
            return {"code": code, "name": str(row.iloc[0]["name"])}
    except Exception:
        pass
    return {"code": code, "name": None}


def _bs_fund(code: str) -> dict:
    out: dict = {}
    if not _ensure_bs():
        return out
    bcode = _bs_code(code)
    try:
        start = (datetime.now() - timedelta(days=20)).strftime("%Y-%m-%d")
        rs = bs.query_history_k_data_plus(bcode, "date,close,turn,peTTM,pbMRQ,psTTM", start_date=start, frequency="d", adjustflag="3")
        rows = []
        while rs and rs.error_code == "0" and rs.next():
            rows.append(rs.get_row_data())
        if rows:
            last = rows[-1]
            out["pe"], out["pb"], out["ps"], out["turnover_rate"] = _f(last[3]), _f(last[4]), _f(last[5]), _f(last[2])
    except Exception:
        pass
    try:
        for (y, q) in _recent_quarters():
            pr = bs.query_profit_data(code=bcode, year=y, quarter=q)
            prows = []
            while pr and pr.error_code == "0" and pr.next():
                prows.append(pr.get_row_data())
            if prows:
                d = dict(zip(pr.fields, prows[0]))
                roe = _f(d.get("roeAvg"))
                out["roe_ttm"] = round(roe * 100, 2) if roe is not None else None  # baostock roeAvg is a ratio
                out["net_profit"] = _f(d.get("netProfit"))
                break
    except Exception:
        pass
    return out


def _ak_fund(code: str) -> dict:
    out: dict = {}
    try:
        abstract = ak.stock_financial_abstract(symbol=code)
        cols = [c for c in abstract.columns if c not in ("选项", "指标")]
        latest = cols[0] if cols else None
        def pick(name):
            row = abstract[abstract["指标"].astype(str).str.contains(name, na=False)]
            return _f(row[latest].iloc[0]) if (latest and not row.empty) else None
        out["net_profit"] = pick("归母净利润") or pick("净利润")
        out["roe_ttm"] = pick("净资产收益率")
    except Exception:
        pass
    try:
        hist = ak.stock_zh_a_hist(symbol=code, period="daily", adjust="qfq")
        if not hist.empty and "换手率" in hist.columns:
            out["turnover_rate"] = _f(hist.iloc[-1]["换手率"])
    except Exception:
        pass
    return out


@app.get("/fundamentals/{code}")
def fundamentals(code: str, order: str = ""):
    code = code[-6:]
    merged: dict = {}
    first_source = None
    for reg in _order_providers("fundamentals", order):
        data = _timed(lambda r=reg: r["fn"](code, 0), 10)
        if not isinstance(data, dict):
            continue
        contributed = False
        for k, v in data.items():
            if merged.get(k) is None and v is not None:
                merged[k] = v
                contributed = True
        if first_source is None and contributed:
            first_source = reg["key"]
    return {"source": first_source, "data": merged}


def _bs_quote(code: str, days: int):
    if not _ensure_bs():
        return None
    try:
        start = (datetime.now() - timedelta(days=days * 2 + 20)).strftime("%Y-%m-%d")
        rs = bs.query_history_k_data_plus(_bs_code(code), "date,open,high,low,close,volume", start_date=start, frequency="d", adjustflag="2")
        rows = []
        while rs and rs.error_code == "0" and rs.next():
            d = rs.get_row_data()
            rows.append({"date": d[0], "open": _f(d[1]), "high": _f(d[2]), "low": _f(d[3]), "close": _f(d[4]), "volume": _f(d[5])})
        return rows[-days:] if rows else []
    except Exception:
        return None


def _ak_quote(code: str, days: int):
    try:
        hist = ak.stock_zh_a_hist(symbol=code, period="daily", adjust="qfq").tail(days)
        return [
            {"date": str(r.get("日期")), "open": _f(r.get("开盘")), "high": _f(r.get("最高")), "low": _f(r.get("最低")), "close": _f(r.get("收盘")), "volume": _f(r.get("成交量"))}
            for _, r in hist.iterrows()
        ]
    except Exception:
        return None


# 每类数据的候选上游 provider。fetch(code/None, days) 返回标准化结果或 None。
def _quote_em(code, days):   return _ak_quote(code, days)            # 东方财富 stock_zh_a_hist
def _quote_tx(code, days):
    df = ak.stock_zh_a_hist_tx(symbol=_mkt_prefix(code)).tail(days)
    return [{"date": str(r.get("date")), "open": _f(r.get("open")), "high": _f(r.get("high")), "low": _f(r.get("low")), "close": _f(r.get("close")), "volume": _f(r.get("amount"))} for _, r in df.iterrows()]
def _quote_sina(code, days):
    df = ak.stock_zh_a_daily(symbol=_mkt_prefix(code), adjust="qfq").tail(days)
    return [{"date": str(r.get("date")), "open": _f(r.get("open")), "high": _f(r.get("high")), "low": _f(r.get("low")), "close": _f(r.get("close")), "volume": _f(r.get("volume"))} for _, r in df.iterrows()]
def _quote_baostock(code, days): return _bs_quote(code, days)

QUOTE_PROVIDERS = [
    {"key": "tx",       "label": "腾讯",     "fn": _quote_tx},
    {"key": "sina",     "label": "新浪",     "fn": _quote_sina},
    {"key": "em",       "label": "东方财富", "fn": _quote_em},
    {"key": "baostock", "label": "BaoStock", "fn": _quote_baostock},
]

def _fund_baostock(code, days): return _bs_fund(code)
def _fund_em(code, days):       return _ak_fund(code)
def _sentiment_em(_code, _days):
    return _market_sentiment_em()   # 抽出现有 /market/sentiment 主体
def _news_provider(fn_name):
    def _f(_code, limit):
        f = getattr(ak, fn_name, None)
        if not f: return None
        df = f()
        rows = []
        for _, r in df.head(limit or 20).iterrows():
            title = r.get("标题") or r.get("内容") or r.get("summary")
            ts = r.get("发布时间") or r.get("时间") or r.get("datetime") or r.get("publish_time") or ""
            summary = r.get("摘要") or r.get("内容") or ""
            if title:
                rows.append({"title": str(title), "summary": str(summary)[:200], "published_at": str(ts)})
        return rows or None
    return _f

PROVIDERS = {
    "quote": QUOTE_PROVIDERS,
    "fundamentals": [
        {"key": "baostock", "label": "BaoStock", "fn": _fund_baostock},
        {"key": "em",       "label": "东方财富", "fn": _fund_em},
    ],
    "sentiment": [
        {"key": "em", "label": "东方财富", "fn": _sentiment_em},
    ],
    "news": [
        {"key": "em",   "label": "东方财富", "fn": _news_provider("stock_info_global_em")},
        {"key": "cjzc", "label": "财经早餐", "fn": _news_provider("stock_info_cjzc_em")},
        {"key": "cls",  "label": "财联社",   "fn": _news_provider("stock_info_global_cls")},
    ],
}

def _order_providers(kind, order):
    regs = PROVIDERS.get(kind, [])
    if not order:
        return regs
    want = [k for k in order.split(",") if k]
    by_key = {r["key"]: r for r in regs}
    picked = [by_key[k] for k in want if k in by_key]
    return picked or regs

def _probe_one(reg, kind):
    t0 = time.time()
    try:
        if kind in ("quote", "fundamentals"):
            data = _timed(lambda: reg["fn"]("600519", 5), 8)
        else:
            data = _timed(lambda: reg["fn"](None, 5), 8)
        ok = bool(data)
        return {"key": reg["key"], "label": reg["label"], "reachable": ok, "latency_ms": int((time.time() - t0) * 1000) if ok else None, "error": None if ok else "空/超时"}
    except Exception as e:
        return {"key": reg["key"], "label": reg["label"], "reachable": False, "latency_ms": None, "error": str(e)[:120]}


@app.get("/probe/list")
def probe_list(kind: str = "quote"):
    return [{"key": r["key"], "label": r["label"]} for r in PROVIDERS.get(kind, [])]

@app.get("/probe")
def probe(kind: str = "quote", provider: str = ""):
    regs = PROVIDERS.get(kind, [])
    if provider:
        regs = [r for r in regs if r["key"] == provider]
    return [_probe_one(reg, kind) for reg in regs]


@app.get("/quote/{code}")
def quote(code: str, days: int = 120, order: str = ""):
    code = code[-6:]
    for reg in _order_providers("quote", order):
        rows = _timed(lambda r=reg: r["fn"](code, days), 10)
        if rows:
            return {"source": reg["key"], "rows": rows}
    return {"source": None, "rows": []}


@app.get("/realtime/{code}")
def realtime(code: str):
    code = code[-6:]
    def _fn():
        import easyquotation
        eq = easyquotation.use("sina")
        d = eq.real([code], prefix=False) or {}
        row = d.get(code) or {}
        if not row:
            return None
        return {
            "price": _f(row.get("now")),
            "open": _f(row.get("open")),
            "high": _f(row.get("high")),
            "low": _f(row.get("low")),
            "prev_close": _f(row.get("close")),
            "volume": _f(row.get("volume") or row.get("turnover")),
            "name": row.get("name"),
            "time": (str(row.get("date", "")) + " " + str(row.get("time", ""))).strip(),
        }
    data = _timed(_fn, 8)
    return {"source": "sina-rt" if data else None, "data": data or {}}


@app.get("/news")
def news(limit: int = 20, order: str = ""):
    for reg in _order_providers("news", order):
        rows = _timed(lambda r=reg: r["fn"](None, limit), 10)
        if rows:
            return {"source": reg["key"], "rows": rows}
    return {"source": None, "rows": []}


@app.get("/sectors/hot")
def sectors_hot(top: int = 5):
    try:
        df = ak.stock_board_industry_name_em()
        col = "涨跌幅" if "涨跌幅" in df.columns else None
        if col:
            df = df.sort_values(col, ascending=False)
        rows = []
        for _, r in df.head(top).iterrows():
            rows.append({"name": r.get("板块名称") or r.get("板块"), "change": _f(r.get("涨跌幅"))})
        return [x for x in rows if x["name"]]
    except Exception:
        return []


@app.get("/sectors/{name}/cons")
def sector_cons(name: str):
    try:
        df = ak.stock_board_industry_cons_em(symbol=name)
        return [{"code": str(r.get("代码")), "name": r.get("名称")} for _, r in df.iterrows()]
    except Exception:
        return []


def _mkt_prefix(code: str) -> str:
    code = code[-6:]
    return ("sh" if code[0] == "6" else "sz") + code


@app.get("/sina/quote/{code}")
def sina_quote(code: str, days: int = 120):
    """行情(收盘价)来自新浪，用于交叉验证。"""
    try:
        df = ak.stock_zh_a_daily(symbol=_mkt_prefix(code), adjust="qfq").tail(days)
        return [{"date": str(r.get("date")), "open": _f(r.get("open")), "high": _f(r.get("high")), "low": _f(r.get("low")), "close": _f(r.get("close")), "volume": _f(r.get("volume"))} for _, r in df.iterrows()]
    except Exception:
        return []


@app.get("/tx/quote/{code}")
def tx_quote(code: str, days: int = 120):
    """行情(收盘价)来自腾讯，用于交叉验证。"""
    try:
        df = ak.stock_zh_a_hist_tx(symbol=_mkt_prefix(code)).tail(days)
        return [{"date": str(r.get("date")), "open": _f(r.get("open")), "high": _f(r.get("high")), "low": _f(r.get("low")), "close": _f(r.get("close")), "volume": _f(r.get("amount"))} for _, r in df.iterrows()]
    except Exception:
        return []


# Provider-prefixed name/health so '/sina' and '/tx' bases also answer those calls.
@app.get("/sina/name/{code}")
@app.get("/tx/name/{code}")
def provider_name(code: str):
    return stock_name(code)


def _market_sentiment_em() -> dict | None:
    out = {"limit_up_count": None, "limit_down_count": None, "sse_ma20_slope": None}
    today = datetime.now().strftime("%Y%m%d")
    try:
        out["limit_up_count"] = int(len(ak.stock_zt_pool_em(date=today)))
    except Exception:
        pass
    try:
        out["limit_down_count"] = int(len(ak.stock_zt_pool_dtgc_em(date=today)))
    except Exception:
        pass
    try:
        idx = ak.stock_zh_index_daily(symbol="sh000001").tail(21)
        closes = idx["close"].astype(float).tolist()
        ma_today = sum(closes[-20:]) / 20
        ma_prev = sum(closes[-21:-1]) / 20
        out["sse_ma20_slope"] = round(ma_today - ma_prev, 4)
    except Exception:
        pass
    # Return None when every field is None so probe/route treats total failure as unreachable.
    if out["limit_up_count"] is None and out["limit_down_count"] is None and out["sse_ma20_slope"] is None:
        return None
    return out


@app.get("/market/sentiment")
def market_sentiment(order: str = ""):
    for reg in _order_providers("sentiment", order):
        data = _timed(lambda r=reg: r["fn"](None, 0), 10)
        if data:
            return {"source": reg["key"], "data": data}
    return {"source": None, "data": {}}
