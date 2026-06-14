"""直连抓取 eastmoney 新闻 + 涨停/跌停（绕开出站代理）。

实测：东方财富新闻 host（np-weblist.eastmoney.com）与涨停/跌停接口直连 0.3s 可达，
但经 gost socks5 代理会超时/掐断；而行情 push2his 直连被住宅线 RST、必须走代理。
socks5 代理是进程级全局 socket 补丁，无法按请求绕开，故这些源由 main.py 在
「代理生效时」用独立子进程（新解释器=无补丁=直连）调用本文件；代理关闭时直接进程内调用。

本文件不得 import proxy / 不做任何 socket 补丁，保证 import 即直连。
"""
import sys
import json

NEWS_FNS = [("em", "stock_info_global_em"), ("cjzc", "stock_info_cjzc_em")]  # 财联社 cls 接口已 404，移除


def fetch_news(limit=20):
    import akshare as ak
    for key, name in NEWS_FNS:
        f = getattr(ak, name, None)
        if not f:
            continue
        try:
            df = f()
        except Exception:
            continue
        if df is None or not len(df):
            continue
        rows = []
        for _, r in df.head(limit or 20).iterrows():
            title = r.get("标题") or r.get("内容") or r.get("summary")
            ts = r.get("发布时间") or r.get("时间") or r.get("datetime") or r.get("publish_time") or ""
            summary = r.get("摘要") or r.get("内容") or ""
            if title:
                rows.append({"title": str(title), "summary": str(summary)[:200], "content": str(summary), "published_at": str(ts)})
        if rows:
            return {"source": key, "rows": rows}
    return {"source": None, "rows": []}


def fetch_sentiment():
    import akshare as ak
    from datetime import datetime
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
    # 三项全空视为彻底失败 → None（让 probe/路由按不可达处理）
    if out["limit_up_count"] is None and out["limit_down_count"] is None and out["sse_ma20_slope"] is None:
        return None
    return out


if __name__ == "__main__":
    kind = sys.argv[1] if len(sys.argv) > 1 else "news"
    arg = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    if kind == "news":
        print(json.dumps(fetch_news(arg), ensure_ascii=False))
    elif kind == "sentiment":
        print(json.dumps(fetch_sentiment(), ensure_ascii=False))
    else:
        print(json.dumps(None, ensure_ascii=False))
