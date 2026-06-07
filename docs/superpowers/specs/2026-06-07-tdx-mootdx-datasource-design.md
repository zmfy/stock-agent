# TDX/mootdx 作为首选数据源（行情 + 实时 + 股票列表 + 基本面）

日期：2026-06-07

## Context（背景）

系统长期最大痛点是数据源：用户联通线路 RST 掉东方财富(push2his)/腾讯/baostock 的 HTTP 金融 CDN，导致 EOD 0 成功、基本面/股票列表也不稳。2026-06-07 已 spike 验证（在 sidecar 容器内、用户真实线路）：

- mootdx（通达信 TCP 协议，端口 7709）能拉到茅台真实日线，**绕开被 RST 的 HTTP CDN**；bestip 自动选最快服务器。
- mootdx **自带 qfq 已坏**（`fillna(method=)` 与新版 pandas 不兼容报错）——**不能用其内置复权**。
- **自算前复权**（TDX 原始价 + `xdxr()`）与 akshare 新浪 qfq **逐日吻合，偏差 ≤0.005%**（跨 2025-06/2025-12 两次大额分红验证）。
- `finance()` 字段齐全（总股本/净资产/主营收入/净利润/每股净资产…），够算 ROE/PE/PB/PS。
- akshare 新浪 qfq 也在用户线路通，可做交叉校验/兜底。

详见记忆 `stock-agent-datasource-tdx.md`。

## 现状契约（实现须对齐）

- sidecar（FastAPI + `import akshare as ak`，`_timed(fn, sec)` 包装防卡）有 `PROVIDERS = {quote:[...], fundamentals:[...]}` 注册表 + `_order_providers(kind, order)`，端点 `/quote/{code}`→`{source, rows:[{date,open,high,low,close,volume}]}`、`/fundamentals/{code}`→`{source, data:{...}}`（多源合并）、`/stocks`→`[{code,name,py}]`、`/realtime/{code}`→`{source, data:{price,open,high,low,prev_close,volume,name,time}}`、`/probe`、`/probe/list`。有 `_py_initials(name)` 拼音首字母工具。
- Node `getStockSnapshot` 直接把基本面 provider 返回的 `pe/pb/ps/roe_ttm/net_profit` 拷进快照（**Node 不算 PE/PB/PS**）。当前 `_ak_fund/_bs_fund` 只给 `roe_ttm/net_profit/turnover_rate` → **PE/PB/PS 实际为空，A 系统估值门槛形同虚设**。本设计修复这一点。
- A/B 门槛字段：`roe_ttm`、`pe`、`pb`、`ps`（`rulebook/templates.ts`）+ 价格类 `ma20/ma60`（由 EOD 前复权价算）。

## Goals

- TDX/mootdx 成为 **行情(EOD 日线，前复权)、实时快照、全 A 股列表、基本面(ROE/PE/PB/PS)** 的**首选源**；旧 HTTP 源降级保留作底（探测如实反映可达）。
- 前复权由我们自算（不碰 mootdx buggy 内置 qfq），算法固化 + 纯函数单测。
- EOD 入库存**前复权价**（指标直接用）；实时快照用当前原始价。
- 修复 PE/PB/PS 长期为空的问题（在 sidecar TDX 基本面 provider 算好）。

## Non-goals

- 不改 Node 的快照组装/门槛评估逻辑（provider 输出对齐现有契约即可）。
- 新闻不走 TDX（TDX 无新闻），继续新浪。
- 不做分钟级/Level-2/盘口深度（YAGNI）。
- 不追求严格 TTM 口径（用最近一期财报，spec 标注，实现时抽样校验）。

## 设计

### A. sidecar TDX 模块 `sidecar/tdx.py`

**连接管理（pytdx 连接非线程安全；FastAPI 同步端点跑线程池）**：
```python
import threading
from mootdx.quotes import Quotes

_lock = threading.Lock()
_client = None

def _get_client():
    global _client
    if _client is None:
        _client = Quotes.factory(market='std')  # 内部 bestip 选最快服务器并缓存于实例
    return _client

def _reset():
    global _client
    _client = None

def _call(fn):
    """串行化 + 一次重连重试。fn(client)->result；异常返回 None。"""
    with _lock:
        for attempt in (1, 2):
            try:
                return fn(_get_client())
            except Exception:
                _reset()
                if attempt == 2:
                    return None
```
> bestip 首次选服务器 ~7s，之后复用同一 `Quotes` 实例不再重选。失败 `_reset()` 下次重连（会重新 bestip）。

**前复权（纯函数，可单测，无网络）** `qfq_adjust(bars, xdxr_events)`：
- 输入：`bars`=按日期升序的原始日线 `[{date,open,high,low,close,volume}]`；`xdxr_events`=除权除息事件 `[{date,'fenhong','songzhuangu','peigu','peigujia'}]`（`fenhong/songzhuangu/peigu` 为每 10 股口径）。
- 对每个事件取**除权日前一交易日**的原始收盘 `prev_close`：
  `除权参考价 = (prev_close + (peigu/10)*peigujia - fenhong/10) / (1 + songzhuangu/10 + peigu/10)`
  `factor_event = 除权参考价 / prev_close`
- 某交易日 `d` 的复权因子 = 该日**之后**所有事件 `factor_event` 连乘；`open/high/low/close ×= 因子`（volume 不改）。
- 边界：事件日早于 bars 最早日或找不到 prev_close → 该事件跳过（不影响窗口内）。无事件 → 原样返回。

