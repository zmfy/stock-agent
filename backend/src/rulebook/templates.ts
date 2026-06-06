import { Baseline, BASELINE_V3, SeedGate } from './baseline-v3';

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

export interface TemplateMeta {
  key: string;
  label: string;
  description: string;
  baseline: Baseline;
}

export const TEMPLATES: TemplateMeta[] = [
  { key: 'v3-dual-system', label: 'A/B 双系统（中线+短线）', description: '中线业绩仓 + 短线题材仓，两套规则永不混用（用户默认模板）。', baseline: BASELINE_V3 },
  { key: 'ma-bullish', label: '均线多头并列', description: '5/10/20/60 均线多头排列的趋势强势股，趋势走坏离场。', baseline: MA_BULLISH },
  { key: 'value-quality', label: '价值质量', description: '高 ROE、合理估值、真实盈利的好公司，长期持有。', baseline: VALUE_QUALITY },
];

export function getTemplate(key: string): TemplateMeta | undefined {
  return TEMPLATES.find((t) => t.key === key);
}
