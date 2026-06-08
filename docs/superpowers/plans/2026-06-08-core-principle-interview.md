# 核心原则访谈合成 + 无原则降级模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能通过和「来财」的引导式访谈从零合成一整套核心原则;并让没有核心原则的用户也能用系统(选股禁用、个股通用分析、早晚会只看大盘板块)。

**Architecture:** 后端新增 `synthesize-service`(从访谈对话合成整套 rulebook,字段白名单约束),复用现有 `POST /rulebook/apply` 创建首版;`chat/service` 的 `core_principle` 框架按「有无 rulebook」分叉为「访谈/修改」;`analysis` 与 `meetings` 在无 rulebook 时走降级分支。前端 `HomeView` 会话区中央放醒目引导卡,访谈模式下提供「生成核心原则」按钮 + 完整预览。

**Tech Stack:** 后端 TypeScript + Express + better-sqlite3 + Jest;前端 Vue 3 + TypeScript(vue-tsc 类型检查)。

**测试命令:** 后端 `cd backend && npm test`(当前 204 绿);前端 `cd frontend && npx vue-tsc --noEmit`。

---

## File Structure

**后端**
- `backend/src/rulebook/synthesize-service.ts`(新建)— 访谈→整套 rulebook 的纯逻辑 + 编排。
- `backend/src/rulebook/synthesize-service.test.ts`(新建)— 纯逻辑单测。
- `backend/src/rulebook/propose-service.ts`(改)— 导出 `defaultAiCall` 供复用。
- `backend/src/routes/rulebook.ts`(改)— 加 `POST /synthesize`。
- `backend/src/chat/service.ts`(改)— `core_principle` 访谈/修改框架分叉。
- `backend/src/chat/service.test.ts`(改)— 访谈/修改框架测试。
- `backend/src/analysis/orchestrator.ts`(改)— 无 rulebook 通用分析兜底 + `buildGeneralAnalysisPrompt`。
- `backend/src/analysis/orchestrator.test.ts`(改)— 降级分支测试。
- `backend/src/meetings/service.ts`(改)— 4 个 prompt builder 加 `hasRulebook` + 调用处传值。
- `backend/src/meetings/service.test.ts`(新建或改)— builder 文案测试。

**前端**
- `frontend/src/api/rulebook.ts`(改)— `synthesize` + 类型。
- `frontend/src/views/OnboardingView.vue`(改)— `__interview__` 选项。
- `frontend/src/views/HomeView.vue`(改)— 引导卡 / 访谈自动开启 / 访谈入口 / 合成按钮 / 完整预览 / 选股守卫。

---

## Task 1: 后端 — synthesize-service(访谈→整套 rulebook)

**Files:**
- Modify: `backend/src/rulebook/propose-service.ts:173`(导出 `defaultAiCall`)
- Create: `backend/src/rulebook/synthesize-service.ts`
- Test: `backend/src/rulebook/synthesize-service.test.ts`

- [ ] **Step 1: 导出 propose-service 的 defaultAiCall**

`backend/src/rulebook/propose-service.ts` 第 173 行,把

```ts
async function defaultAiCall(userId: string, prompt: string): Promise<string> {
```

改为

```ts
export async function defaultAiCall(userId: string, prompt: string): Promise<string> {
```

