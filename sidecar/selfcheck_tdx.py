# 实连自检（手动跑，需网络）：
#   docker cp sidecar/selfcheck_tdx.py stock-agent-akshare-mcp-1:/app/selfcheck_tdx.py
#   docker exec -w /app stock-agent-akshare-mcp-1 python selfcheck_tdx.py
import tdx


def main():
    # ① 前复权 vs akshare 新浪 qfq（应 ≤0.1%）
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
    # ② 基本面（人工看 PE/PB/PS/ROE 是否合理：茅台 PE~19 PB~5.9 PS~9 ROE~32）
    f = tdx.finance_fundamentals("600519")
    print("  fundamentals:", f)
    assert f and f.get("pe") and f.get("pb") and f.get("roe_ttm"), "基本面缺字段"
    # ③ 股票列表数量
    lst = tdx.stocks()
    print("  stocks:", len(lst), lst[:2])
    assert len(lst) > 4000, "股票列表数量异常"
    print("SELFCHECK OK")


if __name__ == "__main__":
    main()
