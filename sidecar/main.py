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


# 出站取数(akshare 底层走 requests)统一伪装浏览器 header + 429/5xx 退避重试。
# 财经站点对裸 python-requests / 高频请求常返 429/403;装上浏览器 UA + Retry 降低被封概率。
def _install_http_hardening():
    try:
        import requests
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry

        ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
        common = {
            "User-Agent": ua,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept": "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
        }
        # 默认 headers(新建 Session 都带上)
        try:
            requests.utils.default_headers().update(common)
        except Exception:
            pass

        retry = Retry(total=4, connect=2, read=2, backoff_factor=0.6,
                      status_forcelist=[429, 500, 502, 503, 504],
                      allowed_methods=frozenset(["GET", "POST"]),
                      respect_retry_after_header=True, raise_on_status=False)

        _orig_request = requests.sessions.Session.request

        def _patched(self, method, url, **kwargs):
            # 注入浏览器 UA(若调用方没显式给)
            headers = kwargs.get("headers") or {}
            for k, v in common.items():
                headers.setdefault(k, v)
            kwargs["headers"] = headers
            # 出站代理（仅 http 模式经此注入；socks5 走全局 socket 补丁，current_proxies() 为 None）
            try:
                import proxy as _proxy
                if _proxy.current_proxies() and "proxies" not in kwargs:
                    kwargs["proxies"] = _proxy.current_proxies()
            except Exception:
                pass
            # 给该 session 挂上带 Retry 的 adapter(只挂一次)
            if not getattr(self, "_hardened", False):
                try:
                    self.mount("https://", HTTPAdapter(max_retries=retry))
                    self.mount("http://", HTTPAdapter(max_retries=retry))
                except Exception:
                    pass
                self._hardened = True
            return _orig_request(self, method, url, **kwargs)

        requests.sessions.Session.request = _patched
    except Exception:
        pass


_install_http_hardening()

from fastapi import FastAPI, Body
import akshare as ak
import tdx
import proxy
import direct_sources

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


@app.get("/trade-calendar")
def trade_calendar():
    # A 股交易日历（新浪线路，含本年已公布节假日安排）；返回全部交易日 'YYYY-MM-DD'
    df = _timed(lambda: ak.tool_trade_date_hist_sina(), 15)
    if df is None:
        return {"source": "sina", "dates": []}
    dates = sorted({str(d)[:10] for d in df["trade_date"].tolist()})
    return {"source": "sina", "dates": dates}


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
    """全量 A 股 code+name+拼音首字母（TDX 优先，akshare 兜底）。"""
    lst = _timed(lambda: tdx.stocks(), 20)
    if lst:
        return [{"code": s["code"], "name": s["name"], "py": _py_initials(s["name"])} for s in lst]
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
        # 20s：通达信冷启动(选服务器+F10+股本三次调用)实测 ~9.6s，10s 偶尔超时→空→个股分析被校验门槛硬拦。
        data = _timed(lambda r=reg: r["fn"](code, 0), 20)
        if not isinstance(data, dict):
            continue
        contributed = False
        for k, v in data.items():
            if merged.get(k) is None and v is not None:
                merged[k] = v
                contributed = True
        if first_source is None and contributed:
            first_source = reg["key"]
        # 关键字段齐了就停，避免再去跑本网络下会挂起的源（如 baostock）。
        # turnover_rate 多为非否决项、且其上游(eastmoney push2his)本网络常被堵，不纳入早停条件。
        if all(merged.get(k) is not None for k in ("pe", "pb", "ps", "roe_ttm", "net_profit")):
            break
    return {"source": first_source, "data": merged}


@app.get("/profile/{code}")
def profile(code: str):
    code = code[-6:]
    try:
        return tdx.stock_profile(code)
    except Exception as e:
        return {"industry": None, "summary": None, "products": None, "error": str(e)[:120]}


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

def _quote_tdx(code, days): return tdx.bars_qfq(code, days)
QUOTE_PROVIDERS = [
    {"key": "tdx",      "label": "通达信",   "fn": _quote_tdx},
    {"key": "tx",       "label": "腾讯",     "fn": _quote_tx},
    {"key": "sina",     "label": "新浪",     "fn": _quote_sina},
    {"key": "em",       "label": "东方财富", "fn": _quote_em},
    {"key": "baostock", "label": "BaoStock", "fn": _quote_baostock},
]

def _fund_baostock(code, days): return _bs_fund(code)
def _fund_em(code, days):       return _ak_fund(code)

