import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-screen-'));

const svc = require('./service');
const rb = require('../rulebook/service');
const data = require('../data/service');
const USER = 'u-screen';

function seedStock(code: string, fund: any) {
  data.cacheFundamentals(code, '2026-06-05', { name: code, ...fund }, 'test');
  // 60 rising closes so ma20>ma60 (trend gate passes)
  data.cacheQuotes(
    Array.from({ length: 60 }, (_, i) => ({ code, date: `2026-03-${String(60 - i).padStart(2, '0')}`, open: 10 + (60 - i) * 0.05, high: 0, low: 0, close: 10 + (60 - i) * 0.05, volume: 1 })),
    'test'
  );
}

beforeAll(() => {
  rb.instantiateBaseline(USER); // V3.0
  data.cacheMarket('2026-06-05', { limit_up_count: 60, limit_down_count: 5, sse_ma20_slope: 0.1 }, 'test');
  // GOOD: passes all A veto gates (roe>=10, 0<pe<60, pb<5, ps<8, net_profit>0, ma20>ma60)
  seedStock('600001', { roe_ttm: 18, pe: 25, pb: 2, ps: 3, net_profit: 1e8, turnover_rate: 5 });
  // BAD: roe fails
  seedStock('600002', { roe_ttm: 1.2, pe: 90, pb: 2, ps: 3, net_profit: 1e6, turnover_rate: 5 });
});

describe('screen service', () => {
  it('screenCode: good stock passedSystems contains A, bad stock does not pass A', async () => {
    const good = await svc.screenCode(USER, '600001');
    const bad = await svc.screenCode(USER, '600002');
    expect(good.passedSystems).toContain('A');
    expect(bad.passedSystems).not.toContain('A'); // roe/pe fails A, B checks market sentiment only
    expect(bad.failed).toEqual(expect.arrayContaining(['roe_ttm', 'pe']));
  });

  it('screenCodes sorts qualifying first', async () => {
    const res = await svc.screenCodes(USER, ['600002', '600001']);
    expect(res[0].code).toBe('600001'); // passedSystems non-empty sorted first
  });

  it('resolveUniverse falls back to cached codes when no sidecar/codes', async () => {
    const u = await svc.resolveUniverse(USER, {});
    expect(u.codes).toEqual(expect.arrayContaining(['600001', '600002']));
    expect(u.note).toContain('回退');
  });

  it('runScreen persists and getLatest returns it', async () => {
    const r = await svc.runScreen(USER, { codes: ['600001', '600002'] });
    expect(r.results.length).toBe(2);
    const latest = svc.getLatest(USER);
    expect(latest.results.length).toBe(2);
    expect(latest.results[0].code).toBe('600001');
  });

  it('screenCode 给出确定性入选原因', async () => {
    const r = await svc.screenCode(USER, '600001');
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
    expect(r.passedSystems.length ? r.reason.includes('通过') : r.reason.includes('未入选')).toBe(true);
  });

  it('getHistory 返回最近选股(含 picks)', async () => {
    await svc.runScreen(USER, { codes: ['600001'] });
    const h = svc.getHistory(USER, 5);
    expect(Array.isArray(h)).toBe(true);
    expect(h[0]).toHaveProperty('created_at');
    expect(h[0]).toHaveProperty('picks');
  });
});

describe('选股讨论结论锚点', () => {
  it('discussScreen 输出含「🧠 来财推荐：」单独成行', async () => {
    const aiCall = async (_p: string, role: string) => `（${role}）`;
    const out = await svc.discussScreen(
      'u-anchor',
      '测试范围',
      [{ code: '600519', name: '贵州茅台', passedSystems: ['A'], passed: 1, total: 1, failed: [], reason: '入选' }],
      aiCall,
    );
    expect(out).toContain('\n🧠 来财推荐：\n');
  });
});

describe('screen 多系统：C 零仓位不参与选股', () => {
  it('能过 A 的个股 passedSystems 含 A、不含零仓位系统 C', async () => {
    const rbsvc = require('../rulebook/service');
    const U = 'u-multi-screen';
    rbsvc.createVersion(U, {
      versionLabel: '多系统', persona: 'p', parentVersionId: null,
      gates: [
        { system: 'A', gate_key: 'np', label: '净利>0', field: 'net_profit', op: '>', threshold: 0, threshold2: null, ref_field: null, unit: '元', veto: 1, teach: '' },
        { system: 'C', gate_key: 'cd', label: '复盘项', field: 'net_profit', op: '>', threshold: 0, threshold2: null, ref_field: null, unit: '元', veto: 1, teach: '' },
      ],
      softRules: [],
      positionRules: { single_trade_risk_pct: { A: 1.0 } },
    });
    const v = rbsvc.listVersions(U)[0];
    rbsvc.activateVersion(U, v.id);
    seedStock('600000', { net_profit: 1e8 });
    const svc2 = require('./service');
    const r = await svc2.screenCode(U, '600000');
    expect(Array.isArray(r.passedSystems)).toBe(true);
    expect(r.passedSystems).toContain('A');
    expect(r.passedSystems).not.toContain('C');
  });
});