- [ ] **Step 2: 写失败测试 `synthesize-service.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-synth-'));

const syn = require('./synthesize-service');
const rb = require('./service');
const chat = require('../chat/service');

const USER = 'u-synth';

function makeSession(): string {
  const sid = chat.createSession(USER, 'core_principle', null, '核心原则探讨');
  return sid;
}

describe('validateSynth', () => {
  it('keeps whitelist fields/ops, drops illegal ones, normalizes veto', () => {
    const { versionLabel, proposal } = syn.validateSynth({
      versionLabel: '我的原则 v1',
      persona: '价值党',
      gates: [
        { system: 'A', gate_key: 'roe', label: 'ROE', field: 'roe_ttm', op: '>=', threshold: '12', unit: '%', veto: 1, teach: 't' },
        { system: 'A', gate_key: 'bad', label: 'x', field: 'made_up_field', op: '>=', threshold: 1 },
        { system: 'A', gate_key: 'badop', label: 'y', field: 'pe', op: '!!', threshold: 1 },
        { system: 'B', gate_key: 'lu', label: '涨停', field: 'limit_up_count', op: '>', threshold: 40, veto: 0 },
      ],
      softRules: [{ system: 'A', text: '看现金流', teach: 'x' }, { text: '' }],
      positionRules: { single_stock_cap_pct: { A: 20 } },
    });
    expect(versionLabel).toBe('我的原则 v1');
    expect(proposal.gates.map((g: any) => g.gate_key)).toEqual(['roe', 'lu']);
    expect(proposal.gates[0].threshold).toBe(12); // numeric coercion
    expect(proposal.gates[0].veto).toBe(1);
    expect(proposal.softRules).toHaveLength(1);
    expect(proposal.persona).toBe('价值党');
  });

  it('defaults versionLabel when missing', () => {
    const { versionLabel } = syn.validateSynth({
      gates: [{ system: 'A', gate_key: 'pe', label: 'PE', field: 'pe', op: '<', threshold: 30 }],
    });
    expect(versionLabel).toBe('我的原则 v1');
  });

  it('throws SYNTH_EMPTY when no legal gate survives', () => {
    expect(() => syn.validateSynth({ gates: [{ field: 'nope', op: '>=', gate_key: 'a' }] })).toThrow('SYNTH_EMPTY');
  });
});

describe('parseSynth', () => {
  it('extracts JSON from surrounding noise', () => {
    expect(syn.parseSynth('思考...{"versionLabel":"x","gates":[]}尾巴')).toEqual({ versionLabel: 'x', gates: [] });
  });
  it('returns null on garbage', () => {
    expect(syn.parseSynth('no json here')).toBeNull();
  });
});

describe('buildSynthesizePrompt', () => {
  it('includes the field whitelist and JSON-only instruction', () => {
    const p = syn.buildSynthesizePrompt('用户：我只买低估值高ROE的票');
    expect(p).toContain('roe_ttm');
    expect(p).toContain('limit_up_count');
    expect(p).toContain('用户：我只买低估值高ROE的票');
    expect(p).toContain('只输出一个 JSON');
  });
});

describe('synthesizeRulebook', () => {
  it('reads session conversation, calls AI, returns proposal + suggestedLabel', async () => {
    const sid = makeSession();
    chat.postMessage(USER, sid, '我只买 ROE 高于 15、PE 低于 30 的好公司', {
      aiCall: async () => ({ raw: '好的', provider: 'p', model: 'm' }),
    });
    const out = await syn.synthesizeRulebook(USER, sid, {
      aiCall: async () =>
        JSON.stringify({
          versionLabel: '价值 v1',
          persona: '价值党',
          gates: [{ system: 'A', gate_key: 'roe', label: 'ROE', field: 'roe_ttm', op: '>=', threshold: 15, veto: 1, teach: 't' }],
          softRules: [],
          positionRules: {},
        }),
    });
    expect(out.suggestedLabel).toBe('价值 v1');
    expect(out.proposal.gates).toHaveLength(1);
    expect(out.proposal.note).toBe('从访谈合成核心原则');
  });

  it('throws PARSE_FAILED on non-JSON AI output', async () => {
    const sid = makeSession();
    await expect(syn.synthesizeRulebook(USER, sid, { aiCall: async () => '我想想' })).rejects.toThrow('PARSE_FAILED');
  });
});
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `cd backend && npx jest synthesize-service -i`
Expected: FAIL — `Cannot find module './synthesize-service'`。

- [ ] **Step 4: 实现 `synthesize-service.ts`**

```ts
import { ProposalPayload, defaultAiCall } from './propose-service';
import { SeedGate, SeedSoftRule } from './baseline-v3';
import { getMessages } from '../chat/service';

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
  return `你是核心原则合成助手。下面是你（来财）和用户关于他平时怎么选股、怎么买卖的访谈对话：
${conversation}

请据用户的【真实表述】，从零合成一整套可执行的核心原则。没聊到的维度可留空或给保守默认，【不要】编造用户没说过的偏好。

硬门槛的 field 只能用下面这些真实存在的数据字段（用别的字段会被丢弃）：
roe_ttm(ROE%), pe(市盈率), pb(市净率), ps(市销率), net_profit(归母净利,元), turnover_rate(换手率%), ma5/ma10/ma20/ma60(均线), close(现价), year_high(年内最高), limit_up_count(涨停家数), limit_down_count(跌停家数), sse_ma20_slope(上证20日线斜率)
算子只能用：>= > <= < between gt_field（gt_field 用 ref_field 指定参照字段，如 close gt_field ma20 表示现价站上20日线）
系统：A=个股基本面/趋势，B=大盘情绪。

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
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

export function validateSynth(obj: any): { versionLabel: string; proposal: ProposalPayload } {
  const gates: SeedGate[] = [];
  for (const a of obj?.gates || []) {
    if (!a || !a.gate_key || !SYNTH_FIELDS.includes(a.field) || !VALID_OPS.includes(a.op)) continue;
    gates.push({
      system: a.system === 'B' ? 'B' : 'A',
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
    if (r?.text) softRules.push({ system: r.system === 'B' ? 'B' : 'A', text: String(r.text), teach: String(r.teach ?? '') });
  }

  const positionRules = obj?.positionRules && typeof obj.positionRules === 'object' ? obj.positionRules : {};

  let versionLabel = obj?.versionLabel ? String(obj.versionLabel).slice(0, 40) : '';
  if (!versionLabel.trim()) versionLabel = '我的原则 v1';

  const persona = obj?.persona
    ? String(obj.persona)
    : '你是一位有纪律的 A 股操盘手，严格执行自己的核心原则，不情绪化、不预测涨跌。';

  return { versionLabel, proposal: { persona, note: '从访谈合成核心原则', gates, softRules, positionRules } };
}

export async function synthesizeRulebook(
  userId: string,
  sessionId: string,
  opts: { aiCall?: (p: string) => Promise<string> } = {}
): Promise<{ proposal: ProposalPayload; suggestedLabel: string }> {
  const msgs = getMessages(userId, sessionId);
  const conversation = msgs.map((m: any) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));
  const raw = await aiCall(buildSynthesizePrompt(conversation));
  const obj = parseSynth(raw);
  if (!obj) throw new Error('PARSE_FAILED');
  const { versionLabel, proposal } = validateSynth(obj);
  return { proposal, suggestedLabel: versionLabel };
}
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `cd backend && npx jest synthesize-service -i`
Expected: PASS（全部用例绿）。

- [ ] **Step 6: 提交**

```bash
git add backend/src/rulebook/synthesize-service.ts backend/src/rulebook/synthesize-service.test.ts backend/src/rulebook/propose-service.ts
git commit -m "feat(rulebook): 从访谈对话合成整套核心原则(白名单约束)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端 — `POST /api/rulebook/synthesize` 路由

**Files:**
- Modify: `backend/src/routes/rulebook.ts`(在 `/propose` 路由后新增)

- [ ] **Step 1: 加 import**

`backend/src/routes/rulebook.ts` 顶部,把

```ts
import { proposeChange, applyProposal } from '../rulebook/propose-service';
```

改为

```ts
import { proposeChange, applyProposal } from '../rulebook/propose-service';
import { synthesizeRulebook } from '../rulebook/synthesize-service';
```

- [ ] **Step 2: 新增路由(放在 `/propose` 路由块之后、`applySchema` 之前)**

```ts
// POST /api/rulebook/synthesize { sessionId } — 从访谈对话从零合成整套核心原则(NOT saved)
router.post('/synthesize', async (req: Request, res: Response) => {
  const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '缺少会话');
  try {
    const { proposal, suggestedLabel } = await synthesizeRulebook(req.user!.userId, parsed.data.sessionId);
    successResponse(res, { proposal, suggestedLabel, fromScratch: true });
  } catch (e: any) {
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    if (e.message === 'SYNTH_EMPTY') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '还没聊到足够信息，请再多说说你平时怎么选股、怎么买卖');
    if (e.message === 'PARSE_FAILED') return errorResponse(res, 502, 'UPSTREAM_ERROR', '生成解析失败，请再试一次');
    if (e.message === 'NOT_FOUND') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '会话不存在');
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `生成失败：${e.message || '未知错误'}`);
  }
});
```

- [ ] **Step 3: 编译检查(确保无类型/语法错误)**

Run: `cd backend && npx tsc --noEmit`
Expected: 无错误输出（exit 0）。

- [ ] **Step 4: 回归测试**

Run: `cd backend && npm test`
Expected: 全绿（数量 ≥ 之前 + Task 1 新增）。

- [ ] **Step 5: 提交**

```bash
git add backend/src/routes/rulebook.ts
git commit -m "feat(rulebook): 加 POST /synthesize 路由

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端 — chat `core_principle` 访谈/修改框架分叉

**Files:**
- Modify: `backend/src/chat/service.ts:105-116`(`buildPrompt`)、`:168-206`(`postMessage`)
- Test: `backend/src/chat/service.test.ts`

- [ ] **Step 1: 写失败测试(追加到 `service.test.ts` 末尾的合适位置)**

> 说明:测试通过 `postMessage` 的注入 `aiCall` 捕获最终 prompt 文本来断言框架。无 rulebook 的新用户走访谈框架;有 rulebook 走修改框架。

```ts
describe('core_principle framing branches on rulebook presence', () => {
  it('no rulebook => interview framing in prompt', async () => {
    const U = 'u-cp-interview';
    const sid = chat.createSession(U, 'core_principle', null, '核心原则探讨');
    let captured = '';
    await chat.postMessage(U, sid, '我想定个原则', {
      aiCall: async (p: string) => {
        captured = p;
        return { raw: '好的，我们开始', provider: 'p', model: 'm' };
      },
    });
    expect(captured).toContain('引导式');
    expect(captured).toContain('一次只问');
    expect(captured).not.toContain('探讨核心原则的修改');
  });

  it('has rulebook => modify framing in prompt', async () => {
    const U = 'u-cp-modify';
    rb.instantiateBaseline(U);
    const sid = chat.createSession(U, 'core_principle', null, '核心原则探讨');
    let captured = '';
    await chat.postMessage(U, sid, '把 ROE 放宽', {
      aiCall: async (p: string) => {
        captured = p;
        return { raw: '建议如下', provider: 'p', model: 'm' };
      },
    });
    expect(captured).toContain('探讨核心原则的修改');
  });
});
```

> 若 `service.test.ts` 顶部尚未 `require('../rulebook/service')` 为 `rb`,在文件已有 require 区补一行 `const rb = require('../rulebook/service');`(参照 propose-service.test.ts 写法)。`chat` 应已在该测试文件 require。

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd backend && npx jest chat/service -i -t "framing branches"`
Expected: FAIL — 捕获的 prompt 不含「引导式」(当前 core_principle 框架是修改语)。

