import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-plugsvc-'));

const { getDb } = require('../db');
const svc = require('./service');
const A = 'user-A';
const B = 'user-B';

const ADMIN = 'admin-uid';
const USER = 'user-uid';

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'adm', 'x', 'admin')").run(ADMIN);
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'usr', 'x', 'user')").run(USER);
});

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

  it('skills carry a default config + hint, and skillDirectives reflects enabled skills', () => {
    const sk = svc.listForUser(A).find((p: any) => p.key === 'sequential-thinking');
    expect(sk.config.max_steps).toBe(6); // 不再是空配置
    expect(sk.configHint).toContain('max_steps');
    // built-in skills are default-ON -> directives mention 分步推理 / 探索 / 记忆
    const d = svc.skillDirectives(A);
    expect(d).toContain('分步推理');
    expect(d).toContain('探索');
    expect(d).toContain('记忆');
    // honor config: 关掉分步推理触发后不再出现该条
    svc.updateConfig(A, 'sequential-thinking', { max_steps: 6, show_steps: false, trigger: '从不' });
    expect(svc.skillDirectives(A)).not.toContain('分步推理');
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

describe('shared plugins', () => {
  function adminSharesMcp() {
    svc.addCustom(ADMIN, { key: 'mymcp', label: '管理员MCP', kind: 'mcp', transport: 'http', config: { url: 'http://secret' } });
    svc.setShared(ADMIN, 'mymcp', true);
  }

  beforeEach(() => {
    getDb().exec('DELETE FROM plugins WHERE user_id IN (?,?); DELETE FROM shared_plugin_optout;'.replace('?,?', `'${ADMIN}','${USER}'`));
  });

  it('sharedPlugins 返回 admin 已共享插件(带真实 config)', () => {
    adminSharesMcp();
    const sp = svc.sharedPlugins();
    expect(sp).toHaveLength(1);
    expect(sp[0]).toMatchObject({ key: 'mymcp', kind: 'mcp', config: { url: 'http://secret' } });
  });

  it('listSharedForUser 给用户看到共享项但隐藏 config', () => {
    adminSharesMcp();
    const list = svc.listSharedForUser(USER);
    const m = list.find((p: any) => p.key === 'mymcp');
    expect(m).toMatchObject({ shared: true, owner: 'admin', enabled: true, configured: true });
    expect(m.config).toEqual({});
  });

  it('getEnabledCapabilities 并入未停用的共享插件(用 admin 真实 config)', () => {
    adminSharesMcp();
    const cap = svc.getEnabledCapabilities(USER);
    const m = cap.mcp.find((x: any) => x.key === 'mymcp');
    expect(m).toMatchObject({ key: 'mymcp', config: { url: 'http://secret' } });
  });

  it('用户 opt-out 后：列表显示停用、能力里消失', () => {
    adminSharesMcp();
    svc.setSharedEnabled(USER, 'mymcp', false);
    expect(svc.listSharedForUser(USER).find((p: any) => p.key === 'mymcp').enabled).toBe(false);
    expect(svc.getEnabledCapabilities(USER).mcp.find((x: any) => x.key === 'mymcp')).toBeUndefined();
    svc.setSharedEnabled(USER, 'mymcp', true);
    expect(svc.getEnabledCapabilities(USER).mcp.find((x: any) => x.key === 'mymcp')).toBeTruthy();
  });

  it('取消共享后用户侧消失', () => {
    adminSharesMcp();
    svc.setShared(ADMIN, 'mymcp', false);
    expect(svc.sharedPlugins()).toHaveLength(0);
    expect(svc.listSharedForUser(USER).find((p: any) => p.key === 'mymcp')).toBeUndefined();
  });

  it('admin 自己的能力不因 sharedPlugins 含自身而重复', () => {
    adminSharesMcp();
    expect(svc.getEnabledCapabilities(ADMIN).mcp.filter((x: any) => x.key === 'mymcp')).toHaveLength(1);
  });
});
