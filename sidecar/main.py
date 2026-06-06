"""股票小作手 — AkShare data sidecar.

A thin, defensive HTTP wrapper over AkShare. Every field is computed in its own
try/except so a partial response is fine — the Node side fills what it can and
reports the rest as `_missing`. AkShare call→field mappings may need tuning on a
real run; keep them isolated so one broken endpoint never sinks the whole response.
"""
from datetime import datetime

from fastapi import FastAPI
import akshare as ak

app = FastAPI(title="stock-agent akshare sidecar")


def _f(x):
    try:
        v = float(x)
        return v if v == v else None  # NaN guard
    except Exception:
        return None


@app.get("/health")
def health():
    return {"status": "ok", "ts": datetime.now().isoformat()}


@app.get("/fundamentals/{code}")
def fundamentals(code: str):
    code = code[-6:]
    out: dict = {}

    # name / PE(dynamic) / PB / turnover from the whole-market spot snapshot (one call).
    try:
        spot = ak.stock_zh_a_spot_em()
        row = spot[spot["代码"] == code]
        if not row.empty:
            r = row.iloc[0]
            out["name"] = r.get("名称")
            out["pe"] = _f(r.get("市盈率-动态"))
            out["pb"] = _f(r.get("市净率"))
            out["turnover_rate"] = _f(r.get("换手率"))
    except Exception:
        pass

    # ROE(TTM) + 归母净利润 via financial abstract / indicators (latest reported)
    try:
        abstract = ak.stock_financial_abstract(symbol=code)
        # abstract is wide: 指标 + period columns; pick the most recent numeric column
        cols = [c for c in abstract.columns if c not in ("选项", "指标")]
        latest = cols[0] if cols else None
        def pick(name):
            row = abstract[abstract["指标"].astype(str).str.contains(name, na=False)]
            return _f(row[latest].iloc[0]) if (latest and not row.empty) else None
        out["net_profit"] = pick("归母净利润") or pick("净利润")
        out["roe_ttm"] = pick("净资产收益率")
    except Exception:
        pass

    # turnover rate from latest daily bar
    try:
        hist = ak.stock_zh_a_hist(symbol=code, period="daily", adjust="qfq")
        if not hist.empty and "换手率" in hist.columns:
            out["turnover_rate"] = _f(hist.iloc[-1]["换手率"])
    except Exception:
        pass

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