- [ ] **Step 3: 实现框架分叉**

在 `backend/src/chat/service.ts` `KIND_FRAMING` 常量之后,新增访谈框架常量:

```ts
const CORE_PRINCIPLE_INTERVIEW_FRAMING =
  '用户还没有核心原则。你要用【引导式半结构化】提问，一次只问 1–2 个问题，循序渐进地了解：' +
  '① 看基本面还是技术面（或都看）；② 偏好什么股（蓝筹/成长/题材/低估…）；③ 持股周期；' +
  '④ 买入信号；⑤ 卖出/止损习惯；⑥ 单票仓位、能接受的回撤。' +
  '聊到信息足够时，提示用户点下方「生成核心原则」按钮。不要替用户编造他没说过的偏好。';
```

把 `buildPrompt` 签名从

```ts
function buildPrompt(persona: string, kind: ChatKind, history: ChatMessage[], extraContext?: string, directives?: string): string {
  const convo = history.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
  return `你的名字叫「${AGENT_NAME}」，是用户的操盘主助手；当用户称呼「${AGENT_NAME}」时就是在叫你。
${persona}
${directives ? `\n${directives}\n` : ''}
当前场景：${KIND_FRAMING[kind]}${extraContext ? `\n背景资料：\n${extraContext}` : ''}
```

改为(用传入的 `framing` 替代 `KIND_FRAMING[kind]`):

```ts
function buildPrompt(persona: string, framing: string, history: ChatMessage[], extraContext?: string, directives?: string): string {
  const convo = history.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n');
  return `你的名字叫「${AGENT_NAME}」，是用户的操盘主助手；当用户称呼「${AGENT_NAME}」时就是在叫你。
${persona}
${directives ? `\n${directives}\n` : ''}
当前场景：${framing}${extraContext ? `\n背景资料：\n${extraContext}` : ''}
```

（`buildPrompt` 函数体其余不变。）

在 `postMessage` 里,把最后构造 prompt 的那一行

```ts
  const prompt = buildPrompt(persona, session.kind, history, extra, skillDirectives(userId));
```

改为:

```ts
  let framing = KIND_FRAMING[session.kind as ChatKind];
  if (session.kind === 'core_principle' && !getActive(userId)) framing = CORE_PRINCIPLE_INTERVIEW_FRAMING;
  const prompt = buildPrompt(persona, framing, history, extra, skillDirectives(userId));
```

> 注:`postMessage` 中 `core_principle` 的 extraContext 分支(注入当前 rulebook)在无 rulebook 时 `getActive` 返回 null,本就不会注入,无需改动。

- [ ] **Step 4: 运行测试,确认通过**

Run: `cd backend && npx jest chat/service -i`
Expected: PASS（含新两条 + 原有 chat 测试）。

- [ ] **Step 5: 提交**

```bash
git add backend/src/chat/service.ts backend/src/chat/service.test.ts
git commit -m "feat(chat): core_principle 无原则时切引导式访谈框架

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 后端 — 个股分析无原则时走通用分析兜底

**Files:**
- Modify: `backend/src/analysis/orchestrator.ts:120-166`(`runAnalysis`)、新增 `buildGeneralAnalysisPrompt`
- Test: `backend/src/analysis/orchestrator.test.ts`

- [ ] **Step 1: 写失败测试(追加到 `orchestrator.test.ts`)**

> 参照该文件现有用例的 setup(DATA_DIR、注入 aiCall、必要时塞 snapshot 数据)。下面用例的关键断言:无 rulebook 时不抛 `NO_RULEBOOK`,返回的报告 `rulebook_version_id` 为 null、`gate_results` 为空。
> 如该文件已有「构造可信 snapshot」的辅助(让 `validateStock` 通过),复用它;否则参照现有通过用例的数据准备方式。

```ts
describe('runAnalysis degraded (no rulebook)', () => {
  it('produces a general report without gates and with null rulebook_version_id', async () => {
    const U = 'u-gen-analysis';
    // 复用本文件现有「准备可信 snapshot」的方式为 U/CODE 落数据，使 validateStock 通过。
    // （见同文件已通过用例的数据准备；此处沿用相同 helper/插入逻辑。）
    const CODE = '600000';
    await seedTrustedSnapshot(U, CODE); // ← 用本文件已有的等价数据准备替换

    const report = await orch.runAnalysis(U, CODE, {
      aiCall: async () => ({
        raw: JSON.stringify({
          one_liner: '未设核心原则的通用分析',
          a_conclusion: '基本面尚可，趋势中性',
          b_conclusion: '',
          exception_channel: null,
          position_suggestion: '先定原则再决策',
          teach_notes: [],
        }),
        provider: 'p',
        model: 'm',
      }),
    });

    expect(report).toBeTruthy();
    expect(report.rulebook_version_id ?? null).toBeNull();
    const gates = typeof report.gate_results === 'string' ? JSON.parse(report.gate_results) : report.gate_results;
    expect(gates).toEqual([]);
    expect(report.one_liner).toContain('通用');
  });
});
```

> `orch` = `require('./orchestrator')`(若文件用 import 风格的 jest,沿用其现有导入方式)。`seedTrustedSnapshot` 是占位名:用本测试文件中已存在的、能让 `validateStock` 判 `trusted` 的同款数据准备代码替换它(不要新发明数据源)。

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd backend && npx jest analysis/orchestrator -i -t "degraded"`
Expected: FAIL — 抛 `NO_RULEBOOK`(当前 runAnalysis 在无 rulebook 时直接抛)。

- [ ] **Step 3: 新增 `buildGeneralAnalysisPrompt`**

在 `backend/src/analysis/orchestrator.ts` 的 `buildAnalysisPrompt` 函数之后新增:

```ts
// 无核心原则时的通用分析 prompt：基本面 + 当前走势 + 可能走势，明确声明不构成买卖结论。
export function buildGeneralAnalysisPrompt(persona: string, snapshot: StockSnapshot, directives?: string): string {
  const v = (x: number | null | undefined, suffix = '') => (x === null || x === undefined ? '—' : `${x}${suffix}`);
  return `${persona || '你是一位资深 A 股操盘手。'}
${directives ? `\n${directives}\n` : ''}
用户【尚未设定核心原则】。请基于下面这只股票的基本面与当前走势做一份通用分析，并在结论开头明确声明「未设核心原则，以下为通用分析，不构成买卖结论」。

股票 ${snapshot.code}${snapshot.name ? '（' + snapshot.name + '）' : ''} 当前数据（系统已精确算出，请勿质疑或重算）：
PE(TTM): ${v(snapshot.pe)}　PB: ${v(snapshot.pb)}　PS: ${v(snapshot.ps)}　ROE(TTM): ${v(snapshot.roe_ttm, '%')}　归母净利: ${v(snapshot.net_profit)}
现价: ${v(snapshot.close)}　MA20: ${v(snapshot.ma20)}　MA60: ${v(snapshot.ma60)}　年内最高: ${v(snapshot.year_high)}

请分析：① 基本面好坏（盈利能力/估值）；② 当前走势（相对均线与年内高点的位置、强弱）；③ 基于一般股市常识，后续可能的走势与需要注意的风险。
只输出如下 JSON，不要任何额外文字：
{
  "one_liner":"一句话通用结论（以「未设核心原则，仅供参考」开头）",
  "a_conclusion":"基本面与当前/可能走势的综合分析",
  "b_conclusion":"",
  "exception_channel":null,
  "position_suggestion":"通用提示：未设核心原则，建议先和来财聊出一套原则再做买卖决策",
  "teach_notes":[]
}`;
}
```

- [ ] **Step 4: 改 `runAnalysis` 加无-rulebook 分支**

把 `runAnalysis`(第 120-166 行)开头的

```ts
export async function runAnalysis(userId: string, code: string, opts: RunOptions = {}): Promise<any> {
  const rb = getActive(userId);
  if (!rb) throw new Error('NO_RULEBOOK');

  const snapshot = await getStockSnapshot(userId, code);

  // Data-validation gate: the main agent only analyzes data it can trust.
  const validation = await validateStock(userId, snapshot);
  if (!validation.trusted) {
    const err = new Error('DATA_UNTRUSTED');
    (err as any).validation = validation;
    throw err;
  }

  const ev = evaluateGates(snapshot, rb.gates);
  // Main-agent persona now lives in agent_profiles (decoupled from the rulebook); fall back to the version persona.
  const persona = getCorePersona(userId) || rb.version.persona;
  const prompt = buildAnalysisPrompt(persona, ev.gateResults, rb.softRules, rb.positionRules, snapshot, skillDirectives(userId));

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
```

改为(取数+校验提前,无 rulebook 走通用分支):

```ts
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

  // 无核心原则：走通用分析（不评门槛、不给买卖结论、rulebook_version_id=null）
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
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `cd backend && npx jest analysis/orchestrator -i`
Expected: PASS（含降级用例 + 原有用例,原有「无 rulebook 抛 NO_RULEBOOK」的用例若存在需相应更新为降级断言——查找并修正)。

> 若 `orchestrator.test.ts` 原本有断言「无 rulebook → 抛 NO_RULEBOOK」的用例,它现在语义变了:改成断言「返回通用报告」。一并改掉。

- [ ] **Step 6: 提交**

```bash
git add backend/src/analysis/orchestrator.ts backend/src/analysis/orchestrator.test.ts
git commit -m "feat(analysis): 无核心原则时走通用分析兜底，不再硬失败

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 后端 — 早晚会无原则时只看大盘板块、不点个股

**Files:**
- Modify: `backend/src/meetings/service.ts`(`buildMorningAnalysisPrompt`、`buildMorningSynthPrompt`、`buildEveningReviewPrompt`、`buildEveningSynthPrompt` 加 `hasRulebook`;`generateMorning`/`generateEvening` 调用处传值)
- Test: `backend/src/meetings/service.test.ts`(新建,若不存在)

- [ ] **Step 1: 写失败测试 `meetings/service.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-meet-'));

const m = require('./service');

describe('meeting prompts honor hasRulebook', () => {
  it('morning analysis: no rulebook => no A/B gate language, forbids picking stocks', () => {
    const p = m.buildMorningAnalysisPrompt('persona', '大盘数据', '（用户尚未设定核心原则）', '数据整理', false);
    expect(p).toContain('只研判大盘');
    expect(p).toContain('不要推荐或点名任何个股');
    expect(p).not.toContain('A / B 系统今日是否开闸');
  });

  it('morning analysis: has rulebook => keeps gate language', () => {
    const p = m.buildMorningAnalysisPrompt('persona', '大盘数据', '硬门槛：A:ROE', '数据整理', true);
    expect(p).toContain('A / B 系统今日是否开闸');
  });

  it('morning synth: no rulebook => forbids individual stocks', () => {
    const p = m.buildMorningSynthPrompt('persona', '大盘', '（用户尚未设定核心原则）', 'd', 'a', 'q', false);
    expect(p).toContain('不要推荐或点名任何个股');
  });

  it('evening synth: no rulebook => forbids individual stocks', () => {
    const p = m.buildEveningSynthPrompt('persona', '大盘', null, 'd', 'a', 'r', false);
    expect(p).toContain('不要推荐或点名任何个股');
  });

  it('evening review: no rulebook => no rule-tuning-by-gate language', () => {
    const p = m.buildEveningReviewPrompt('persona', '（用户尚未设定核心原则）', 'analysis', [], false);
    expect(p).toContain('只复盘大盘与板块');
  });
});
```

> 测试按「现签名 + 末尾追加 `hasRulebook`」调用各 builder。`buildMorningSynthPrompt` 现签名 `(persona, market, rulebook, dataOut, analysisOut, qualOut, directives?)` → 新签名把 `hasRulebook` 插在 `qualOut` 之后、`directives?` 之前。`buildEveningSynthPrompt` 同理。`buildEveningReviewPrompt` 现签名 `(persona, rulebook, analysisOut, ops)` → 末尾加 `hasRulebook`。`buildMorningAnalysisPrompt` 现签名 `(persona, market, rulebook, dataOut)` → 末尾加 `hasRulebook`。

- [ ] **Step 2: 运行测试,确认失败**

Run: `cd backend && npx jest meetings/service -i`
Expected: FAIL（builder 尚未接受/区分 hasRulebook,无「只研判大盘」文案）。

- [ ] **Step 3: 改 4 个 builder**

`buildMorningAnalysisPrompt`:

```ts
export function buildMorningAnalysisPrompt(persona: string, market: string, rulebook: string, dataOut: string, hasRulebook: boolean): string {
  const task = hasRulebook
    ? '请据此判断：今日能否开新仓？A / B 系统今日是否开闸？给出理由（对照硬门槛/情绪闸门）。中文、分点、简短。'
    : '用户尚未设定核心原则。本次【只研判大盘形势与热门/强势板块】，不要判断 A/B 系统开闸、不要推荐或点名任何个股。中文、分点、简短。';
  return `${persona || '你是分析师，严格按核心原则把数据转成可执行研判。'}

你是早会上的【分析师】。数据员刚才的整理：
${dataOut}
${market}
${rulebook}
${task}`;
}
```

`buildMorningSynthPrompt`(在 `qualOut` 后加 `hasRulebook`,在 false 时改任务措辞):

```ts
export function buildMorningSynthPrompt(
  persona: string,
  market: string,
  rulebook: string,
  dataOut: string,
  analysisOut: string,
  qualOut: string,
  hasRulebook: boolean,
  directives?: string
): string {
  const body = hasRulebook
    ? `请你综合三位的汇报，给出今日的最终研判：
1）大盘研判（情绪冷热、能否开新仓、A/B 系统今日是否开闸）
2）今日操作思路（偏防守还是进攻、重点关注什么）
3）**今日可能走强的板块**：即使今天不操作，也要明确列出 2-4 个你判断今日可能走强的板块（板块名 + 一句理由），作为复盘对照。最后用一行「今日可能走强板块：A、B、C」收尾。
并务必说明：你主要采纳了哪位子助手的哪条结论作为依据（点名「数据员/分析师/情绪面」）。`
    : `用户【尚未设定核心原则】。请你综合三位的汇报，本次【只研判大盘与板块，不要判断 A/B 系统开闸、不要推荐或点名任何个股】：
1）大盘研判（情绪冷热、整体环境）
2）今日大盘操作环境（偏防守还是进攻）
3）**今日可能走强的板块**：明确列出 2-4 个你判断今日可能走强的板块（板块名 + 一句理由）。最后用一行「今日可能走强板块：A、B、C」收尾。
并务必说明：你主要采纳了哪位子助手的哪条结论作为依据（点名「数据员/分析师/情绪面」）。`;
  return `${persona}
${directives ? `\n${directives}\n` : ''}
你是主 agent「来财」，正在主持盘前【早会】。三位子助手已分别汇报：
〖数据员〗${dataOut}
〖分析师〗${analysisOut}
〖情绪面〗${qualOut}
${market}
${rulebook}

${body}
要求：简洁、可执行、不预测点位。中文、分点输出。

若你引用了上面某几条新闻作为研判依据，请在回答最后另起一行输出：__ADOPT__ 逗号分隔的编号（如 __ADOPT__ N1,N3）；没有引用就不要输出该行。`;
}
```

`buildEveningReviewPrompt`(现在文件里 line ~187，签名 `(persona, rulebook, analysisOut, ops)`，末尾加 `hasRulebook`)。读取现有实现后,把「按核心原则给规则优化建议」类任务在 false 时替换为只复盘大盘/板块:

```ts
export function buildEveningReviewPrompt(
  persona: string,
  rulebook: string,
  analysisOut: string,
  ops: Array<{ stock_code: string; one_liner: string }>,
  hasRulebook: boolean
): string {
  const opsText = ops.length ? ops.map((o) => `· ${o.stock_code}：${o.one_liner}`).join('\n') : '（今日无个股研判记录）';
  const task = hasRulebook
    ? '请复盘今日：研判对错、经验教训，并对照核心原则给出可执行的规则优化建议。中文、分点、简短。'
    : '用户尚未设定核心原则。请【只复盘大盘与板块】（早盘对板块的预测是否兑现、情绪冷热变化），不要复盘或点名个股操作、不给基于门槛的规则建议。中文、分点、简短。';
  return `${persona || '你负责复盘总结与规则优化建议。'}

你是晚会上的【复盘员】。分析师的对错判断：
${analysisOut}
${rulebook}
今日个股研判记录：
${opsText}
${task}`;
}
```

> 实现前先 Read `buildEveningReviewPrompt` 现有正文,保持其变量拼接结构（如它实际怎么用 `ops`），只在「任务句」处按 `hasRulebook` 分叉、签名末尾加 `hasRulebook`。上面是目标形态;若现正文与此不同,以「保留其数据拼接 + 替换任务句 + 加参数」为准。

`buildEveningSynthPrompt`(现签名 `(persona, market, morning, dataOut, analysisOut, reviewOut, directives?)`,在 `reviewOut` 后加 `hasRulebook`)。先 Read 其正文,在 false 时把综合结论任务改为「只复盘大盘与板块、不复盘/点名个股」:

```ts
// 目标形态（保留原有汇报拼接与 __ADOPT__ 行，仅按 hasRulebook 分叉任务句、加参数）：
export function buildEveningSynthPrompt(
  persona: string,
  market: string,
  morning: string | null,
  dataOut: string,
  analysisOut: string,
  reviewOut: string,
  hasRulebook: boolean,
  directives?: string
): string {
  const task = hasRulebook
    ? '请综合给出今日复盘结论：大盘与情绪复盘、今日预测对错、明日需关注的方向与（如有）规则优化点。'
    : '用户【尚未设定核心原则】。请【只复盘大盘与板块】（板块预测兑现情况、情绪变化、明日大盘关注方向），不要复盘或点名任何个股操作、不给基于门槛的规则建议。';
  return `${persona}
${directives ? `\n${directives}\n` : ''}
你是主 agent「来财」，正在主持盘后【晚会】复盘。子助手已汇报：
〖数据员〗${dataOut}
〖分析师〗${analysisOut}
〖复盘员〗${reviewOut}
${morning ? `今日早会研判：\n${morning}\n` : ''}${market}

${task}
要求：简洁、可执行、不预测点位。中文、分点输出。

若你引用了上面某几条新闻作为复盘依据，请在回答最后另起一行输出：__ADOPT__ 逗号分隔的编号；没有引用就不要输出该行。`;
}
```

> 同样:先 Read 现有 `buildEveningSynthPrompt` 正文,以「保留其原有结构 + 替换任务句 + 加 `hasRulebook` 参数」为准实现,不要丢失其原有的汇报拼接或 `__ADOPT__` 约定。

- [ ] **Step 4: 改调用处传 `hasRulebook`**

在 `generateMorning`(line ~260)里,`const rbText = rulebookText(userId);` 之后加:

```ts
  const hasRb = !!getActive(userId);
```

并把:

```ts
  const analysisOut = (await aiCall(buildMorningAnalysisPrompt(personaOf(userId, 'analysis'), mkt.text, rbText, dataOut), 'analysis')).trim();
  ...
  const rawCoreOut = (await aiCall(buildMorningSynthPrompt(persona, mkt.text, rbText, dataOut, analysisOut, qualOut, skillDirectives(userId)), 'core')).trim();
```

改为:

```ts
  const analysisOut = (await aiCall(buildMorningAnalysisPrompt(personaOf(userId, 'analysis'), mkt.text, rbText, dataOut, hasRb), 'analysis')).trim();
  ...
  const rawCoreOut = (await aiCall(buildMorningSynthPrompt(persona, mkt.text, rbText, dataOut, analysisOut, qualOut, hasRb, skillDirectives(userId)), 'core')).trim();
```

在 `generateEvening`(line ~303)里,`const rbText = rulebookText(userId);` 之后加 `const hasRb = !!getActive(userId);`,并把:

```ts
  const reviewOut = (await aiCall(buildEveningReviewPrompt(personaOf(userId, 'review'), rbText, analysisOut, ops), 'review')).trim();
  const rawCoreOut = (await aiCall(buildEveningSynthPrompt(persona, mkt.text, morning, dataOut, analysisOut, reviewOut, skillDirectives(userId)), 'core')).trim();
```

改为:

```ts
  const reviewOut = (await aiCall(buildEveningReviewPrompt(personaOf(userId, 'review'), rbText, analysisOut, ops, hasRb), 'review')).trim();
  const rawCoreOut = (await aiCall(buildEveningSynthPrompt(persona, mkt.text, morning, dataOut, analysisOut, reviewOut, hasRb, skillDirectives(userId)), 'core')).trim();
```

- [ ] **Step 5: 运行测试,确认通过 + 回归**

Run: `cd backend && npx jest meetings -i`
Expected: PASS（新 builder 测试 + 原有 cron/meetings 等回归绿）。
Run: `cd backend && npm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add backend/src/meetings/service.ts backend/src/meetings/service.test.ts
git commit -m "feat(meetings): 无核心原则时早晚会只研判大盘板块、不点个股

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 前端 — rulebookApi.synthesize

**Files:**
- Modify: `frontend/src/api/rulebook.ts`

- [ ] **Step 1: 加类型 + 方法**

在 `frontend/src/api/rulebook.ts`,找到 `ProposeResult` 类型定义附近,新增:

```ts
export interface SynthesizeResult {
  proposal: ProposeResult['proposal'];
  suggestedLabel: string;
  fromScratch: true;
}
```

> 若 `ProposeResult` 未导出 `proposal` 子结构,用 `ProposeResult['proposal']` 索引访问即可(`ProposeResult` 已含 `proposal`)。

在 `rulebookApi` 对象里,`propose`/`apply` 旁新增:

```ts
  synthesize: (sessionId: string) =>
    api.post<{ data: SynthesizeResult }>('/rulebook/synthesize', { sessionId }),
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/api/rulebook.ts
git commit -m "feat(api): rulebook.synthesize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 前端 — 向导加「我还没有核心原则,帮我聊出来」选项

**Files:**
- Modify: `frontend/src/views/OnboardingView.vue`

- [ ] **Step 1: 模板列表前加访谈卡片**

把 Step1 的模板循环区(模板 line 14-17):

```vue
      <div class="tpl" v-for="t in templates" :key="t.key" :class="{ sel: chosen === t.key }" @click="chosen = t.key">
        <b>{{ t.label }}</b> <span class="muted">（{{ t.gateCount }} 条硬门槛）</span>
        <div class="muted">{{ t.description }}</div>
      </div>
```

改为(在循环前插入访谈选项卡片):

```vue
      <div class="tpl interview" :class="{ sel: chosen === '__interview__' }" @click="chosen = '__interview__'">
        <b>🗣 我还没有核心原则，帮我聊出来</b>
        <div class="muted">先不选模板，进入后来财会通过聊天了解你平时怎么选股、怎么买卖，帮你总结出一套核心原则。</div>
      </div>
      <div class="tpl" v-for="t in templates" :key="t.key" :class="{ sel: chosen === t.key }" @click="chosen = t.key">
        <b>{{ t.label }}</b> <span class="muted">（{{ t.gateCount }} 条硬门槛）</span>
        <div class="muted">{{ t.description }}</div>
      </div>
```

- [ ] **Step 2: `doTemplate` 跳过实例化 + `finish` 带标记**

把 `doTemplate`(模板 line 95-107)改为:在选了 `__interview__` 时不调用 `init`,直接进 step2:

```ts
async function doTemplate() {
  err.value = ''; busy.value = true;
  try {
    if (chosen.value === '__interview__') {
      interview.value = true;
      step.value = 2;
      return;
    }
    await rulebookApi.init(chosen.value);
    step.value = 2;
  } catch (e: any) {
    // already 有 rulebook -> just move on
    if (e.response?.status === 409) step.value = 2;
    else err.value = e.response?.data?.message || '导入失败';
  } finally {
    busy.value = false;
  }
}
```

在 `<script setup>` 顶部 state 区(`const chosen = ref('')` 附近)加:

```ts
const interview = ref(false);
```

把 `finish()`(模板 line 145-149)改为:

```ts
function finish() {
  // kick off the background stock-universe sync so search is ready (fire-and-forget)
  import('../api/data').then((m) => m.dataApi.runJob('stock_universe').catch(() => {}));
  router.push(interview.value ? '/?interview=1' : '/');
}
```

- [ ] **Step 3: 加访谈卡片样式(`<style scoped>` 末尾)**

```css
.tpl.interview { border-color: var(--accent, #2a8a2a); background: #f3faf3; }
.tpl.interview.sel { box-shadow: 0 0 0 2px rgba(42,138,42,0.25); }
```

- [ ] **Step 4: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/views/OnboardingView.vue
git commit -m "feat(onboarding): 加「帮我聊出来」选项，跳过模板实例化并标记进访谈

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 前端 — HomeView 居中引导卡 + 访谈自动开启 + 选股守卫

**Files:**
- Modify: `frontend/src/views/HomeView.vue`(删 `.initbar`;`.empty` 区加引导卡;`onMounted` 读 `?interview=1`;`runScreen` 无原则守卫)

- [ ] **Step 1: 删顶部 `.initbar`,`.empty` 区加居中引导卡**

把模板 line 54-64:

```vue
            <div v-if="needsInit" class="initbar">
              还没设定核心原则？<router-link to="/onboarding">去完成初始化设定 →</router-link>
            </div>

            <div v-if="!active" class="empty">
              <h2>你好，我是股票小作手，来财。🤝</h2>
              <p class="muted">输入股票代码 / 名称 / 拼音，开一个该股的分析讨论；或在右侧操作框点「核心原则讨论 / 更换模板」。本系统是操盘专用工具，只做个股与核心原则的讨论。</p>
              <div class="qbox">
                <StockPicker placeholder="输入股票代码 / 名称 / 拼音，开个股讨论" @pick="onDefaultPick" />
              </div>
            </div>
```

改为(去掉 initbar;在欢迎语下、StockPicker 上加引导卡):

```vue
            <div v-if="!active" class="empty">
              <h2>你好，我是股票小作手，来财。🤝</h2>

              <div v-if="needsInit" class="cp-cta">
                <div class="cp-cta-title">🎯 你还没有核心原则</div>
                <p class="cp-cta-desc">核心原则是我帮你选股、判断买卖的依据。现在还不能「按原则选股」，早晚会也只看大盘与板块。</p>
                <button class="cp-cta-btn" @click="startInterview">🗣 和来财聊出我的核心原则</button>
                <div class="cp-cta-alt"><router-link to="/onboarding">📋 或：选个模板快速开始 →</router-link></div>
              </div>

              <p class="muted">输入股票代码 / 名称 / 拼音，开一个该股的分析讨论；或在右侧操作框点「核心原则讨论 / 更换模板」。本系统是操盘专用工具，只做个股与核心原则的讨论。</p>
              <div class="qbox">
                <StockPicker placeholder="输入股票代码 / 名称 / 拼音，开个股讨论" @pick="onDefaultPick" />
              </div>
            </div>
```

- [ ] **Step 2: 加 `startInterview` 方法 + 处理 `NO_MODEL`**

在 `<script setup>` 里 `openCorePrinciple` 函数附近新增:

```ts
async function startInterview() {
  chatErr.value = '';
  try {
    await openCorePrinciple();
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '进入访谈失败';
  }
}
```

> `openCorePrinciple` 本身已 `clearMessages` + `open`,无 rulebook 时后端聊天框架自动走访谈;首次 AI 调用若 `NO_MODEL`,错误会在发首条消息时由 `postMessage` 链路抛出并显示在 `chatErr`（前端发送消息处已有 catch）。无需在 `startInterview` 预检模型。

- [ ] **Step 3: `onMounted` 读取 `?interview=1` 自动进访谈**

把 `onMounted`(模板 line 742-759)的 rulebook 加载块改为:加载后若带 `interview=1` 且无 rulebook 则自动开访谈。在文件顶部确保已 `import { useRouter, useRoute } from 'vue-router';`(现有 `useRouter`;补 `useRoute`),并在 setup 里 `const route = useRoute();`(若没有)。

把:

```ts
  try {
    const rb = (await rulebookApi.getActive()).data.data;
    activeRulebook.value = rb;
    needsInit.value = !rb;
    templates.value = (await rulebookApi.getTemplates()).data.data;
  } catch {
    /* ignore */
  }
});
```

改为:

```ts
  try {
    const rb = (await rulebookApi.getActive()).data.data;
    activeRulebook.value = rb;
    needsInit.value = !rb;
    templates.value = (await rulebookApi.getTemplates()).data.data;
  } catch {
    /* ignore */
  }
  // 向导选了「帮我聊出来」→ 落地自动进入核心原则访谈
  if (route.query.interview === '1' && needsInit.value) {
    await startInterview();
  }
});
```

> 顶部 import 现为 `import { useRouter } from 'vue-router';`(模板 line 243)→ 改 `import { useRouter, useRoute } from 'vue-router';`,并在 `const router = useRouter();` 旁加 `const route = useRoute();`。

- [ ] **Step 4: `runScreen` 无核心原则守卫**

把 `runScreen`(模板 line 668 起)函数开头加一段守卫(在 `if (generating.has('screen'))` 之前):

```ts
async function runScreen() {
  if (needsInit.value) {
    chatErr.value = '你还没有核心原则，无法按原则选股。先点上方/中间的「🗣 和来财聊出我的核心原则」定一套吧。';
    return;
  }
  // 已在后台选股中：只切回选股会话，不重复触发
  if (generating.has('screen')) {
```

（其余 `runScreen` 函数体不变。）

- [ ] **Step 5: 引导卡样式(`<style scoped>` 末尾)**

```css
.cp-cta { max-width: 460px; margin: 18px auto 22px; padding: 18px 20px; background: var(--accent-soft, #f3faf3); border: 1px solid var(--accent, #2a8a2a); border-radius: 12px; text-align: center; }
.cp-cta-title { font-size: 17px; font-weight: 700; color: var(--accent, #2a8a2a); margin-bottom: 6px; }
.cp-cta-desc { font-size: 13px; color: #666; margin: 0 0 14px; }
.cp-cta-btn { font-size: 15px; font-weight: 600; color: #fff; background: var(--accent, #2a8a2a); border: none; border-radius: 8px; padding: 11px 22px; cursor: pointer; }
.cp-cta-btn:hover { filter: brightness(1.05); }
.cp-cta-alt { margin-top: 10px; font-size: 12px; }
.cp-cta-alt a { color: #888; }
```

并删除原 `.initbar` 样式规则(模板 line 874)。

- [ ] **Step 6: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): 居中醒目「无核心原则」引导卡 + 访谈自动开启 + 选股守卫

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 前端 — 访谈合成按钮 + 完整预览 + 换模板区访谈入口

