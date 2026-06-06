"""股票小作手 — AkShare data sidecar.

A thin, defensive HTTP wrapper over AkShare. Every field is computed in its own
try/except so a partial response is fine — the Node side fills what it can and
reports the rest as `_missing`. AkShare call→field mappings may need tuning on a
real run; keep them isolated so one broken endpoint never sinks the whole response.
"""
from datetime import datetime

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
    from pypinyin import lazy_pinyin, Style

    def _py_initials(name: str) -> str:
        try:
            return ''.join(s[0] for s in lazy_pinyin(name, style=Style.FIRST_LETTER) if s).lower()
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
def fundamentals(code: str):
    code = code[-6:]
    out: dict = {}
    try:
        out["name"] = stock_name(code).get("name")
    except Exception:
        pass

    # BaoStock primary (bounded so a blocked source never hangs the request)
    bsd = _timed(lambda: _bs_fund(code), 10) or {}
    for k, v in bsd.items():
        if v is not None:
            out[k] = v

    # AkShare fallback only for fields still missing
    if out.get("roe_ttm") is None or out.get("net_profit") is None or out.get("turnover_rate") is None:
        akd = _timed(lambda: _ak_fund(code), 10) or {}
        for k in ("roe_ttm", "net_profit", "turnover_rate"):
            if out.get(k) is None and akd.get(k) is not None:
                out[k] = akd[k]

    return out


@app.get("/quote/{code}")
def quote(code: str, days: int = 120):
    code = code[-6:]
    try:
        hist = ak.stock_zh_a_hist(symbol=code, period="daily", adjust="qfq")
        hist = hist.tail(days)
        rows = []
        for _, r in hist.iterrows():
            rows.append({
                "date": str(r.get("日期")),
                "open": _f(r.get("开盘")),
                "high": _f(r.get("最高")),
                "low": _f(r.get("最低")),
                "close": _f(r.get("收盘")),
                "volume": _f(r.get("成交量")),
            })
        return rows
    except Exception:
        return []


@app.get("/news")
def news(limit: int = 20):
    """热点财经快讯，best-effort across a few AkShare sources."""
    for fn in ("stock_info_global_em", "stock_info_cjzc_em", "stock_info_global_cls"):
        f = getattr(ak, fn, None)
        if not f:
            continue
        try:
            df = f()
            rows = []
            for _, r in df.head(limit).iterrows():
                title = r.get("标题") or r.get("内容") or r.get("summary")
                ts = r.get("发布时间") or r.get("时间") or r.get("datetime") or r.get("publish_time") or ""
                summary = r.get("摘要") or r.get("内容") or ""
                if title:
                    rows.append({"title": str(title), "summary": str(summary)[:200], "published_at": str(ts)})
            if rows:
                return rows
        except Exception:
            continue
    return []


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


@app.get("/market/sentiment")
def market_sentiment():
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
    return out