**对外函数**（均经 `_call` 包裹）：
- `bars_qfq(code, days)` → 拉 `client.bars(symbol=code, frequency=9, offset=days)` 原始 + `client.xdxr(symbol=code)`（筛 `category==1` 现金/送转/配事件）→ `qfq_adjust` → 返回 `[{date,open,high,low,close,volume}]`（date 取 `datetime[:10]`，升序）。
- `stocks()` → `client.stocks(market=0)`+`stocks(market=1)`（深/沪）→ `[{code,name,py}]`（py 用 main 里的 `_py_initials`，或在 tdx.py 内复用）。过滤非股票（指数/退市可后续细化）。
- `finance_raw(code)` → `client.finance(symbol=code)` → dict（原始字段）。
- `realtime(code)` → `client.quotes(symbol=code)` → `{price,open,high,low,prev_close,volume,name,time}`（字段名对齐现有 `/realtime` data 形）。

### B. 接入 `sidecar/main.py`

**quote provider（置顶）**：
```python
from tdx import bars_qfq, stocks as tdx_stocks, finance_raw, realtime as tdx_realtime
def _quote_tdx(code, days): return bars_qfq(code, days)
QUOTE_PROVIDERS = [
    {"key": "tdx",      "label": "通达信",   "fn": _quote_tdx},   # 首选
    {"key": "sina",     "label": "新浪",     "fn": _quote_sina},  # 兜底
    {"key": "tx",       "label": "腾讯",     "fn": _quote_tx},
    {"key": "em",       "label": "东方财富", "fn": _quote_em},
    {"key": "baostock", "label": "BaoStock", "fn": _quote_baostock},
]
```

**fundamentals provider（置顶，算好 PE/PB/PS/ROE）** `_fund_tdx(code, _days)`：
```python
def _fund_tdx(code, _days=0):
    f = finance_raw(code)
    if not f: return None
    price = _latest_close(code)            # 复用 bars_qfq 最后一根原始收盘 或 realtime price
    shares = f.get('zongguben')            # 总股本(股)
    eq     = f.get('jingzichan')           # 净资产
    rev    = f.get('zhuyingshouru')        # 主营收入
    profit = f.get('jinglirun')            # 净利润(最近一期)
    bvps   = f.get('meigujingzichan')      # 每股净资产
    out = {}
    if profit and eq:    out['roe_ttm'] = round(profit/eq*100, 2)
    if price and bvps:   out['pb'] = round(price/bvps, 2)
    if price and shares and profit: out['pe'] = round(price*shares/profit, 2)
    if price and shares and rev:    out['ps'] = round(price*shares/rev, 2)
    out['net_profit'] = profit
    return out
# 注册：fundamentals = [tdx 置顶, em, baostock]
```
> 口径：用最近一期财报净利润/净资产（非严格 TTM）；单位以 spike 实测字段为准（实现时打印核对，并对 2-3 只股票与新浪/akshare 比 PE/PB/PS 落在合理区间）。`_latest_close` 取原始价（PE/PB/PS 用当前市价）。

**`/stocks`**：先 `tdx_stocks()`，空则回退现有 `ak.stock_info_a_code_name()`。
**`/realtime/{code}`**：先 `tdx_realtime(code)`（source `"tdx-rt"`），空则回退现有 easyquotation 新浪（source `"sina-rt"`）。

### C. Node 侧

基本不动（契约一致）。可选微调：`data/sidecar.ts` 的 `orderedProviders`/默认 order 让 `tdx` 默认靠前（sidecar PROVIDERS 已置顶，probe 择优会自动优先 reachable 的 tdx，故非必须）。数据页探测条会自动多出「通达信」一行（前端无需改）。`sidecar/requirements.txt` 增加 `mootdx`。

### D. 错误处理 / 降级

- TDX 不可达：`_call` 重连一次仍失败 → provider 返回 None → `_order_providers` 落到下一个（新浪等）→ `{source}` 如实标注实际命中源（数据页可见）。
- xdxr 拉不到：`bars_qfq` 退回原始价（标注，避免无数据）；或交由下一 provider。
- `finance` 缺字段：对应比率不输出（null），门槛遇 null 按现有逻辑（数据缺失）处理。

## Testing

- **前复权纯函数单测**（`sidecar` 侧，无网络）：用今天 spike 验证过的茅台 fixture（原始收盘 + 两次现金分红 2025-06-26 / 2025-12-19）喂 `qfq_adjust`，断言若干日复权值与新浪参考 **偏差 ≤0.01%**。Python `pytest`/`unittest`（sidecar 若无测试框架则用一个 `python -m` 自检脚本，CI/手动均可跑）。
- **sidecar 实连自检脚本**（`sidecar/selfcheck_tdx.py`，手动跑）：实连拉茅台 → 自算 qfq 对 akshare 新浪 qfq 抽样校验；打印 `_fund_tdx` 的 PE/PB/PS 供人工核对口径。
- **Node 回归**：现有 202 测试不受影响（provider 在 sidecar 侧）；跑 `npm test` 确认绿。
- **端到端冒烟**（重建容器后）：数据页探测 → 「通达信」可达且首选；个股快照 ROE/PE/PB/PS 有值且合理；EOD 入库为前复权价、ma20/ma60 正常；选股/早会能用真实行情跑通。

## 默认决定（已确认）

- 接入范围：行情(EOD) + 实时 + 股票列表 + 基本面 全换 TDX 首选。
- EOD 存前复权价；实时快照原始价。
- 旧 HTTP 源（东财/腾讯/baostock）降级保留作底。
- PE/PB/PS 在 sidecar TDX 基本面 provider 算（用当前价 + finance 字段）；Node 不动。
- ROE/PE 用最近一期财报口径（非严格 TTM），实现时抽样校验。
