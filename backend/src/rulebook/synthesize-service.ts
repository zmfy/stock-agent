import { ProposalPayload, defaultAiCall } from './propose-service';
import { SeedGate, SeedSoftRule } from './baseline-v3';
import { getMessages } from '../chat/service';
import { extractJsonObject } from './json-extract';

// 合成与门槛只能用这些真实存在的数据字段(源自 StockSnapshot/模板)
export const SYNTH_FIELDS = [
  'roe_ttm', 'pe', 'pb', 'ps', 'net_profit', 'turnover_rate',
  'ma5', 'ma10', 'ma20', 'ma60', 'close', 'year_high',
  'limit_up_count', 'limit_down_count', 'sse_ma20_slope',
];
const VALID_OPS = ['>=', '>', '<=', '<', 'between', 'gt_field'];

function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

export function buildSynthesizePrompt(conversation: string): string {
  return `你是当前策略合成助手。下面是你（来财）和用户关于他平时怎么选股、怎么买卖的访谈对话：
${conversation}

请据用户的【真实表述】，从零合成一整套可执行的当前策略。没聊到的维度可留空或给保守默认，【不要】编造用户没说过的偏好。

硬门槛的 field 只能用下面这些真实存在的数据字段（用别的字段会被丢弃）：
roe_ttm(ROE%), pe(市盈率), pb(市净率), ps(市销率), net_profit(归母净利,元), turnover_rate(换手率%), ma5/ma10/ma20/ma60(均线), close(现价), year_high(年内最高), limit_up_count(涨停家数), limit_down_count(跌停家数), sse_ma20_slope(上证20日线斜率)
算子只能用：>= > <= < between gt_field（gt_field 用 ref_field 指定参照字段，如 close gt_field ma20 表示现价站上20日线）
系统：可用 A/B/C… 任意单字母标签区分不同打法。给出仓位风险配置(positionRules.single_trade_risk_pct)的系统=真实交易系统；纯复盘/零仓位（只做认知训练、不下单）的系统不要在 single_trade_risk_pct 里配置，它只评估门槛不参与选股与仓位。

只输出一个 JSON，结构如下，不要解释或思考过程：
{
 "versionLabel":"我的原则 v1",
 "persona":"一句话操盘人设",
 "gates":[{"system":"A","gate_key":"唯一key","label":"名称","field":"白名单字段","op":">=","threshold":数值或null,"threshold2":null,"ref_field":null,"unit":"","veto":1,"teach":"一句话"}],
 "softRules":[{"system":"A","text":"软判断","teach":"教学"}],
 "positionRules":{"single_trade_risk_pct":{"A":1.0},"single_stock_cap_pct":{"A":20},"exits":{"A":["跌破入场支撑或-10%止损"]},"circuit_breaker":["当月亏5%停3天复盘"]}
}`;
}

export function parseSynth(text: string): any | null {
  return extractJsonObject(text);
}

export function validateSynth(obj: any): { versionLabel: string; proposal: ProposalPayload } {
  const gates: SeedGate[] = [];
  for (const a of obj?.gates || []) {
    if (!a || !a.gate_key || !SYNTH_FIELDS.includes(a.field) || !VALID_OPS.includes(a.op)) continue;
    gates.push({
      system: /^[A-Z]$/.test(String(a.system)) ? String(a.system) : 'A',
      gate_key: String(a.gate_key),
      label: String(a.label ?? a.gate_key),
      field: String(a.field),
      op: a.op,
      threshold: num(a.threshold),
      threshold2: num(a.threshold2),
      ref_field: a.ref_field ? String(a.ref_field) : null,
      unit: String(a.unit ?? ''),
      veto: a.veto ? 1 : 0,
      teach: String(a.teach ?? ''),
    });
  }
  if (gates.length === 0) throw new Error('SYNTH_EMPTY');

  const softRules: SeedSoftRule[] = [];
  for (const r of obj?.softRules || []) {
    if (r?.text) softRules.push({ system: /^[A-Z]$/.test(String(r.system)) ? String(r.system) : 'A', text: String(r.text), teach: String(r.teach ?? '') });
  }

  const positionRules = obj?.positionRules && typeof obj.positionRules === 'object' ? obj.positionRules : {};

  let versionLabel = obj?.versionLabel ? String(obj.versionLabel).slice(0, 40) : '';
  if (!versionLabel.trim()) versionLabel = '我的原则 v1';

  const persona = obj?.persona
    ? String(obj.persona)
    : '你是一位有纪律的 A 股操盘手，严格执行自己的当前策略，不情绪化、不预测涨跌。';

  return { versionLabel, proposal: { persona, note: '从访谈合成当前策略', gates, softRules, positionRules } };
}

export async function synthesizeRulebook(
  userId: string,
  sessionId: string,
  opts: { aiCall?: (p: string) => Promise<string> } = {}
): Promise<{ proposal: ProposalPayload; suggestedLabel: string }> {
  const msgs = getMessages(userId, sessionId);
  const conversation = msgs.map((m: any) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
  // 多系统/大策略的 JSON 较长，叠加推理模型的 <think> 思考块，需要更大的输出预算，否则会被截断成不完整 JSON。
  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p, 16000));
  const raw = await aiCall(buildSynthesizePrompt(conversation));
  const obj = parseSynth(raw);
  if (!obj) throw new Error('PARSE_FAILED');
  const { versionLabel, proposal } = validateSynth(obj);
  return { proposal, suggestedLabel: versionLabel };
}
