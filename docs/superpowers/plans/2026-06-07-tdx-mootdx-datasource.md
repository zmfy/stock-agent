# TDX/mootdx 首选数据源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把通达信协议（mootdx）接成行情(EOD,前复权)/实时/股票列表/基本面的首选数据源，绕开联通线路对 HTTP 金融 CDN 的 RST，旧 HTTP 源降级作底。

**Architecture:** sidecar(Python/FastAPI) 新增 `tdx.py`（带锁单例 mootdx 客户端 + 自算前复权纯函数 + bars/stocks/finance/realtime），接进现有 `PROVIDERS` 注册表（tdx 置顶）。Node 侧零改动（契约一致）。前复权自算（不碰 mootdx 已坏的内置 qfq），PE/PB/PS 在 sidecar 基本面 provider 用「当前价 + 财务字段」算好返回（修复其长期为空）。

**Tech Stack:** Python 3 / FastAPI / mootdx(通达信协议) / pandas；既有 `_timed`/`_py_initials`/`PROVIDERS` 框架。

**spike 已验证（2026-06-07，sidecar 容器内、用户真实线路）：** TDX 行情可达；自算前复权 vs 新浪 qfq 偏差 ≤0.005%；`finance()` 字段齐全。详见 spec `docs/superpowers/specs/2026-06-07-tdx-mootdx-datasource-design.md`。

**关键契约（须对齐，勿改 Node）：**
- `/quote/{code}` → `{source, rows:[{date,open,high,low,close,volume}]}`（rows 升序、前复权）
- `/fundamentals/{code}` → `{source, data:{roe_ttm,pe,pb,ps,net_profit,...}}`（多源 merge）
- `/stocks` → `[{code,name,py}]`
- `/realtime/{code}` → `{source, data:{price,open,high,low,prev_close,volume,name,time}}`
- sidecar 入口约为 `uvicorn main:app`，`main.py` 与 `tdx.py` 同目录，`import tdx` 可用。
- `main.py` 已有 `_py_initials(name)`、`_timed(fn, sec)`、`QUOTE_PROVIDERS`(行 270)、`PROVIDERS`(行 296)。

---

### Task 1: 加 mootdx 依赖

**Files:**
- Modify: `sidecar/requirements.txt`

- [ ] **Step 1: 追加依赖**

在 `sidecar/requirements.txt` 末尾加一行：
```
mootdx>=0.11.0
```

- [ ] **Step 2: 重建 sidecar 镜像并确认可导入**

Run:
```bash
cd /home/zhangjq/projects/stock-agent && docker compose build akshare-mcp && docker compose up -d akshare-mcp
docker exec stock-agent-akshare-mcp-1 python -c "import mootdx, pytdx; from mootdx.quotes import Quotes; print('mootdx ok')"
```
Expected: 打印 `mootdx ok`（无 ImportError）。

- [ ] **Step 3: 提交**

```bash
git add sidecar/requirements.txt
git commit -m "build(sidecar): 加 mootdx 依赖(通达信协议数据源)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 前复权纯函数 `qfq_adjust`（TDD，无网络）

**Files:**
- Create: `sidecar/tdx.py`
- Create: `sidecar/tdx_test.py`

- [ ] **Step 1: 写失败测试**

创建 `sidecar/tdx_test.py`：
```python
# 纯函数测试：前复权 qfq_adjust（无网络）。运行: python sidecar/tdx_test.py
from tdx import qfq_adjust

def approx(a, b, tol=0.01):
    return abs(a - b) <= tol

def test_cash_dividend():
    # 2025-01-03 除息：每10股派 100 元（=10元/股）；除息日前收=110 → factor=(110-10)/110
    bars = [
        {"date": "2025-01-01", "open": 100, "high": 100, "low": 100, "close": 100, "volume": 1},
        {"date": "2025-01-02", "open": 110, "high": 110, "low": 110, "close": 110, "volume": 1},
        {"date": "2025-01-03", "open": 90,  "high": 90,  "low": 90,  "close": 90,  "volume": 1},
        {"date": "2025-01-04", "open": 95,  "high": 95,  "low": 95,  "close": 95,  "volume": 1},
    ]
    events = [{"date": "2025-01-03", "fenhong": 100, "songzhuangu": 0, "peigu": 0, "peigujia": 0}]
    out = {b["date"]: b["close"] for b in qfq_adjust(bars, events)}
    assert approx(out["2025-01-01"], 90.91), out["2025-01-01"]   # 100 * 100/110
    assert approx(out["2025-01-02"], 100.0), out["2025-01-02"]   # 110 * 100/110
    assert approx(out["2025-01-03"], 90.0), out["2025-01-03"]    # 除息日及之后不调
    assert approx(out["2025-01-04"], 95.0), out["2025-01-04"]