**Files:**
- Modify: `frontend/src/views/HomeView.vue`(合成按钮、`fromScratch` 完整预览、模板区「聊出一套」入口)

- [ ] **Step 1: state + 合成方法**

在 `<script setup>` 提议相关 state(模板 line 419-421 `proposal`/`proposedAt`/`proposing`)附近新增:

```ts
const synthesizing = ref(false);
const synthFromScratch = ref(false);
```

新增合成方法(放在 `propose` 函数旁):

```ts
async function synthesizePrinciple() {
  if (!active.value) return;
  synthesizing.value = true;
  chatErr.value = '';
  try {
    const r = (await rulebookApi.synthesize(active.value.id)).data.data;
    // 复用 proposal 展示通道：把合成结果塞进 proposal，标记 fromScratch 走完整预览
    proposal.value = { proposal: r.proposal, suggestedLabel: r.suggestedLabel } as any;
    synthFromScratch.value = true;
    proposedAt.value = new Date().toISOString();
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '生成失败';
  } finally {
    synthesizing.value = false;
  }
}
```

在 `applyProposal` 成功后(模板 line 456 `proposal.value = null;` 之后)补一行复位:

```ts
    synthFromScratch.value = false;
```

- [ ] **Step 2: 访谈模式按钮(模板:`active?.kind === 'core_principle'` 区块内)**