# 新闻 / 涨停跌停：eastmoney host 直连可达、经 socks5 代理会被掐断（行情 push2his 反之必须走代理），
# 故这两类源始终直连——代理生效时走「无补丁」子进程绕开，代理关闭时直接进程内调用（同一份 direct_sources 逻辑）。
def _news_direct(_code, limit):
    d = proxy.run_direct_json("news", limit or 20) if proxy.proxy_active() else direct_sources.fetch_news(limit or 20)
    rows = d.get("rows") if isinstance(d, dict) else None
    return rows or None

def _sentiment_direct(_code, _days):
    d = proxy.run_direct_json("sentiment", 0) if proxy.proxy_active() else direct_sources.fetch_sentiment()
    return d if isinstance(d, dict) else None

def _fund_tdx(code, _days=0): return tdx.finance_fundamentals(code)

# 百度估值：本网络下 stock_zh_valuation_baidu 可用，直接给 PE(TTM)/PB；PS 由 总市值/最近年报营收 算出。
# （TDX 断线、eastmoney 指标接口/legulegu/baostock 在本网络被堵或挂起时的 pe/pb/ps 兜底。）
def _baidu_val(code, indicator):
    try:
        df = ak.stock_zh_valuation_baidu(symbol=code, indicator=indicator, period="近一年")
        if df is not None and len(df):
            return _f(df.iloc[-1].get("value"))
    except Exception:
        return None
    return None

def _latest_annual_revenue(code):
    try:
        ab = ak.stock_financial_abstract(symbol=code)
        cols = [c for c in ab.columns if c not in ("选项", "指标")]
        row = ab[ab["指标"].astype(str).str.fullmatch("营业总收入")]
        if row.empty:
            row = ab[ab["指标"].astype(str).str.contains("营业总收入", na=False)]
        annual = [c for c in cols if len(str(c)) == 8 and str(c).endswith("1231")]
        if annual and not row.empty:
            return _f(row[annual[0]].iloc[0])
    except Exception:
        return None
    return None

def _fund_baidu(code, _days=0):
    out = {}
    pe = _baidu_val(code, "市盈率(TTM)")
    pb = _baidu_val(code, "市净率")
    if pe is not None: out["pe"] = pe
    if pb is not None: out["pb"] = pb
    mcap_yi = _baidu_val(code, "总市值")  # 亿元
    if mcap_yi is not None:
        rev = _latest_annual_revenue(code)  # 元
        if rev and rev > 0:
            out["ps"] = round(mcap_yi * 1e8 / rev, 2)
    return out or None