def test_split():
    # 10送10：songzhuangu=10(每10股) → 除权参考=24/(1+1)=12, factor=12/24=0.5
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /home/zhangjq/projects/stock-agent && python3 sidecar/tdx_test.py`
Expected: FAIL —`ModuleNotFoundError: No module named 'tdx'`（或 `qfq_adjust` 未定义）。

- [ ] **Step 3: 创建 `sidecar/tdx.py` 实现 `qfq_adjust`**

```python
# 通达信(mootdx)数据源：自算前复权 + 带锁单例客户端 + bars/stocks/finance/realtime。
# 注意：不使用 mootdx 内置 adjust（其 qfq 在新版 pandas 下报 fillna(method=) 错误）。


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
        if not prev_close:
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cd /home/zhangjq/projects/stock-agent && python3 sidecar/tdx_test.py`
Expected: 打印 `ALL PASS`。

- [ ] **Step 5: 提交**

```bash
git add sidecar/tdx.py sidecar/tdx_test.py
git commit -m "feat(sidecar): 前复权纯函数 qfq_adjust + 单测(现金分红/送股/无事件)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: tdx.py 网络函数（客户端 + bars/stocks/finance/realtime）

**Files:**
- Modify: `sidecar/tdx.py`

- [ ] **Step 1: 在 `qfq_adjust` 之上加入客户端与连接管理**

在 `sidecar/tdx.py` 顶部（`qfq_adjust` 定义之前）插入：
```python
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
    """串行化(pytdx 连接非线程安全) + 一次重连重试；异常返回 None。"""
    with _lock:
        for attempt in (1, 2):
            try:
                return fn(_get_client())
            except Exception:
                _reset()
                if attempt == 2:
                    return None
```

- [ ] **Step 2: 在文件末尾加入 bars/stocks/finance/realtime**

```python
def _f(x):
    try:
        return None if x is None else float(x)
    except Exception:
        return None


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
        price = _latest_raw_close(code)
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
    """全 A 股 [{code,name}]（py 由 main.py 补）。分页拉取底层证券列表。"""
    def fn(c):
        out = []
        api = c.client  # mootdx 暴露的 pytdx TdxHq_API
        for market in (0, 1):
            start = 0
            while True:
                batch = api.get_security_list(market, start)
                if not batch:
                    break
                for it in batch:
                    code = str(it.get("code", ""))
                    name = str(it.get("name", "")).strip()
                    if len(code) == 6 and _is_a_stock(market, code):
                        out.append({"code": code, "name": name})
                if len(batch) < 1000:
                    break
                start += len(batch)
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
```

> 注：`stocks()` 用 `c.client.get_security_list`（mootdx 暴露的 pytdx 底层）分页拉全量；若该属性名在所装 mootdx 版本不同，执行时用 selfcheck 验证并改用对应入口（Task 6 会校验数量 >4000）。`realtime` 字段名以实测为准（Task 6 打印核对）。

- [ ] **Step 3: 语法检查（仍无网络，确认可导入解析）**

Run: `cd /home/zhangjq/projects/stock-agent && docker exec stock-agent-akshare-mcp-1 python -c "import sys; sys.path.insert(0,'/app') if False else None" ; python3 -c "import ast; ast.parse(open('sidecar/tdx.py').read()); print('syntax ok')"`
Expected: 打印 `syntax ok`（`tdx_test.py` 仍应 `python3 sidecar/tdx_test.py` → ALL PASS，纯函数未受影响）。

- [ ] **Step 4: 提交**

