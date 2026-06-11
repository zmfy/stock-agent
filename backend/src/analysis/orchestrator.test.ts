import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-orch-'));

const orch = require('./orchestrator');
const rb = require('../rulebook/service');
const data = require('../data/service');

describe('parseAnalysisResponse', () => {
  it('parses clean JSON', () => {
    const p = orch.parseAnalysisResponse('{"a_conclusion":"不进A","one_liner":"淘汰","teach_notes":[{"gate_key":"roe_ttm","note":"x"}]}');
    expect(p.a_conclusion).toBe('不进A');
    expect(p.one_liner).toBe('淘汰');
    expect(p.teach_notes[0].gate_key).toBe('roe_ttm');
  });
  it('parses JSON wrapped in prose', () => {
    const p = orch.parseAnalysisResponse('好的，结论如下：\n{"one_liner":"OK"}\n以上。');
    expect(p.one_liner).toBe('OK');
  });
  it('falls back gracefully on garbage', () => {
    const p = orch.parseAnalysisResponse('完全不是 JSON 的内容');
    expect(p.one_liner).toContain('完全不是');
    expect(p.teach_notes).toEqual([]);
  });
});

describe('runAnalysis', () => {
  const USER = 'u-orch';

  // "throws NO_RULEBOOK" behavior removed: no-rulebook now degrades gracefully.
  // See "runAnalysis degraded (no rulebook)" describe block below.

  it('runs end-to-end with injected AI and persists a report with gate verdicts', async () => {
    rb.instantiateBaseline(USER);
    // seed a weak-ROE snapshot via cache so the gate engine has data
    data.cacheFundamentals('300241', '2026-06-05', { roe_ttm: 1.28, pe: 80, pb: 2.3, ps: 2.8, net_profit: 1, turnover_rate: 16, name: '瑞丰光电' }, 'test');
    data.cacheQuotes(
      Array.from({ length: 60 }, (_, i) => ({ code: '300241', date: `2026-04-${String(60 - i).padStart(2, '0')}`, open: 8, high: 8, low: 8, close: 8, volume: 1 })),
      'test'
    );
    data.cacheMarket('2026-06-05', { limit_up_count: 39, limit_down_count: 18, sse_ma20_slope: 0 }, 'test');

    const fakeAI = async () => ({
      raw: '{"a_conclusion":"ROE仅1.28%，不进A系统","b_conclusion":"情绪闸门关闭，不开B","exception_channel":null,"position_suggestion":"0仓","one_liner":"弱基本面+偏高估值，淘汰","teach_notes":[{"gate_key":"roe_ttm","note":"ROE是赚钱能力的核心"}]}',
      provider: 'deepseek',
      model: 'deepseek-chat',
    });

    const report = await orch.runAnalysis(USER, '300241', { aiCall: fakeAI });
    expect(report.stock_code).toBe('300241');
    expect(report.ai_model).toBe('deepseek-chat');
    expect(report.one_liner).toContain('淘汰');
    const roe = report.gate_results.find((g: any) => g.gate_key === 'roe_ttm');
    expect(roe.status).toBe('fail');
    expect(report.rulebook_version_id).toBeTruthy();
    // listed
    const list = require('./report-service').listReports(USER);
    expect(list.length).toBe(1);
  });
});

describe('runAnalysis degraded (no rulebook)', () => {
  it('produces a general report without gates and with null rulebook_version_id', async () => {
    const U = 'u-gen-analysis';
    const CODE = '600000';
    // Seed trusted snapshot using the same mechanism as the passing test above:
    // cacheFundamentals + cacheQuotes + cacheMarket so validateStock passes.
    data.cacheFundamentals(CODE, '2026-06-05', { roe_ttm: 8.5, pe: 12, pb: 1.1, ps: 1.2, net_profit: 500, turnover_rate: 3, name: '浦发银行' }, 'test');
    data.cacheQuotes(
      Array.from({ length: 60 }, (_, i) => ({ code: CODE, date: `2026-04-${String(60 - i).padStart(2, '0')}`, open: 10, high: 10, low: 10, close: 10, volume: 1 })),
      'test'
    );
    data.cacheMarket('2026-06-05', { limit_up_count: 39, limit_down_count: 18, sse_ma20_slope: 0 }, 'test');

    const report = await orch.runAnalysis(U, CODE, {
      aiCall: async () => ({
        raw: JSON.stringify({
          one_liner: '未设当前策略，仅供参考：基本面尚可',
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
    expect(report.one_liner).toContain('未设当前策略');
  });
});
