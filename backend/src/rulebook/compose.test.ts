import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-compose-'));

const { composeTemplates } = require('./compose');

describe('composeTemplates', () => {
  it('single template returns it as system A, no conflict', () => {
    const r = composeTemplates(['value-quality']);
    expect(r.conflict).toBe(false);
    expect(r.systems).toHaveLength(1);
    expect(r.baseline.gates.every((g: any) => g.system === 'A')).toBe(true);
  });

  it('conflicting templates split into A/B systems (different pe constraints)', () => {
    // value-quality has pe 0..30, low-pe-bluechip has pe 0..15 -> conflict on pe
    const r = composeTemplates(['value-quality', 'low-pe-bluechip']);
    expect(r.conflict).toBe(true);
    expect(r.conflictFields).toContain('pe');
    expect(r.systems.map((s: any) => s.letter)).toEqual(['A', 'B']);
    const letters = new Set(r.baseline.gates.map((g: any) => g.system));
    expect(letters).toEqual(new Set(['A', 'B']));
    expect((r.baseline.positionRules as any).system_priority).toEqual(['A', 'B']);
  });

  it('priority follows key order', () => {
    const r = composeTemplates(['low-pe-bluechip', 'value-quality']);
    expect(r.systems[0].key).toBe('low-pe-bluechip'); // first key = system A = highest priority
  });

  it('non-conflicting templates merge into one system A', () => {
    // ma-bullish (ma gates) + value-quality (roe/pe/pb/ps) -> different fields, no conflict
    const r = composeTemplates(['ma-bullish', 'value-quality']);
    expect(r.conflict).toBe(false);
    expect(r.baseline.gates.every((g: any) => g.system === 'A')).toBe(true);
    const fields = r.baseline.gates.map((g: any) => g.field);
    expect(fields).toEqual(expect.arrayContaining(['roe_ttm', 'ma20']));
  });
});