```bash
git add sidecar/tdx.py
git commit -m "feat(sidecar): tdx 客户端(带锁单例+重连) + bars_qfq/finance/stocks/realtime

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 接进 PROVIDERS（quote / fundamentals 置顶）

**Files:**
- Modify: `sidecar/main.py`（顶部 import；`QUOTE_PROVIDERS` 行 ~270；`PROVIDERS` fundamentals 行 ~298）

- [ ] **Step 1: 顶部 import tdx**

在 `sidecar/main.py` 的 `import akshare as ak`（行 ~19）之后加：
```python
import tdx
```

- [ ] **Step 2: quote provider 置顶**

把 `QUOTE_PROVIDERS = [...]`（行 ~270）改为：
```python
def _quote_tdx(code, days): return tdx.bars_qfq(code, days)
QUOTE_PROVIDERS = [
    {"key": "tdx",      "label": "通达信",   "fn": _quote_tdx},
    {"key": "tx",       "label": "腾讯",     "fn": _quote_tx},
    {"key": "sina",     "label": "新浪",     "fn": _quote_sina},
    {"key": "em",       "label": "东方财富", "fn": _quote_em},
    {"key": "baostock", "label": "BaoStock", "fn": _quote_baostock},
]
```

- [ ] **Step 3: fundamentals provider 置顶**

在 `PROVIDERS` 定义（行 ~296）之前加一个 provider 函数：
```python
def _fund_tdx(code, _days=0): return tdx.finance_fundamentals(code)
```
并把 `PROVIDERS["fundamentals"]` 列表改为（tdx 置顶）：
```python
    "fundamentals": [
        {"key": "tdx",      "label": "通达信",   "fn": _fund_tdx},
        {"key": "baostock", "label": "BaoStock", "fn": _fund_baostock},
        {"key": "em",       "label": "东方财富", "fn": _fund_em},
    ],
```

- [ ] **Step 4: 重启 sidecar 并验证 quote 命中 tdx**

Run:
```bash
cd /home/zhangjq/projects/stock-agent && docker compose up -d akshare-mcp && sleep 3
docker exec stock-agent-akshare-mcp-1 sh -c 'curl -s "http://localhost:8000/quote/600519?days=6" | head -c 400; echo; curl -s "http://localhost:8000/fundamentals/600519"'
```
Expected: `/quote` 返回 `{"source":"tdx","rows":[...]}`（6 根前复权日线）；`/fundamentals` 返回 `{"source":"tdx","data":{...pe,pb,ps,roe_ttm...}}`。

- [ ] **Step 5: 提交**

```bash
git add sidecar/main.py
git commit -m "feat(sidecar): tdx 置顶为 quote/fundamentals 首选(旧源降级作底)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `/stocks` 与 `/realtime` 改 TDX 优先（保留兜底）

**Files:**
- Modify: `sidecar/main.py`（`stocks_all` 行 ~129；`realtime` 行 ~356）

- [ ] **Step 1: `/stocks` TDX 优先**

把 `stocks_all()`（行 ~129-142）改为：
```python
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
```

- [ ] **Step 2: `/realtime` TDX 优先**

把 `realtime(code)`（行 ~356）函数体改为 TDX 优先、易行情(sina)兜底。将原 `def _fn(): ... data = _timed(_fn, 8); return {...}` 整体替换为：
```python
@app.get("/realtime/{code}")
def realtime(code: str):
    code = code[-6:]
    rt = _timed(lambda: tdx.realtime(code), 6)
    if rt and rt.get("price"):
        return {"source": "tdx-rt", "data": rt}
    def _fn():
        import easyquotation
        eq = easyquotation.use("sina")
        d = eq.real([code], prefix=False) or {}
        row = d.get(code) or {}
        if not row:
            return None
        return {
            "price": _f(row.get("now")), "open": _f(row.get("open")),
            "high": _f(row.get("high")), "low": _f(row.get("low")),
            "prev_close": _f(row.get("close")),
            "volume": _f(row.get("volume") or row.get("turnover")),
            "name": row.get("name"),
            "time": (str(row.get("date", "")) + " " + str(row.get("time", ""))).strip(),
        }
    data = _timed(_fn, 8)
    return {"source": "sina-rt" if data else None, "data": data or {}}
```
> 保持与原 `/realtime` 返回结构一致（`{source, data}`）。注意原函数若用到 `_f`，本文件已定义。

- [ ] **Step 3: 重启并验证**

Run:
```bash
cd /home/zhangjq/projects/stock-agent && docker compose up -d akshare-mcp && sleep 3
docker exec stock-agent-akshare-mcp-1 sh -c 'curl -s "http://localhost:8000/stocks" | python -c "import sys,json; d=json.load(sys.stdin); print(\"stocks\", len(d), d[:2])"; curl -s "http://localhost:8000/realtime/600519"'
```
Expected: stocks 数量 >4000；`/realtime` 返回 `{"source":"tdx-rt"或"sina-rt","data":{price...}}`。

- [ ] **Step 4: 提交**

```bash
git add sidecar/main.py
git commit -m "feat(sidecar): /stocks 与 /realtime 改 TDX 优先(akshare/sina 兜底)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 实连自检脚本 + 前复权校验 + Node 回归

**Files:**
- Create: `sidecar/selfcheck_tdx.py`

- [ ] **Step 1: 写自检脚本**

创建 `sidecar/selfcheck_tdx.py`：
```python
# 实连自检（手动跑，需网络）：python sidecar/selfcheck_tdx.py
# 在 sidecar 容器内运行：docker exec stock-agent-akshare-mcp-1 python /app/selfcheck_tdx.py
import tdx