PROVIDERS = {
    "quote": QUOTE_PROVIDERS,
    "fundamentals": [
        {"key": "tdx",      "label": "通达信",   "fn": _fund_tdx},
        {"key": "baidu",    "label": "百度",     "fn": _fund_baidu},
        {"key": "em",       "label": "东方财富", "fn": _fund_em},
        {"key": "baostock", "label": "BaoStock", "fn": _fund_baostock},
    ],
    "sentiment": [
        {"key": "direct", "label": "东方财富(直连)", "fn": _sentiment_direct},
    ],
    "news": [
        {"key": "direct", "label": "财经新闻(直连)", "fn": _news_direct},
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
    rt = _timed(lambda: tdx.realtime(code), 6)
    if rt and rt.get("price") is not None:
        return {"source": "tdx-rt", "data": rt}
    def _fn():
        import easyquotation
        eq = easyquotation.use("sina")
        d = eq.real([code], prefix=False) or {}
        row = d.get(code) or {}
        if not row:
            return None
        base = {
            "price": _f(row.get("now")), "open": _f(row.get("open")),
            "high": _f(row.get("high")), "low": _f(row.get("low")),
            "prev_close": _f(row.get("close")),
            "volume": _f(row.get("volume") or row.get("turnover")),
            "name": row.get("name"),
            "time": (str(row.get("date", "")) + " " + str(row.get("time", ""))).strip(),
        }
        for i in range(1, 6):
            base[f"bid{i}"] = _f(row.get(f"bid{i}"))
            base[f"bid{i}_vol"] = _f(row.get(f"bid{i}_volume"))
            base[f"ask{i}"] = _f(row.get(f"ask{i}"))
            base[f"ask{i}_vol"] = _f(row.get(f"ask{i}_volume"))
        return base
    data = _timed(_fn, 8)
    return {"source": "sina-rt" if data else None, "data": data or {}}


@app.get("/index-rt/{code}")
def index_quote(code: str):
    """指数实时行情（显式 market pytdx 协议）。code: 'sh000001','sz399001','sz399006','sh000688','bj899050' 等前缀格式。
    北证(bj) 服务端不推送，返回 source=null。"""
    rt = _timed(lambda: tdx.index_realtime(code), 6)
    if rt and rt.get("price") is not None:
        return {"source": "tdx-idx", "data": rt}
    return {"source": None, "data": {}}


@app.get("/news")
def news(limit: int = 20, order: str = ""):
    for reg in _order_providers("news", order):
        rows = _timed(lambda r=reg: r["fn"](None, limit), 10)
        if rows:
            return {"source": reg["key"], "rows": rows}
    return {"source": None, "rows": []}


# 热门板块 + 成分:东方财富(_em)/新浪(stock_sector_spot/detail) 都是 eastmoney/sina HTTP 源,
# 经 socks5 出站代理会被掐断(实测 /sectors/hot 走代理超时、直连 sina 1s 可达),故与新闻/情绪同样走直连:
# 代理生效→无补丁子进程直连;代理关闭→进程内直调。逻辑单一真源在 direct_sources。
@app.get("/sectors/hot")
def sectors_hot(top: int = 5):
    if proxy.proxy_active():
        r = proxy.run_direct_json("sectors_hot", top)
        return r if isinstance(r, list) else []
    return direct_sources.fetch_sectors_hot(top)


@app.get("/sectors/{name}/cons")
def sector_cons(name: str):
    if proxy.proxy_active():
        r = proxy.run_direct_json("sector_cons", name)
        return r if isinstance(r, list) else []
    return direct_sources.fetch_sector_cons(name)


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
def market_sentiment(order: str = ""):
    for reg in _order_providers("sentiment", order):
        data = _timed(lambda r=reg: r["fn"](None, 0), 10)
        if data:
            return {"source": reg["key"], "data": data}
    return {"source": None, "data": {}}


# 指数日线的新浪兜底（ak.stock_zh_index_daily 在本网络可用；eastmoney 的 index_zh_a_hist 常被 RST）。
_INDEX_SINA_SYMBOL = {"000001": "sh000001", "399001": "sz399001", "399006": "sz399006"}

def _index_sina(code: str, days: int):
    sym = _INDEX_SINA_SYMBOL.get(code)
    if not sym:
        return None
    try:
        df = ak.stock_zh_index_daily(symbol=sym).tail(days)
        return [
            {"date": str(r.get("date"))[:10], "open": _f(r.get("open")), "high": _f(r.get("high")), "low": _f(r.get("low")), "close": _f(r.get("close")), "volume": _f(r.get("volume"))}
            for _, r in df.iterrows()
        ]
    except Exception:
        return None


@app.get("/index/{code}")
def index_endpoint(code: str, days: int = 120):
    """指数日线 OHLC（不复权）。code: 000001=上证, 399001=深成指, 399006=创业板指。
    通达信优先；取不到（如 TDX 未连/无服务器）则退新浪。"""
    rows = _timed(lambda: tdx.index_bars(code, days), 10)
    if rows:
        return {"rows": rows, "source": "tdx"}
    sina = _timed(lambda: _index_sina(code, days), 15)
    if sina:
        return {"rows": sina, "source": "sina"}
    return {"rows": [], "source": None}


@app.get("/tdx/servers/test")
def tdx_servers_test():
    return {"servers": tdx.test_servers()}


@app.get("/tdx/server")
def tdx_server_get():
    return {"server": tdx.get_server()}


@app.post("/tdx/server")
def tdx_server_set(addr: str = "", port: int = 0):
    tdx.set_server(addr, port)
    return {"server": tdx.get_server()}


def _socket_socks_active():
    import socket as _s
    return _s.socket is not proxy._ORIG_SOCKET


@app.get("/proxy")
def proxy_get():
    return {"enabled": bool(proxy.current_proxies()) or _socket_socks_active(),
            "http_proxies": proxy.current_proxies()}


@app.post("/proxy")
def proxy_set(cfg: dict = Body(default={})):
    return proxy.apply_proxy(cfg)


@app.post("/proxy/test")
def proxy_test(cfg: dict = Body(default=None)):
    import time
    temp = cfg is not None and len(cfg) > 0
    if temp:
        proxy.apply_proxy(cfg, remember=False)
    t0 = time.time()
    ok, source, err = False, None, None
    try:
        r = tdx.realtime("600519")           # 轻量：拉一只实时行情
        if r and r.get("price"):
            ok, source = True, "tdx"
    except Exception as e:
        err = f"tdx: {e}"
    if not ok:
        try:
            q = ak.stock_zh_a_daily(symbol="sh600519", adjust="qfq")
            if q is not None and len(q) > 0:
                ok, source = True, "sina"
        except Exception as e:
            err = (err + " | " if err else "") + f"sina: {e}"
    latency_ms = int((time.time() - t0) * 1000)
    if temp:
        proxy.restore_last()
    return {"ok": ok, "latency_ms": latency_ms, "source": source, "error": err}
