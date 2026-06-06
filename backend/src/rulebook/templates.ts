import { Baseline, SeedGate } from './baseline-v3';

const g = (o: Partial<SeedGate> & Pick<SeedGate, 'system' | 'gate_key' | 'label' | 'field' | 'op'>): SeedGate => ({
  threshold: null, threshold2: null, ref_field: null, unit: '', veto: 1, teach: '', ...o,
});

// 多头并列：5/10/20/60 均线多头排列，趋势强势股。
const MA_BULLISH: Baseline = {
  versionLabel: 'MA多头并列 v1',
  persona: '你是一位趋势交易者，只做均线多头排列、趋势向上的强势股，趋势走坏即离场，不抄底、不预测顶。',
  gates: [
    g({ system: 'A', gate_key: 'ma5_gt_ma10', label: '5日线>10日线', field: 'ma5', op: 'gt_field', ref_field: 'ma10', teach: '短期均线在上，近端动能向上' }),
    g({ system: 'A', gate_key: 'ma10_gt_ma20', label: '10日线>20日线', field: 'ma10', op: 'gt_field', ref_field: 'ma20', teach: '中短期多头' }),
    g({ system: 'A', gate_key: 'ma20_gt_ma60', label: '20日线>60日线', field: 'ma20', op: 'gt_field', ref_field: 'ma60', teach: '中期趋势向上，确认多头排列' }),
  ],
  softRules: [
    { system: 'A', text: '放量上行、缩量回踩不破均线', teach: '量价配合才是健康的多头' },
    { system: 'A', text: '不在远离均线的高位追，等回踩均线企稳', teach: '追高=把风险留给自己' },
  ],
  positionRules: {
    single_trade_risk_pct: { A: 1.0 },
    single_stock_cap_pct: { A: 20 },
    exits: { A: ['收盘跌破 20 日线离场', '跌破入场低点止损'] },
    add_position: { A: '仅顺势、突破新高加仓；禁止逆势补仓' },
    circuit_breaker: ['当月亏 5% 停 3 天复盘'],
  },
};

// 价值质量：高 ROE、合理估值、真实盈利。
const VALUE_QUALITY: Baseline = {
  versionLabel: '价值质量 v1',
  persona: '你是一位价值投资者，只买盈利能力强、估值合理、有真实利润的好公司，长期持有，不追题材。',
  gates: [
    g({ system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 15, unit: '%', teach: '高 ROE 是优质公司的硬标志' }),
    g({ system: 'A', gate_key: 'pe', label: 'PE(TTM)', field: 'pe', op: 'between', threshold: 0, threshold2: 30, unit: '倍', teach: '估值不能太贵，盈利为正' }),
    g({ system: 'A', gate_key: 'pb', label: 'PB', field: 'pb', op: '<', threshold: 3, unit: '倍', teach: '资产溢价适中' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '必须真实盈利' }),
  ],
  softRules: [
    { system: 'A', text: '经营现金流健康、与利润匹配', teach: '利润是观点，现金流是事实' },
    { system: 'A', text: '行业地位稳固、有护城河', teach: '好生意才值得长持' },
  ],
  positionRules: {
    single_trade_risk_pct: { A: 1.0 },
    single_stock_cap_pct: { A: 25 },
    exits: { A: ['基本面恶化（ROE 下台阶/现金流转负）清仓', '估值显著高估分批减'] },
    circuit_breaker: ['当月亏 5% 停 3 天复盘'],
  },
};

// shared, generic position rules for single-system templates
const POS_A = {
  single_trade_risk_pct: { A: 1.0 },
  single_stock_cap_pct: { A: 20 },
  exits: { A: ['跌破入场关键支撑或 -10% 止损（收盘确认）', '基本面/逻辑被证伪→清仓'] },
  add_position: { A: '仅盈利且趋势完好时顺势加，禁止亏损补仓' },
  circuit_breaker: ['当月亏 5%→停 3 天复盘'],
};

function tpl(versionLabel: string, persona: string, gates: SeedGate[], soft: Array<{ system: 'A' | 'B'; text: string; teach: string }>): Baseline {
  return { versionLabel, persona, gates, softRules: soft, positionRules: POS_A as Record<string, unknown> };
}

const LOW_PE_BLUECHIP = tpl(
  '低估值蓝筹 v1',
  '你只买低估值、高 ROE 的蓝筹白马，便宜买好公司，长期持有不追高。',
  [
    g({ system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 12, unit: '%', teach: 'ROE≥12% 才算优质' }),
    g({ system: 'A', gate_key: 'pe', label: 'PE(TTM)', field: 'pe', op: 'between', threshold: 0, threshold2: 15, unit: '倍', teach: '低估值，PE<15' }),
    g({ system: 'A', gate_key: 'pb', label: 'PB', field: 'pb', op: '<', threshold: 2, unit: '倍', teach: 'PB<2' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '真实盈利' }),
  ],
  [{ system: 'A', text: '现金流健康、分红稳定', teach: '蓝筹看现金流和分红' }]
);

