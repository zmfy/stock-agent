import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sources-'));

const svc = require('./sources-service');
const A = 'u-src';

describe('data sources', () => {
  it('seeds a built-in recommended source on first list', () => {
    const list = svc.listSources(A);
    expect(list).toHaveLength(1);
    expect(list[0].builtin).toBe(1);
    expect(svc.primaryBase(A)).toBe('http://akshare-mcp:8000');
  });

  it('catalog excludes already-added (built-in em) and offers sina/tx', () => {
    const cat = svc.catalog(A);
    const urls = cat.map((c: any) => c.base_url);
    expect(urls).not.toContain('http://akshare-mcp:8000'); // em already seeded
    expect(urls).toEqual(expect.arrayContaining(['http://akshare-mcp:8000/sina', 'http://akshare-mcp:8000/tx']));
  });

  it('adds a custom source; priority orders primary/secondary', () => {
    svc.addSource(A, { name: '我的源', baseUrl: 'http://my-src:9000/', priority: -1 }); // higher priority (smaller)
    const list = svc.listSources(A);
    expect(list).toHaveLength(2);
    expect(svc.primaryBase(A)).toBe('http://my-src:9000'); // trailing slash trimmed, lower priority number = primary
    expect(svc.secondaryBases(A)).toContain('http://akshare-mcp:8000');
  });

  it('disabling a source removes it from resolution', () => {
    const custom = svc.listSources(A).find((s: any) => s.builtin === 0);
    svc.updateSource(A, custom.id, { enabled: false });
    expect(svc.primaryBase(A)).toBe('http://akshare-mcp:8000');
  });

  it('built-in cannot be deleted; custom can', () => {
    const list = svc.listSources(A);
    const builtin = list.find((s: any) => s.builtin === 1);
    const custom = list.find((s: any) => s.builtin === 0);
    expect(() => svc.deleteSource(A, builtin.id)).toThrow('BUILTIN');
    svc.deleteSource(A, custom.id);
    expect(svc.listSources(A)).toHaveLength(1);
  });
});
