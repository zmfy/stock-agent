import { GateResult, SoftRule, StockSnapshot } from '../types';
import { evaluateGates } from './rule-engine';
import { getStockSnapshot } from '../data/service';
import { getActive } from '../rulebook/service';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { saveReport, getReport } from './report-service';
import { getCorePersona } from '../agent/profiles-service';
import { validateStock } from '../validation/service';
import { skillDirectives } from '../plugins/service';

export interface ParsedAnalysis {
  a_conclusion: string;
  b_conclusion: string;
  exception_channel: string | null;
  position_suggestion: string;
  one_liner: string;
  teach_notes: Array<{ gate_key: string; note: string }>;
}

const STATUS_CN: Record<string, string> = { pass: '✅通过', fail: '❌失败', unknown: '⚠️数据缺失' };

function gateTableText(results: GateResult[]): string {
  return results
    .map((r) => {
      const cond =
        r.op === 'gt_field'
          ? `${r.field} > ${r.ref_field}`
          : r.op === 'between'
          ? `${r.threshold} < 值 < ${r.threshold2}`
          : `${r.op} ${r.threshold}`;
      return `[${r.system}] ${r.label}（${r.field}）: 要求 ${cond}${r.unit} | 实测 ${r.actual ?? '无'} | ${STATUS_CN[r.status]}${r.veto ? '｜一票否决' : '｜质量项'}`;
    })
    .join('\n');
}

export function buildAnalysisPrompt(
  persona: string,
  gateResults: GateResult[],
  softRules: SoftRule[],
  positionRules: Record<string, unknown>,
  snapshot: StockSnapshot,
  directives?: string
): string {
  const softA = softRules.filter((s) => s.system === 'A').map((s) => `- ${s.text}`).join('\n');
  const softB = softRules.filter((s) => s.system === 'B').map((s) => `- ${s.text}`).join('\n');
  return `${persona}
${directives ? `\n${directives}\n` : ''}

下面是对股票 ${snapshot.code}${snapshot.name ? '（' + snapshot.name + '）' : ''} 的硬门槛逐条计算结果（这些数字已由系统精确算出，你【不得】自己重算或质疑数值，只基于它们判断）：

${gateTableText(gateResults)}

A 系统软判断（结合上面结果与你的经验判断，数据缺失处如实说明）：
${softA || '（无）'}

B 系统软判断：
${softB || '（无）'}

仓位/出场/熔断规则参考：
${JSON.stringify(positionRules, null, 0)}

请像一位严格的操盘手那样，对上面出现的【每一个系统】（可能是 A/B/C…，单系统则只有 A）分别判断。
a_conclusion 写优先级最高系统的结论，b_conclusion 写次一个系统的结论（只有一套就把综合结论写进 a_conclusion、b_conclusion 留空）。
若硬门槛有一票否决项失败，对应系统应判为不适用。
只输出如下 JSON，不要任何额外文字：
{
  "a_conclusion": "A系统结论与理由（是否进入、为什么）",
  "b_conclusion": "B系统结论与理由（含情绪闸门是否开启）",
  "exception_channel": "是否走例外通道；若走，覆写了哪条门槛、理由；否则填 null",
  "position_suggestion": "仓位建议（按规则与公式，给方向性建议）",
  "one_liner": "一句话结论",
  "teach_notes": [{"gate_key":"roe_ttm","note":"这条为什么重要的一句话教学"}]
}`;
}

export function parseAnalysisResponse(text: string): ParsedAnalysis {
  const empty: ParsedAnalysis = {
    a_conclusion: '',
    b_conclusion: '',
    exception_channel: null,
    position_suggestion: '',
    one_liner: '',
    teach_notes: [],
  };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { ...empty, one_liner: text.trim().slice(0, 200) };
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      a_conclusion: String(obj.a_conclusion ?? ''),
      b_conclusion: String(obj.b_conclusion ?? ''),
      exception_channel: obj.exception_channel ? String(obj.exception_channel) : null,
      position_suggestion: String(obj.position_suggestion ?? ''),
      one_liner: String(obj.one_liner ?? ''),
      teach_notes: Array.isArray(obj.teach_notes) ? obj.teach_notes : [],
    };
  } catch {
    return { ...empty, one_liner: text.trim().slice(0, 200) };
  }
}

async function defaultAiCall(userId: string, prompt: string): Promise<{ raw: string; provider: string; model: string }> {
  const cfg = getModelForRole(userId, 'analysis');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
  const raw = await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 2000, acct);
  return { raw, provider: cfg.provider, model: cfg.model };
}

export interface RunOptions {
  // Inject for tests; default routes to the user's 'analysis' model.
  aiCall?: (prompt: string) => Promise<{ raw: string; provider: string; model: string }>;
}