const HIGH_GROWTH = tpl(
  '高成长 v1',
  '你买高 ROE、高成长的公司，容忍较高估值，赚业绩增长的钱，成长证伪就走。',
  [
    g({ system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 20, unit: '%', teach: '高 ROE 是高成长的标志' }),
    g({ system: 'A', gate_key: 'pe', label: 'PE(TTM)', field: 'pe', op: 'between', threshold: 0, threshold2: 60, unit: '倍', teach: '成长容忍较高 PE，但<60' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '盈利为正' }),
  ],
  [{ system: 'A', text: '营收/利润增速>20%，赛道景气', teach: '成长股的核心是增速' }]
);

const OVERSOLD = tpl(
  '超跌反弹 v1',
  '你在优质标的超跌、跌破长期均线时分批介入，赚情绪修复的钱，不抄没业绩的票。',
  [
    g({ system: 'A', gate_key: 'below_ma60', label: '价格低于60日线(超跌)', field: 'ma60', op: 'gt_field', ref_field: 'close', teach: '60 日线在价格上方=阶段超跌' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '只抄有业绩的超跌' }),
  ],
  [
    { system: 'A', text: '跌幅显著、出现缩量企稳/放量反包', teach: '超跌要等止跌信号' },
    { system: 'A', text: '基本面没变坏，只是错杀', teach: '区分错杀和真衰退' },
  ]
);

const BREAKOUT = tpl(
  '趋势突破 v1',
  '你只做放量突破平台/新高、均线向上的强势股，破位即走。',
  [
    g({ system: 'A', gate_key: 'ma20_gt_ma60', label: '20>60日线(趋势向上)', field: 'ma20', op: 'gt_field', ref_field: 'ma60', teach: '中期趋势向上' }),
    g({ system: 'A', gate_key: 'close_gt_ma20', label: '价格站上20日线', field: 'close', op: 'gt_field', ref_field: 'ma20', teach: '价格在 20 日线上方' }),
  ],
  [{ system: 'A', text: '放量突破前期平台/创阶段新高', teach: '突破要有量' }]
);

const DIVIDEND = tpl(
  '股息价值 v1',
  '你买低估值、高分红、稳定盈利的股息标的，吃股息+低波动，长期持有。',
  [
    g({ system: 'A', gate_key: 'pe', label: 'PE(TTM)', field: 'pe', op: 'between', threshold: 0, threshold2: 20, unit: '倍', teach: '估值便宜' }),
    g({ system: 'A', gate_key: 'pb', label: 'PB', field: 'pb', op: '<', threshold: 2.5, unit: '倍', teach: '资产溢价低' }),
    g({ system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 10, unit: '%', teach: '盈利稳定' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '真实盈利' }),
  ],
  [{ system: 'A', text: '股息率高（如>4%）、分红连续', teach: '股息策略看分红可持续性' }]
);

const WHITE_HORSE = tpl(
  '白马龙头 v1',
  '你只买行业龙头白马：高 ROE、有护城河、趋势向上，长线持有。',
  [
    g({ system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 15, unit: '%', teach: '龙头 ROE 高' }),
    g({ system: 'A', gate_key: 'pe', label: 'PE(TTM)', field: 'pe', op: 'between', threshold: 0, threshold2: 40, unit: '倍', teach: '估值不过分' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '真实盈利' }),
    g({ system: 'A', gate_key: 'ma20_gt_ma60', label: '20>60日线', field: 'ma20', op: 'gt_field', ref_field: 'ma60', teach: '趋势向上' }),
  ],
  [{ system: 'A', text: '行业地位稳固、护城河强、机构重仓', teach: '白马看格局和护城河' }]
);

const SMALL_GROWTH = tpl(
  '小盘成长 v1',
  '你在好赛道里找高成长小盘股，弹性大但控仓严，证伪即走。',
  [
    g({ system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 15, unit: '%', teach: '成长性好' }),
    g({ system: 'A', gate_key: 'ps', label: '市销率PS', field: 'ps', op: '<', threshold: 10, unit: '倍', teach: '营收支撑估值' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '已盈利的小盘更稳' }),
  ],
  [{ system: 'A', text: '处于高景气赛道、市值偏小弹性大', teach: '小盘成长重赛道与弹性' }]
);

const TURNAROUND = tpl(
  '困境反转 v1',
  '你买业绩拐点、由亏转盈/环比大幅改善的低估标的，赚反转的钱。',
  [
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0(已转正)', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '反转的第一信号是盈利转正' }),
    g({ system: 'A', gate_key: 'pb', label: 'PB', field: 'pb', op: '<', threshold: 2, unit: '倍', teach: '低位低估' }),
  ],
  [
    { system: 'A', text: '业绩出现拐点（环比改善/扭亏）', teach: '反转要看拐点确认' },
    { system: 'A', text: '行业景气见底回升', teach: '反转最好叠加行业回暖' },
  ]
);

