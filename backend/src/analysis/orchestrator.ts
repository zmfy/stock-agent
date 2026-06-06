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
  snapshot: StockSnapshot
): string {
  const softA = softRules.filter((s) => s.system === 'A').map((s) => `- ${s.text}`).join('\n');
  const softB = softRules.filter((s) => s.system === 'B').map((s) => `- ${s.text}`).join('\n');
  return `${persona}

下面是对股票 ${snapshot.code}${snapshot.name ? '（' + snapshot.name + '）' : ''} 的硬门槛逐条计算结果（这些数字已由系统精确算出，你【不得】自己重算或质疑数值，只基于它们判断）：

${gateTableText(gateResults)}

A 系统软判断（结合上面结果与你的经验判断，数据缺失处如实说明）：
${softA || '（无）'}

B 系统软判断：
${softB || '（无）'}

仓位/出场/熔断规则参考：
${JSON.stringify(positionRules, null, 0)}

请像一位严格的操盘手那样，给出该股票在 A 系统（中线业绩）和 B 系统（短线题材）下的结论。
${'若硬门槛有一票否决项失败，对应系统应判为不适用。'}
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
  const raw = await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 2000);
  return { raw, provider: cfg.provider, model: cfg.model };
}

export interface RunOptions {
  // Inject for tests; default routes to the user's 'analysis' model.
  aiCall?: (prompt: string) => Promise<{ raw: string; provider: string; model: string }>;
}

export async function runAnalysis(userId: string, code: string, opts: RunOptions = {}): Promise<any> {
  const rb = getActive(userId);
  if (!rb) throw new Error('NO_RULEBOOK');

  const snapshot = await getStockSnapshot(userId, code);

  // Data-validation gate: the main agent only analyzes data it can trust.
  const validation = validateStock(userId, snapshot);
  if (!validation.trusted) {
    const err = new Error('DATA_UNTRUSTED');
    (err as any).validation = validation;
    throw err;
  }

  const ev = evaluateGates(snapshot, rb.gates);
  // Main-agent persona now lives in agent_profiles (decoupled from the rulebook); fall back to the version persona.
  const persona = getCorePersona(userId) || rb.version.persona;
  const prompt = buildAnalysisPrompt(persona, ev.gateResults, rb.softRules, rb.positionRules, snapshot);

  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));
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
