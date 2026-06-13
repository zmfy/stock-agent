import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ctx-'));

const ctx = require('./context');
const rb = require('../rulebook/service');
const USER = 'u-ctx';

beforeAll(() => {
  rb.instantiateBaseline(USER);
});

describe('today() uses Beijing calendar day', () => {
  afterEach(() => jest.useRealTimers());
  it('returns the Beijing date even when UTC is still the previous day', () => {
    // 2026-06-07T17:00:00Z = 2026-06-08 01:00 北京 → today() 应为 06-08（而非 UTC 的 06-07）
    jest.useFakeTimers().setSystemTime(new Date('2026-06-07T17:00:00Z'));
    expect(ctx.today()).toBe('2026-06-08');
  });
});

describe('eligibleUserIds', () => {
  it('excludes a user that has a rulebook but no usable AI model', () => {
    // USER 有 rulebook 但未配置任何 AI 模型 → 不合格
    expect(ctx.eligibleUserIds()).not.toContain(USER);
  });
});