把模板 line 199-206 的 propose 按钮块:

```vue
            <template v-if="active?.kind === 'core_principle'">
              <div class="propose-bar">
                <button class="propose-btn" :disabled="proposing" @click="propose">
                  <span v-if="proposing" class="spinner"></span>{{ proposing ? 'agent 拟定中…' : '🛠 根据本次讨论，让 agent 提议修改规则' }}
                </button>
              </div>

            </template>
```

改为(无 rulebook → 显示合成按钮;有 rulebook → 现有修改按钮):

```vue
            <template v-if="active?.kind === 'core_principle'">
              <div class="propose-bar">
                <button v-if="needsInit" class="propose-btn" :disabled="synthesizing" @click="synthesizePrinciple">
                  <span v-if="synthesizing" class="spinner"></span>{{ synthesizing ? '来财生成中…' : '🛠 根据我们的聊天，帮我生成核心原则' }}
                </button>
                <button v-else class="propose-btn" :disabled="proposing" @click="propose">
                  <span v-if="proposing" class="spinner"></span>{{ proposing ? 'agent 拟定中…' : '🛠 根据本次讨论，让 agent 提议修改规则' }}
                </button>
              </div>
            </template>
```

- [ ] **Step 3: 完整预览(`fromScratch` 时渲染整套清单)**

