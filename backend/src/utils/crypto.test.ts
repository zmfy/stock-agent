import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-crypto-'));

const { encryptSecret, decryptSecret } = require('./crypto');

describe('crypto', () => {
  it('round-trips encrypt -> decrypt', () => {
    const secret = 'sk-test-1234567890';
    const enc = encryptSecret(secret);
    expect(enc).not.toBe(secret);
    expect(enc).toContain(':');
    expect(decryptSecret(enc)).toBe(secret);
  });

  it('maps empty string to empty string both ways', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });
});
