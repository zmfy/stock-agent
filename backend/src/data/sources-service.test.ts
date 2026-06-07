import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sources-'));

const svc = require('./sources-service');

describe('data sources (global model)', () => {
  it('全局：ensureSeedGlobal 初始化内置源；listSourcesGlobal 可读', () => {
    svc.ensureSeedGlobal();
    expect(svc.listSourcesGlobal().length).toBeGreaterThan(0);
    const first = svc.listSourcesGlobal()[0];
    expect(first.builtin).toBe(1);
  });

  it('primaryBaseGlobal 返回最高优先源地址', () => {
    expect(typeof svc.primaryBaseGlobal()).toBe('string');
    expect(svc.primaryBaseGlobal()).toBe('http://akshare-mcp:8000');
  });

  it('catalogGlobal 不含已存在的源', () => {
    const cat = svc.catalogGlobal();
    const urls = cat.map((c: any) => c.base_url);
    expect(urls).not.toContain('http://akshare-mcp:8000'); // already seeded
  });

  it('addSourceGlobal / updateSourceGlobal / deleteSourceGlobal 增删改', () => {
    const id = svc.addSourceGlobal({ name: '自定义', base_url: 'http://custom:8000' });
    expect(svc.listSourcesGlobal().some((s: any) => s.id === id)).toBe(true);
    svc.updateSourceGlobal(id, { enabled: 0 });
    svc.deleteSourceGlobal(id);
    expect(svc.listSourcesGlobal().some((s: any) => s.id === id)).toBe(false);
  });

  it('secondaryBasesGlobal 返回非主源的已启用地址列表', () => {
    // Seed sina and tx secondary sources
    const idSina = svc.addSourceGlobal({ name: 'Sina', base_url: 'http://akshare-mcp:8000/sina', priority: 200 });
    const idTx = svc.addSourceGlobal({ name: 'Tx', base_url: 'http://akshare-mcp:8000/tx', priority: 200 });
    const secs = svc.secondaryBasesGlobal();
    expect(secs).not.toContain('http://akshare-mcp:8000'); // primary excluded
    expect(secs).toContain('http://akshare-mcp:8000/sina');
    expect(secs).toContain('http://akshare-mcp:8000/tx');
    // cleanup
    svc.deleteSourceGlobal(idSina);
    svc.deleteSourceGlobal(idTx);
  });
});