先 Read 现有 proposal 预览块(模板 line 130-148 附近,含 `proposedAt`、`applyProposal` 按钮、delta 展示)。在该预览块**最前面**插入一个 `synthFromScratch` 分支,展示整套规则(人设/各系统门槛/软规则/仓位),并复用同一个「采纳」按钮。新增片段:

```vue
            <template v-if="proposal && synthFromScratch">
              <div class="proposal">
                <div class="prop-head">📋 来财据我们的聊天生成的核心原则（{{ proposal.suggestedLabel }}）：</div>
                <div class="prop-persona"><b>人设：</b>{{ proposal.proposal.persona }}</div>
                <div v-for="sys in synthSystems" :key="sys" class="prop-sys">
                  <b>{{ sys }} 系统硬门槛：</b>
                  <ul>
                    <li v-for="g in proposal.proposal.gates.filter((x:any)=>x.system===sys)" :key="g.gate_key">
                      {{ g.label }}：{{ gateCond(g) }}{{ g.veto ? '（一票否决）' : '' }}
                    </li>
                  </ul>
                </div>
                <div v-if="proposal.proposal.softRules.length" class="prop-soft">
                  <b>软判断：</b>
                  <ul><li v-for="(s,i) in proposal.proposal.softRules" :key="i">{{ s.text }}</li></ul>
                </div>
                <p v-if="proposedAt" class="muted">🕐 {{ fmtCN(proposedAt) }}</p>
                <button :disabled="applying" @click="applyProposal">采纳并保存为 {{ proposal.suggestedLabel }}</button>
              </div>
            </template>
```

