import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-rb-'));

const svc = require('./service');
const USER = 'user-1';

describe('rulebook service', () => {
  it('instantiateBaseline creates an active V3.0 with the expected gates', () => {
    const rb = svc.instantiateBaseline(USER);
    expect(rb.version.version_label).toBe('V3.0');
    expect(rb.version.is_active).toBe(1);

    const aGates = rb.gates.filter((g: any) => g.system === 'A');
    const bGates = rb.gates.filter((g: any) => g.system === 'B');
    expect(aGates).toHaveLength(6);
    expect(bGates).toHaveLength(4); // 3 emotion gates + 1 quality gate

    const roe = rb.gates.find((g: any) => g.gate_key === 'roe_ttm');
    expect(roe.op).toBe('>=');
    expect(roe.threshold).toBe(10);
    expect(roe.veto).toBe(1);

    expect(rb.positionRules.single_stock_cap_pct.A).toBe(20);
    expect(rb.positionRules.single_trade_risk_pct.B).toBe(0.5);
  });

  it('getActive returns the instantiated version', () => {
    const active = svc.getActive(USER);
    expect(active).toBeTruthy();
    expect(active.version.version_label).toBe('V3.0');
  });

  it('createVersion makes an inactive draft; diff shows the changed threshold', () => {
    const active = svc.getActive(USER);
    // edit: loosen ROE from 10 to 8
    const editedGates = active.gates.map((g: any) =>
      g.gate_key === 'roe_ttm' ? { ...g, threshold: 8 } : g
    );
    const draft = svc.createVersion(USER, {
      versionLabel: 'V3.1',
      persona: active.version.persona,
      note: '放宽 ROE 到 8%',
      parentVersionId: active.version.id,
      author: 'user',
      gates: editedGates,
      softRules: active.softRules,
      positionRules: active.positionRules,
    });
    expect(draft.version.is_active).toBe(0);

    const diff = svc.diffVersions(USER, active.version.id, draft.version.id);
    const roeChange = diff.gates.changed.find((c: any) => c.gate_key === 'roe_ttm');
    expect(roeChange.from.threshold).toBe(10);
    expect(roeChange.to.threshold).toBe(8);
  });

  it('activateVersion switches the active flag', () => {
    const versions = svc.listVersions(USER);
    const draft = versions.find((v: any) => v.version_label === 'V3.1');
    svc.activateVersion(USER, draft.id);
    const active = svc.getActive(USER);
    expect(active.version.id).toBe(draft.id);
    // the old V3.0 is no longer active
    const v30 = svc.listVersions(USER).find((v: any) => v.version_label === 'V3.0');
    expect(v30.is_active).toBe(0);
  });

  it('activateVersion throws for an unknown version', () => {
    expect(() => svc.activateVersion(USER, 'does-not-exist')).toThrow('NOT_FOUND');
  });

  it('clearActive 取消激活，getActive 变 null（版本仍在）', () => {
    svc.instantiateBaseline(USER);
    expect(svc.getActive(USER)).toBeTruthy();
    svc.clearActive(USER);
    expect(svc.getActive(USER)).toBeNull();
    expect(svc.listVersions(USER).length).toBeGreaterThan(0); // 版本保留
  });

});