def main():
    # ① 前复权 vs akshare 新浪
    rows = tdx.bars_qfq("600519", 320)
    assert rows and len(rows) > 100, "bars_qfq 空"
    ours = {r["date"]: r["close"] for r in rows}
    import akshare as ak
    a = ak.stock_zh_a_daily(symbol="sh600519", adjust="qfq")
    a["d"] = a["date"].astype(str).str[:10]
    ref = dict(zip(a["d"], a["close"]))
    bad = 0
    for d in ["2025-02-12", "2025-06-30", "2025-12-22"]:
        if d in ours and d in ref:
            diff = abs(ours[d] - ref[d]) / ref[d] * 100
            print(f"  qfq {d}: 我们 {ours[d]:.2f} | 新浪 {ref[d]:.2f} | 偏差 {diff:.3f}%")
            if diff > 0.1:
                bad += 1
    assert bad == 0, "前复权偏差过大"
    # ② 基本面口径核对（人工看 PE/PB/PS 是否落在合理区间）
    print("  fundamentals:", tdx.finance_fundamentals("600519"))
    # ③ 股票列表数量
    lst = tdx.stocks()
    print("  stocks:", len(lst), lst[:2])
    assert len(lst) > 4000, "股票列表数量异常"
    print("SELFCHECK OK")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 容器内跑自检**

Run:
```bash
docker cp /home/zhangjq/projects/stock-agent/sidecar/selfcheck_tdx.py stock-agent-akshare-mcp-1:/app/selfcheck_tdx.py
docker exec stock-agent-akshare-mcp-1 python /app/selfcheck_tdx.py
```
Expected: 三段打印 + `SELFCHECK OK`（前复权偏差 ≤0.1%；fundamentals 的 PE/PB/PS 非空且合理：茅台 PB≈5-6、PE 几十倍；stocks>4000）。若 PE/PB/PS 口径明显离谱（差一个数量级），按打印的字段单位修正 `finance_fundamentals` 后重跑。

- [ ] **Step 3: Node 回归（确认未受影响）**

Run: `cd /home/zhangjq/projects/stock-agent/backend && npm test 2>&1 | tail -5`
Expected: 202 tests 全绿（provider 在 sidecar 侧，Node 契约未变）。

- [ ] **Step 4: 端到端冒烟（重建 app + sidecar 后，浏览器）**

Run: `cd /home/zhangjq/projects/stock-agent && docker compose up -d --build`
手动确认：数据页「行情上游探测」出现「通达信」且可达/首选；个股快照 ROE/PE/PB/PS 有值；触发 EOD「立即更新」后行情入库为前复权价、个股 ma20/ma60 正常；选股能用真实行情跑出结果。

- [ ] **Step 5: 提交**

```bash
git add sidecar/selfcheck_tdx.py
git commit -m "test(sidecar): TDX 实连自检(前复权对新浪校验 + 基本面口径 + 列表数量)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage：**
- TDX 接行情(EOD 前复权) → Task 2(qfq)+Task 3(bars_qfq)+Task 4(quote 置顶)。✓
- 实时 → Task 3(realtime)+Task 5。✓
- 股票列表 → Task 3(stocks)+Task 5。✓
- 基本面 ROE/PE/PB/PS(sidecar 算,修复长期为空) → Task 3(finance_fundamentals)+Task 4(fundamentals 置顶)。✓
- 自算前复权(不碰 buggy 内置 qfq)+ 纯函数单测 → Task 2。✓
- 旧源降级作底 → Task 4/5(tdx 置顶,旧源保留在列表尾/兜底)。✓
- 连接管理(锁/bestip 缓存/重连) → Task 3。✓
- Node 不动 + requirements 加 mootdx → Task 1 + Task 6 Step 3。✓
- 前复权对新浪校验 + 口径核对 → Task 6。✓

**Placeholder scan：** 无 TBD/TODO。库 API 不确定处（`c.client.get_security_list`、`realtime` 字段名）给了具体实现 + Task 6 硬校验兜住，非占位。

**Type/契约一致性：** `/quote`→`{source,rows}`、`/fundamentals`→`{source,data}`、`/stocks`→`[{code,name,py}]`、`/realtime`→`{source,data}` 全程与现状一致；`qfq_adjust` 在 Task 2 定义、Task 3 调用签名一致；`tdx.bars_qfq/finance_fundamentals/stocks/realtime` 在 Task 3 定义、Task 4/5 调用名一致。