// 无当前策略时的通用分析 prompt：基本面 + 当前走势 + 可能走势，明确声明不构成买卖结论。
export function buildGeneralAnalysisPrompt(persona: string, snapshot: StockSnapshot, directives?: string): string {
  const v = (x: number | null | undefined, suffix = '') => (x === null || x === undefined ? '—' : `${x}${suffix}`);
  return `${persona || '你是一位资深 A 股操盘手。'}
${directives ? `\n${directives}\n` : ''}
用户【尚未设定当前策略】。请基于下面这只股票的基本面与当前走势做一份通用分析，并在结论开头明确声明「未设当前策略，以下为通用分析，不构成买卖结论」。

股票 ${snapshot.code}${snapshot.name ? '（' + snapshot.name + '）' : ''} 当前数据（系统已精确算出，请勿质疑或重算）：
PE(TTM): ${v(snapshot.pe)}　PB: ${v(snapshot.pb)}　PS: ${v(snapshot.ps)}　ROE(TTM): ${v(snapshot.roe_ttm, '%')}　归母净利: ${v(snapshot.net_profit)}
现价: ${v(snapshot.close)}　MA20: ${v(snapshot.ma20)}　MA60: ${v(snapshot.ma60)}　年内最高: ${v(snapshot.year_high)}

请分析：① 基本面好坏（盈利能力/估值）；② 当前走势（相对均线与年内高点的位置、强弱）；③ 基于一般股市常识，后续可能的走势与需要注意的风险。
只输出如下 JSON，不要任何额外文字：
{
  "one_liner":"一句话通用结论（以「未设当前策略，仅供参考」开头）",
  "a_conclusion":"基本面与当前/可能走势的综合分析",
  "b_conclusion":"",
  "exception_channel":null,
  "position_suggestion":"通用提示：未设当前策略，建议先和来财聊出一套原则再做买卖决策",
  "teach_notes":[]
}`;
}

export async function runAnalysis(userId: string, code: string, opts: RunOptions = {}): Promise<any> {
  const rb = getActive(userId);

  const snapshot = await getStockSnapshot(userId, code);

  // Data-validation gate: the main agent only analyzes data it can trust.
  const validation = await validateStock(userId, snapshot);
  if (!validation.trusted) {
    const err = new Error('DATA_UNTRUSTED');
    (err as any).validation = validation;
    throw err;
  }

  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));

  // 无当前策略：走通用分析（不评门槛、不给买卖结论、rulebook_version_id=null）
  if (!rb) {
    const persona = getCorePersona(userId) || '';
    const prompt = buildGeneralAnalysisPrompt(persona, snapshot, skillDirectives(userId));
    const { raw, provider, model } = await aiCall(prompt);
    const parsed = parseAnalysisResponse(raw);
    const id = saveReport({
      userId,
      stockCode: code,
      stockName: snapshot.name,
      rulebookVersionId: null,
      dataDate: snapshot.date,
      aiProvider: provider,
      aiModel: model,
      snapshot,
      gateResults: [],
      softFindings: [],
      aConclusion: parsed.a_conclusion,
      bConclusion: parsed.b_conclusion,
      exceptionChannel: parsed.exception_channel,
      positionSuggestion: parsed.position_suggestion,
      oneLiner: parsed.one_liner,
      teachNotes: parsed.teach_notes,
      rawAiResponse: raw,
      sources: snapshot.sources,
      validation,
    });
    return getReport(userId, id);
  }

  const ev = evaluateGates(snapshot, rb.gates);
  // Main-agent persona now lives in agent_profiles (decoupled from the rulebook); fall back to the version persona.
  const persona = getCorePersona(userId) || rb.version.persona;
  const prompt = buildAnalysisPrompt(persona, ev.gateResults, rb.softRules, rb.positionRules, snapshot, skillDirectives(userId));

  const { raw, provider, model } = await aiCall(prompt);
  const parsed = parseAnalysisResponse(raw);

  const id = saveReport({
    userId,
    stockCode: code,
    stockName: snapshot.name,
    rulebookVersionId: rb.version.id,
    dataDate: snapshot.date,
    aiProvider: provider,
    aiModel: model,
    snapshot,
    gateResults: ev.gateResults,
    softFindings: [],
    aConclusion: parsed.a_conclusion,
    bConclusion: parsed.b_conclusion,
    exceptionChannel: parsed.exception_channel,
    positionSuggestion: parsed.position_suggestion,
    oneLiner: parsed.one_liner,
    teachNotes: parsed.teach_notes,
    rawAiResponse: raw,
    sources: snapshot.sources,
    validation,
  });

  return getReport(userId, id);
}
