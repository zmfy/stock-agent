import { GateOp } from '../types';

// A gate as authored in the baseline (no id/version_id yet — assigned on instantiate).
export interface SeedGate {
  system: string;
  gate_key: string;
  label: string;
  field: string;
  op: GateOp;
  threshold: number | null;
  threshold2: number | null;
  ref_field: string | null;
  unit: string;
  veto: number;
  teach: string;
}

export interface SeedSoftRule {
  system: string;
  text: string;
  teach: string;
}

export interface Baseline {
  versionLabel: string;
  persona: string;
  gates: SeedGate[];
  softRules: SeedSoftRule[];
  positionRules: Record<string, unknown>;
}

// The user's《操盘实操清单 V3.0 双系统分家版》encoded as a structured rulebook baseline.
export const BASELINE_V3: Baseline = {
  versionLabel: 'V3.0',
  persona:
    '你是一位经验丰富的 A 股操盘手，深谙中线业绩股（A 系统）与短线题材股（B 系统）。' +
    '你严格执行 A/B 双系统规则、绝不混用：A 让利润奔跑，B 让亏损止步。' +
    '你只判断今天有没有资格、用哪套规则去做，不预测涨跌。',
  gates: [
    // ---- A 系统：入场硬性排除 ----
    { system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 10, threshold2: null, ref_field: null, unit: '%', veto: 1, teach: 'ROE<10% 说明用自有资本赚钱能力不足，中线买的是真实盈利能力（9.x% 一律不算）' },
    { system: 'A', gate_key: 'pe', label: '市盈率PE(TTM)', field: 'pe', op: 'between', threshold: 0, threshold2: 60, ref_field: null, unit: '倍', veto: 1, teach: 'PE 为正排除亏损股；>60 倍估值过高，中线买公司不是买故事' },
    { system: 'A', gate_key: 'pb', label: '市净率PB', field: 'pb', op: '<', threshold: 5, threshold2: null, ref_field: null, unit: '倍', veto: 1, teach: 'PB 过高资产溢价大；重资产行业应更低（<1.5）' },
    { system: 'A', gate_key: 'ps', label: '市销率PS', field: 'ps', op: '<', threshold: 8, threshold2: null, ref_field: null, unit: '倍', veto: 1, teach: '市销率过高说明营收撑不起市值' },
    { system: 'A', gate_key: 'net_profit', label: '真实利润(归母净利>0)', field: 'net_profit', op: '>', threshold: 0, threshold2: null, ref_field: null, unit: '元', veto: 1, teach: '必须是真实盈利、业绩驱动，不是讲故事' },
    { system: 'A', gate_key: 'ma_trend', label: '趋势向上(20>60日线)', field: 'ma20', op: 'gt_field', threshold: null, threshold2: null, ref_field: 'ma60', unit: '', veto: 1, teach: '20 日线在 60 日线上方=中期趋势向上；且不在年内高点追高' },
    // ---- B 系统：情绪闸门（三条全满足才开 B）----
    { system: 'B', gate_key: 'limit_up_count', label: '涨停家数', field: 'limit_up_count', op: '>', threshold: 50, threshold2: null, ref_field: null, unit: '家', veto: 1, teach: '情绪闸门：涨停<50 家说明赚钱效应不足，B 系统空仓' },
    { system: 'B', gate_key: 'limit_down_count', label: '跌停家数', field: 'limit_down_count', op: '<', threshold: 10, threshold2: null, ref_field: null, unit: '家', veto: 1, teach: '跌停≥10 家说明杀跌情绪重，不开 B' },
    { system: 'B', gate_key: 'sse_ma20_not_down', label: '上证20日线不向下', field: 'sse_ma20_slope', op: '>=', threshold: 0, threshold2: null, ref_field: null, unit: '', veto: 1, teach: '大盘趋势向下时再好的题材也不碰' },
    // ---- B 系统：入场质量（非一票否决）----
    { system: 'B', gate_key: 'turnover_rate', label: '换手率', field: 'turnover_rate', op: '<', threshold: 15, threshold2: null, ref_field: null, unit: '%', veto: 0, teach: '换手>15% 有出货嫌疑，排除出货型涨停' },
  ],
  softRules: [
    // ---- A 系统 ----
    { system: 'A', text: '有机构覆盖且业绩驱动（有清晰买入评级/目标价），不是纯题材故事', teach: '机构覆盖弱、护城河差的票，中线不碰' },
    { system: 'A', text: '不在年内高点附近追高（接近 52 周高点需警惕）', teach: '高位追高=把别人的退出当成自己的入场' },
    { system: 'A', text: '经营现金流为正/健康（现金流恶化是减分项）', teach: '利润是观点，现金流是事实' },
    // ---- B 系统 ----
    { system: 'B', text: '热点在政策/事件发酵 1–3 天内，不追媒体已铺天盖地的', teach: '题材新鲜度过期=接最后一棒' },
    { system: 'B', text: '涨停质量：涨停后不破实体下沿', teach: '破实体下沿说明承接不住' },
    { system: 'B', text: 'MACD 金叉初期 / 红柱连续放大', teach: '金叉已过最佳买点就别追' },
    { system: 'B', text: '不接纯粹一字板（买不进也跑不掉）', teach: '一字板没有换手，风险不可控' },
  ],
  positionRules: {
    single_trade_risk_pct: { A: 1.0, B: 0.5 },
    single_stock_cap_pct: { A: 20, B: 10 },
    system_total_cap_pct: { B: 30 },
    position_formula: '买入股数 =（账户总额 × 单笔风险%）÷（买入价 − 止损价）',
    market_gate_A: [
      { sse_ma20: 'up', can_open: 'yes', total_cap_pct: 60 },
      { sse_ma20: 'flat', can_open: 'selective', total_cap_pct: 40 },
      { sse_ma20: 'down', can_open: 'no', total_cap_pct: null },
    ],
    exits: {
      A: ['初始止损：跌破入场关键支撑或 -12%，收盘确认', '移动止盈：收盘有效跌破 20 日线才走', '基本面证伪→无条件清仓'],
      B: ['时间止损：3 天内不创新高/板块熄火→走', '跌破 10 日线或 -6%→清仓', '板块连续 2 天无涨停→清仓', '大盘单日跌>2% 且放量→B 全清'],
    },
    add_position: {
      A: '仅盈利+突破新平台时加仓，加后单票≤20%；禁止向亏损头寸补仓',
      B: '禁止补仓',
    },
    circuit_breaker: ['当月亏 5%→停止交易 3 天逐笔复盘', '当月亏 8%→总仓强制降到 10% 以下'],
    a_share_notes: ['T+1：当天买入次日才能卖，止损最早次日生效', '一字跌停止损失效→单票硬顶才是真正风险上限'],
  },
};