在 `<script setup>` 新增计算属性(`synthSystems`,放在 computed 区):

```ts
const synthSystems = computed<string[]>(() => {
  const gs = (proposal.value as any)?.proposal?.gates || [];
  return [...new Set(gs.map((g: any) => g.system))].sort() as string[];
});
```

> 注意:`applyProposal` 现用 `proposal.value.suggestedLabel` 与 `proposal.value.proposal` 调 `rulebookApi.apply(label, proposal.value.proposal, active.value?.id)`——合成走的是同一结构(`{ proposal, suggestedLabel }`),无需改 `applyProposal`。`applyProposal` 成功后会刷新 `activeRulebook` 并落「✅ 已采纳」消息;为让首版生成后 `needsInit` 复位,在 `applyProposal` 成功块里(刷新 `activeRulebook` 后)补 `needsInit.value = false;`。
> 现有 delta 预览块用 `v-if="proposal"`——需改成 `v-if="proposal && !synthFromScratch"`,避免合成时同时渲染 delta 视图。

- [ ] **Step 4: `applyProposal` 成功后复位 needsInit**

在 `applyProposal`(模板 line 450-472)成功路径里,`activeRulebook.value = (await rulebookApi.getActive()).data.data;` 之后加:

```ts
    needsInit.value = false;
    synthFromScratch.value = false;
```

