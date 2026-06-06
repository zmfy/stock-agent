import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-plugins-'));

const svc = require('./service');
const A = 'user-A';
const B = 'user-B';

describe('plugins service', () => {
  it('lists the 6 catalog plugins, all ENABLED by default', () => {
    const list = svc.listForUser(A);
    expect(list).toHaveLength(6);
    expect(list.every((p: any) => p.enabled)).toBe(true);
    expect(list.map((p: any) => p.key)).toEqual(
      expect.arrayContaining(['playwright', 'akshare-data', 'research', 'memory', 'fetch', 'sequential-thinking'])
    );
    expect(list.find((p: any) => p.key === 'playwright').config.command).toBe('npx');
  });

  it('disabling a builtin persists OFF; per-user isolated', () => {
    svc.setEnabled(B, 'playwright', false);
    expect(svc.listForUser(B).find((p: any) => p.key === 'playwright').enabled).toBe(false);
    // A unaffected — still default ON
    expect(svc.listForUser(A).find((p: any) => p.key === 'playwright').enabled).toBe(true);
  });

  it('adds a custom plugin (enabled) and rejects duplicate keys', () => {
    svc.addCustom(A, { key: 'my-mcp', label: '我的数据源', kind: 'mcp', transport: 'http', config: { url: 'http://x/sse' } });
    const custom = svc.listForUser(A).find((p: any) => p.key === 'my-mcp');
    expect(custom.enabled).toBe(true);
    expect(custom.source).toBe('custom');
    expect(() => svc.addCustom(A, { key: 'my-mcp', label: 'dup', kind: 'mcp', config: {} })).toThrow('DUPLICATE_KEY');
    expect(() => svc.addCustom(A, { key: 'playwright', label: 'dup', kind: 'mcp', config: {} })).toThrow('DUPLICATE_KEY');
  });

  it('updateConfig overrides the stored config', () => {
    svc.updateConfig(A, 'akshare-data', { url: 'http://my-sidecar:9000/sse' });
    const ak = svc.listForUser(A).find((p: any) => p.key === 'akshare-data');
    expect(ak.config.url).toBe('http://my-sidecar:9000/sse');
  });

  it('getEnabledCapabilities groups mcp vs skill', () => {
    svc.setEnabled(A, 'research', true);
    const caps = svc.getEnabledCapabilities(A);
    expect(caps.mcp.map((m: any) => m.key)).toEqual(expect.arrayContaining(['playwright', 'my-mcp']));
    expect(caps.skills.map((s: any) => s.key)).toContain('research');
  });

  it('removing a custom plugin deletes it; disabling a builtin turns it off', () => {
    svc.remove(A, 'my-mcp');
    expect(svc.listForUser(A).find((p: any) => p.key === 'my-mcp')).toBeUndefined();
    svc.setEnabled(A, 'playwright', false);
    expect(svc.listForUser(A).find((p: any) => p.key === 'playwright').enabled).toBe(false);
    // removing the builtin row reverts it to default ON
    svc.remove(A, 'playwright');
    expect(svc.listForUser(A).find((p: any) => p.key === 'playwright').enabled).toBe(true);
  });
});
