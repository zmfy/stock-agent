import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sharing-'));

const { getDb } = require('../db');
const svc = require('./service');
const usage = require('./usage');

const ADMIN = 'admin-s';
const USER = 'user-s';
const CFG = 'cfgshared';

beforeAll(() => {
  getDb().prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run(ADMIN, 'root', 'x', 'admin');
  getDb().prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run(USER, 'bob', 'x', 'user');
  // admin shared config (deepseek needs key -> give placeholder enc), enabled+shared, cap 1000, no reset
  getDb()
    .prepare(
      'INSERT INTO ai_configs (id, user_id, provider, model, base_url, api_key_enc, enabled, shared, share_max_tokens, share_period_seconds) VALUES (?,?,?,?,?,?,1,1,1000,0)'
    )
    .run(CFG, ADMIN, 'deepseek', 'deepseek-chat', '', 'x');
});

describe('shared resolution', () => {
  it('listSharedForUser lists shared model with NO key and quota', () => {
    const list = svc.listSharedForUser(USER);
    const m = list.find((x: any) => x.configId === CFG);
    expect(m).toBeTruthy();
    expect(m.provider).toBe('deepseek');
    expect(m.enabledForMe).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/api_?key/i);
    expect(m.quota).toMatchObject({ cap: 1000, used: 0, over: false });
  });

  it('opt-out removes it from the user pool but keeps it listed (enabledForMe=false)', () => {
    svc.setSharedOptout(USER, CFG, false);
    expect(svc.enabledConfigs(USER).some((c: any) => c.ownerConfigId === CFG)).toBe(false);
    const m = svc.listSharedForUser(USER).find((x: any) => x.configId === CFG);
    expect(m.enabledForMe).toBe(false);
    svc.setSharedOptout(USER, CFG, true);
    expect(svc.enabledConfigs(USER).some((c: any) => c.ownerConfigId === CFG)).toBe(true);
  });

  it('enabledConfigs: shared carries scope/ref/ownerConfigId', () => {
    const pool = svc.enabledConfigs(USER);
    const shared = pool.find((c: any) => c.ownerConfigId === CFG);
    expect(shared).toMatchObject({ scope: 'shared', ref: 'shared:' + CFG, provider: 'deepseek' });
  });

  it('manual pin via sharedConfigId resolves to the shared model', () => {
    svc.setRoleAssignment(USER, 'analysis', { mode: 'manual', sharedConfigId: CFG });
    const cfg = svc.getModelForRole(USER, 'analysis');
    expect(cfg).toMatchObject({ scope: 'shared', ownerConfigId: CFG, model: 'deepseek-chat' });
  });

  it('over-limit removes the shared model from everyone’s pool', () => {
    usage.recordSharedUsage(CFG, USER, 1000); // hit cap (period 0 => window 0)
    expect(svc.enabledConfigs(USER).some((c: any) => c.ownerConfigId === CFG)).toBe(false);
    const m = svc.listSharedForUser(USER).find((x: any) => x.configId === CFG);
    expect(m.quota.over).toBe(true);
    usage.resetConfigUsage(CFG);
    expect(svc.enabledConfigs(USER).some((c: any) => c.ownerConfigId === CFG)).toBe(true);
  });
});

describe('setShared (admin writes own row) + listConfigs exposes share fields', () => {
  it('writes shared + quota onto own config', () => {
    svc.setShared(ADMIN, 'deepseek', { shared: true, maxTokens: 500, periodSeconds: 18000 });
    const pub = svc.listConfigs(ADMIN).find((c: any) => c.provider === 'deepseek');
    expect(pub).toMatchObject({ shared: 1, shareMaxTokens: 500, sharePeriodSeconds: 18000 });
    svc.setShared(ADMIN, 'deepseek', { shared: true, maxTokens: 1000, periodSeconds: 0 }); // restore
  });
});