- [ ] **Step 5: 换模板区「帮我聊出来」入口**

在模板多选区块(模板 line 169-196 `tplswitch`)里,`previewCompose` 按钮(line 179)之后、`composeRes` 预览之前,加一个入口:

```vue
              <div class="tpl-interview-entry">
                <a href="#" @click.prevent="startInterview">或：我还没想好，帮我从聊天聊出一套 →</a>
              </div>
```

> `startInterview()`(Task 8 已定义)进入 `core_principle` 会话。对已有 rulebook 的用户,此时聊天走「修改」框架而非访谈;但合成按钮只在 `needsInit` 时出现。为让有 rulebook 的用户也能「重做一套」,本入口主要面向「在换模板区才发现自己其实没原则」的用户(此时 `needsInit` 为真,按钮即为合成)。有 rulebook 用户重做整套属低频,可后续迭代;本期不额外加「强制重做」开关(YAGNI)。

样式(`<style scoped>` 末尾):

```css
.tpl-interview-entry { margin: 6px 0; font-size: 12px; }
.tpl-interview-entry a { color: var(--accent, #2a8a2a); }
```

- [ ] **Step 6: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): 访谈合成核心原则按钮 + 完整预览 + 换模板区访谈入口

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 端到端验证 & 部署冒烟

**Files:** 无（验证 only）

- [ ] **Step 1: 全量后端测试**

Run: `cd backend && npm test`
Expected: 全绿（≥ 原 204 + 新增用例）。

- [ ] **Step 2: 前端类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 构建 + 起容器**

Run: `cd /home/zhangjq/projects/stock-agent && docker compose up -d --build`
Expected: `app` 与 `akshare-mcp` 均 healthy。

- [ ] **Step 4: 手动冒烟(浏览器硬刷新)**

逐项确认:
1. 新账号 → 向导 Step1 顶部出现「🗣 我还没有核心原则，帮我聊出来」卡片;选它 → 不报错进 Step2;配 AI、生成子 agent、完成 → 落地首页**自动**进入核心原则访谈,来财发出引导式开场问题。
2. 和来财聊几句选股/操作方法 → 点「🛠 根据我们的聊天，帮我生成核心原则」→ 出现**完整清单预览**（人设/A·B 门槛/软规则）→「采纳并保存为 我的原则 v1」→ 落「✅ 已采纳」消息,中央引导卡消失,`needsInit` 复位。
3. 无原则状态下:点「🔍 按核心原则选股」→ 出友好提示,不转圈不报后台错。
4. 无原则状态下:开一只个股 → 出**通用分析**(基本面+走势+可能走势,声明不构成买卖结论),不再 NO_RULEBOOK 失败。
5. 无原则状态下:生成早会/晚会 → 只研判大盘与板块,**不点名个股**。
6. **回归**:已有原则的老账号,核心原则讨论仍是「修改」框架 + 「提议修改」按钮 + delta 预览,选股/个股分析/早晚会照常带门槛。
7. 个股分析页 `/analysis`(若 Step 4-4 的报告会在该页展示):确认空 `gate_results` 不报错、能正常渲染(门槛区为空即可)。

- [ ] **Step 5: 完成开发分支**

按 `superpowers:finishing-a-development-branch` 收尾(本仓库为普通 repo,master 主线;是否推送听用户)。

---

## Self-Review(对照 spec)

**Spec coverage:**
- §1.1 向导加选项 → Task 7 ✅
- §1.2 落地自动开访谈 → Task 8 Step 3 ✅
- §1.3 换模板区入口 → Task 9 Step 5 ✅
- §1.4 居中醒目引导卡(替换 initbar) → Task 8 Step 1/5 ✅
- §2.1 访谈/修改框架分叉 → Task 3 ✅
- §2.2 合成服务(白名单/校验) → Task 1 ✅
- §2.3 路由 + 复用 apply → Task 2 ✅
- §2.4 完整预览 + 采纳 → Task 9 ✅
- §3.1 选股禁用提示 → Task 8 Step 4 ✅
- §3.2 个股通用分析兜底 → Task 4 ✅
- §3.3 早晚会只大盘板块 → Task 5 ✅
- §3.4 数据兼容 → 已核实 `reports.rulebook_version_id` 为可空 TEXT,**无需迁移**(Task 4 直接写 null)✅
- §4 测试/部署 → Task 1-5 各自单测 + Task 10 端到端 ✅

**Type consistency:** 后端 `synthesizeRulebook` 返回 `{ proposal: ProposalPayload, suggestedLabel }`;路由包成 `{ proposal, suggestedLabel, fromScratch }`;前端 `SynthesizeResult` 同构;`applyProposal` 复用 `{ proposal, suggestedLabel }` 结构与现有 `propose` 一致。`hasRulebook` 参数在 4 个 builder 与 2 个调用处一致追加。

**Placeholder scan:** 无 TBD/TODO。Task 4/5 中对「先 Read 现有正文再改」的说明是因 `buildEveningReviewPrompt`/`buildEveningSynthPrompt` 现正文未全文引用——已给出**目标形态**与「保留结构+替换任务句+加参数」的明确规则,非占位。
