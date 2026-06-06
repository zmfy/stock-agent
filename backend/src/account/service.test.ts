import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-account-'));

const svc = require('./service');
const rb = require('../rulebook/service');
const profiles = require('../agent/profiles-service');
const A = 'u-acct';
const B = 'u-other';

describe('account data backup/restore/reset', () => {
  it('backup captures data; reset wipes it; restore brings it back', async () => {
    rb.instantiateBaseline(A); // V3.0 + gates
    profiles.setProfile(A, 'core', '我的主 agent 人设');
    expect(rb.getActive(A)).toBeTruthy();

    // backup
    const b = svc.createBackup(A, 'test-backup');
    expect(b.id).toBeTruthy();
    expect(svc.listBackups(A)).toHaveLength(1);

    // reset wipes (and auto-backups)
    svc.resetUser(A);
    expect(rb.getActive(A)).toBeNull();
    expect(profiles.getCorePersona(A)).not.toBe('我的主 agent 人设'); // back to default
    expect(svc.listBackups(A).length).toBeGreaterThanOrEqual(2); // original + auto

    // restore the original
    expect(svc.restoreBackup(A, b.id)).toBe(true);
    const active = rb.getActive(A);
    expect(active.version.version_label).toBe('V3.0');
    expect(active.gates.length).toBe(10);
    expect(profiles.getCorePersona(A)).toBe('我的主 agent 人设');
  });

  it('backups are per-user; cannot restore another user backup', () => {
    rb.instantiateBaseline(B);
    expect(svc.restoreBackup(B, 'nonexistent')).toBe(false);
    // B restoring A's backup id -> not found (scoped by user)
    const aBackup = svc.listBackups(A)[0];
    expect(svc.restoreBackup(B, aBackup.id)).toBe(false);
  });

  it('deleteBackup removes it', () => {
    const before = svc.listBackups(A).length;
    svc.deleteBackup(A, svc.listBackups(A)[0].id);
    expect(svc.listBackups(A).length).toBe(before - 1);
  });
});