const EMOTION_MOMENTUM = tpl(
  '题材情绪(短线) v1',
  '你做短线题材：只在市场情绪好、热点新鲜时打强势股，快进快出，破位即走。',
  [
    g({ system: 'B', gate_key: 'limit_up_count', label: '涨停家数', field: 'limit_up_count', op: '>', threshold: 40, unit: '家', teach: '赚钱效应足才做短线' }),
    g({ system: 'B', gate_key: 'limit_down_count', label: '跌停家数', field: 'limit_down_count', op: '<', threshold: 15, unit: '家', teach: '杀跌少' }),
    g({ system: 'B', gate_key: 'sse_ma20_not_down', label: '上证20日线不向下', field: 'sse_ma20_slope', op: '>=', threshold: 0, teach: '大盘不向下' }),
    g({ system: 'B', gate_key: 'turnover_rate', label: '换手率', field: 'turnover_rate', op: '<', threshold: 20, unit: '%', veto: 0, teach: '换手过高有出货嫌疑' }),
  ],
  [
    { system: 'B', text: '热点 1-3 天内、不追媒体铺天盖地的', teach: '题材新鲜度' },
    { system: 'B', text: '不接一字板，3 天不创新高就走', teach: '短线要快' },
  ]
);

const BALANCED = tpl(
  '稳健均衡 v1',
  '你要业绩、估值、趋势都过关的均衡标的，攻守兼备、纪律持有。',
  [
    g({ system: 'A', gate_key: 'roe_ttm', label: 'ROE(TTM)', field: 'roe_ttm', op: '>=', threshold: 10, unit: '%', teach: '盈利能力达标' }),
    g({ system: 'A', gate_key: 'pe', label: 'PE(TTM)', field: 'pe', op: 'between', threshold: 0, threshold2: 35, unit: '倍', teach: '估值合理' }),
    g({ system: 'A', gate_key: 'pb', label: 'PB', field: 'pb', op: '<', threshold: 4, unit: '倍', teach: '不过分溢价' }),
    g({ system: 'A', gate_key: 'net_profit', label: '归母净利>0', field: 'net_profit', op: '>', threshold: 0, unit: '元', teach: '真实盈利' }),
    g({ system: 'A', gate_key: 'ma20_gt_ma60', label: '20>60日线', field: 'ma20', op: 'gt_field', ref_field: 'ma60', teach: '趋势向上' }),
  ],
  [{ system: 'A', text: '机构覆盖、基本面无硬伤', teach: '均衡型求稳' }]
);

export interface TemplateMeta {
  key: string;
  label: string;
  description: string;
  baseline: Baseline;
}

export const TEMPLATES: TemplateMeta[] = [
  { key: 'value-quality', label: '价值质量', description: '高 ROE、合理估值、真实盈利的好公司，长期持有。', baseline: VALUE_QUALITY },
  { key: 'low-pe-bluechip', label: '低估值蓝筹', description: '低 PE/PB + 高 ROE 的蓝筹白马，便宜买好公司。', baseline: LOW_PE_BLUECHIP },
  { key: 'high-growth', label: '高成长', description: '高 ROE、高增速，赚业绩成长的钱，容忍较高估值。', baseline: HIGH_GROWTH },
  { key: 'white-horse', label: '白马龙头', description: '行业龙头、高 ROE、有护城河、趋势向上，长线持有。', baseline: WHITE_HORSE },
  { key: 'dividend-value', label: '股息价值', description: '低估值高分红稳定盈利，吃股息+低波动。', baseline: DIVIDEND },
  { key: 'balanced', label: '稳健均衡', description: '业绩/估值/趋势都过关的均衡标的，攻守兼备。', baseline: BALANCED },
  { key: 'ma-bullish', label: '均线多头并列', description: '5/10/20/60 均线多头排列的趋势强势股，趋势走坏离场。', baseline: MA_BULLISH },
  { key: 'breakout', label: '趋势突破', description: '放量突破平台/新高、均线向上的强势股，破位即走。', baseline: BREAKOUT },
  { key: 'oversold-rebound', label: '超跌反弹', description: '优质标的超跌、跌破长期均线时分批介入，赚修复。', baseline: OVERSOLD },
  { key: 'turnaround', label: '困境反转', description: '业绩拐点、由亏转盈/环比改善的低估标的。', baseline: TURNAROUND },
  { key: 'small-growth', label: '小盘成长', description: '好赛道里的高成长小盘股，弹性大、控仓严。', baseline: SMALL_GROWTH },
  { key: 'emotion-momentum', label: '题材情绪（短线）', description: '市场情绪好、热点新鲜时做强势股，快进快出。', baseline: EMOTION_MOMENTUM },
];

export function getTemplate(key: string): TemplateMeta | undefined {
  return TEMPLATES.find((t) => t.key === key);
}
