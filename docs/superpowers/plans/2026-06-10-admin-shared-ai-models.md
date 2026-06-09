# Admin 共享 AI 大模型 + 全局配额 + 防 429 节流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** admin 可把自己的 AI 模型共享给所有用户（默认开、可关、看不到 key）；每个共享模型按窗口全局 token 配额（超限对所有人停用、按可配周期重置）；并把 LLM 节流升级为按 key 自适应以防 429。

**Architecture:** 复用 per-user `ai_configs`，给它加 `shared/share_max_tokens/share_period_seconds` 列；admin 的 shared 行被折进所有用户的解析池（`enabledConfigs`/`getModelForRole`），用 admin 的 key（server 端解密，永不外泄）。新 `ai/usage.ts` 记账 + 窗口配额。`ai/manager.ts` 的全局节流泛化为按 key 自适应（AIMD）。

**Tech Stack:** TypeScript + Express + better-sqlite3 + Jest；Vue 3 + vue-tsc。

**测试命令：** 后端 `cd backend && npm test`（当前 241 绿）；前端 `cd frontend && npx vue-tsc --noEmit`。

**Spec：** `docs/superpowers/specs/2026-06-10-admin-shared-ai-models-design.md`。

---

## File Structure

**后端**
- `backend/src/db.ts`（改 migrate）— 加列/建表。
- `backend/src/ai/usage.ts`（新）— `currentWindow` / `recordSharedUsage` / `getUsageForConfig` / `resetConfigUsage`。
- `backend/src/ai/usage.test.ts`（新）。
- `backend/src/ai/service.ts`（改）— ResolvedConfig/AiConfigRow 扩展；shared 解析与展示；角色钉共享。
- `backend/src/ai/sharing.test.ts`（新）— 共享/配额/解析单测。
- `backend/src/ai/manager.ts`（改）— 按 key 自适应节流 + usage 解析 + `account` 末参。
- `backend/src/ai/manager.test.ts`（新）— 节流 + usage 记账。
- 调用方 ~7 处（orchestrator/chat/meetings/screen/rulebook·propose/rulebook·memory/agent·profiles）— 透传 `account`。
- `backend/src/routes/ai.ts`（改）+ `backend/src/routes/ai.test.ts`（改）— 新路由 + 鉴权。
- `backend/src/account/service.ts`（改）— `shared_ai_optout` 进 PER_USER_TABLES。

**前端**
- `frontend/src/api/ai.ts`（改）— 新方法 + 类型。
- `frontend/src/views/AiSettingsView.vue`（改）— admin 共享/配额/用量；用户共享区；角色下拉共享项。

---

## Task 1: DB 迁移（列 + 表）

**Files:** Modify `backend/src/db.ts`（`migrate()` 内）

- [ ] **Step 1: 在 `migrate()` 末尾（最后一个 `db.exec(...)` 之后、函数 `}` 之前）追加**

```ts
  // --- admin 共享 AI 模型 + 配额 ---
  const aiCols = db.prepare('PRAGMA table_info(ai_configs)').all() as { name: string }[];
  if (!aiCols.some((c) => c.name === 'shared')) db.exec('ALTER TABLE ai_configs ADD COLUMN shared INTEGER DEFAULT 0');
  if (!aiCols.some((c) => c.name === 'share_max_tokens')) db.exec('ALTER TABLE ai_configs ADD COLUMN share_max_tokens INTEGER DEFAULT 0');
  if (!aiCols.some((c) => c.name === 'share_period_seconds')) db.exec('ALTER TABLE ai_configs ADD COLUMN share_period_seconds INTEGER DEFAULT 0');

  const raCols = db.prepare('PRAGMA table_info(ai_role_assignments)').all() as { name: string }[];
  if (raCols.length && !raCols.some((c) => c.name === 'shared_config_id')) {
    db.exec('ALTER TABLE ai_role_assignments ADD COLUMN shared_config_id TEXT');
  }

  db.exec(`CREATE TABLE IF NOT EXISTS shared_ai_optout (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, config_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, config_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS shared_ai_usage (
    config_id TEXT NOT NULL, user_id TEXT NOT NULL,
    calls INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, window_start INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (config_id, user_id)
  )`);
```

- [ ] **Step 2: 编译 + 跑既有测试确认无回归**

Run: `cd backend && npx tsc --noEmit && npm test 2>&1 | tail -4`
Expected: tsc exit 0；测试仍全绿（241）。迁移幂等，老库重启不报错。

- [ ] **Step 3: 提交**

```bash
git add backend/src/db.ts
git commit -m "feat(db): 共享AI迁移(ai_configs.shared/quota 列, role shared_config_id, shared_ai_optout/usage 表)"
```

---

## Task 2: `ai/usage.ts` 记账模块（TDD）

**Files:** Create `backend/src/ai/usage.ts`、`backend/src/ai/usage.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/ai/usage.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-usage-'));

const { getDb } = require('../db');
const u = require('./usage');

const ADMIN = 'admin-1';
const CFG = 'cfg-1';

beforeAll(() => {
  // a shared config row (period 5h) owned by admin
  getDb().prepare("INSERT INTO ai_configs (id, user_id, provider, model, base_url, enabled, shared, share_max_tokens, share_period_seconds) VALUES (?,?,?,?,?,1,1,1000,?)")
    .run(CFG, ADMIN, 'deepseek', 'deepseek-chat', '', 5 * 3600);
  getDb().prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)").run('uX', 'alice', 'x', 'user');
});

describe('currentWindow', () => {
  it('period 0 => 0 (never reset)', () => expect(u.currentWindow(0)).toBe(0));
  it('period>0 => floored bucket', () => {
    const now = 1_000_000; // seconds
    expect(u.currentWindow(3600, now * 1000)).toBe(Math.floor(now / 3600) * 3600);
  });
});

describe('recordSharedUsage + getUsageForConfig', () => {
  it('accumulates within window and resets across windows', () => {
    // window A
    u.recordSharedUsage(CFG, 'uX', 100, 10_000_000_000); // nowMs injected
    u.recordSharedUsage(CFG, 'uX', 50, 10_000_000_000);
    const rowsA = u.getUsageForConfig(CFG, 5 * 3600, 10_000_000_000);
    expect(rowsA.find((r: any) => r.userId === 'uX')).toMatchObject({ username: 'alice', calls: 2, total_tokens: 150 });
    // far-future window B => row resets
    u.recordSharedUsage(CFG, 'uX', 7, 99_000_000_000);
    const rowsB = u.getUsageForConfig(CFG, 5 * 3600, 99_000_000_000);
    expect(rowsB.find((r: any) => r.userId === 'uX')).toMatchObject({ calls: 1, total_tokens: 7 });
  });
  it('resetConfigUsage clears rows', () => {
    u.resetConfigUsage(CFG);
    expect(u.getUsageForConfig(CFG, 5 * 3600, 99_000_000_000)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && npx jest ai/usage -i`
Expected: FAIL — `Cannot find module './usage'`。

- [ ] **Step 3: 实现 `backend/src/ai/usage.ts`**

```ts
import { getDb } from '../db';

// 固定窗口起点(unix 秒)。period<=0 表示不重置(终身)。nowMs 可注入以便测试。
export function currentWindow(periodSeconds: number, nowMs: number = Date.now()): number {
  if (!periodSeconds || periodSeconds <= 0) return 0;
  const sec = Math.floor(nowMs / 1000);
  return Math.floor(sec / periodSeconds) * periodSeconds;
}

function periodOf(configId: string): number {
  const r = getDb().prepare('SELECT share_period_seconds AS p FROM ai_configs WHERE id = ?').get(configId) as { p: number } | undefined;
  return r?.p ?? 0;
}

// 窗口感知 UPSERT：跨窗口则重置。记账失败不应影响调用方（调用方自行 try/catch）。
export function recordSharedUsage(configId: string, userId: string, tokens: number, nowMs: number = Date.now()): void {
  const db = getDb();
  const cur = currentWindow(periodOf(configId), nowMs);
  const row = db.prepare('SELECT calls, total_tokens, window_start FROM shared_ai_usage WHERE config_id = ? AND user_id = ?').get(configId, userId) as
    | { calls: number; total_tokens: number; window_start: number }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO shared_ai_usage (config_id, user_id, calls, total_tokens, window_start) VALUES (?,?,1,?,?)').run(configId, userId, tokens, cur);
  } else if (row.window_start !== cur) {
    db.prepare('UPDATE shared_ai_usage SET calls = 1, total_tokens = ?, window_start = ?, updated_at = CURRENT_TIMESTAMP WHERE config_id = ? AND user_id = ?').run(tokens, cur, configId, userId);
  } else {
    db.prepare('UPDATE shared_ai_usage SET calls = calls + 1, total_tokens = total_tokens + ?, updated_at = CURRENT_TIMESTAMP WHERE config_id = ? AND user_id = ?').run(tokens, configId, userId);
  }
}

// 当前窗口内、该模型每个用户的用量（JOIN users 取用户名）。
export function getUsageForConfig(configId: string, periodSeconds: number, nowMs: number = Date.now()): Array<{ userId: string; username: string; calls: number; total_tokens: number }> {
  const cur = currentWindow(periodSeconds, nowMs);
  const rows = getDb()
    .prepare(`SELECT s.user_id AS userId, COALESCE(u.username,'?') AS username, s.calls AS calls, s.total_tokens AS total_tokens
              FROM shared_ai_usage s LEFT JOIN users u ON u.id = s.user_id
              WHERE s.config_id = ? AND s.window_start = ? ORDER BY s.total_tokens DESC`)
    .all(configId, cur) as Array<{ userId: string; username: string; calls: number; total_tokens: number }>;
  return rows;
}

// 当前窗口内该模型全局合计 token。
export function currentConfigUsage(configId: string, periodSeconds: number, nowMs: number = Date.now()): number {
  const cur = currentWindow(periodSeconds, nowMs);
  const r = getDb().prepare('SELECT COALESCE(SUM(total_tokens),0) AS t FROM shared_ai_usage WHERE config_id = ? AND window_start = ?').get(configId, cur) as { t: number };
  return r?.t ?? 0;
}

export function resetConfigUsage(configId: string): void {
  getDb().prepare('DELETE FROM shared_ai_usage WHERE config_id = ?').run(configId);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend && npx jest ai/usage -i`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add backend/src/ai/usage.ts backend/src/ai/usage.test.ts
git commit -m "feat(ai): usage.ts 共享模型窗口用量记账(currentWindow/record/get/reset/currentConfigUsage)"
```

---

## Task 3: `service.ts` — 共享解析 + 展示 + 角色钉共享（TDD）

**Files:** Modify `backend/src/ai/service.ts`、Create `backend/src/ai/sharing.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/ai/sharing.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sharing-'));

const { getDb } = require('../db');
const svc = require('./service');

const ADMIN = 'admin-s';
const USER = 'user-s';
const CFG = 'cfgshared';

beforeAll(() => {
  getDb().prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)").run(ADMIN, 'root', 'x', 'admin');
  getDb().prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)").run(USER, 'bob', 'x', 'user');
  // admin shared config (deepseek, enabled, shared, cap 1000, no reset)
  getDb().prepare("INSERT INTO ai_configs (id, user_id, provider, model, base_url, api_key_enc, enabled, shared, share_max_tokens, share_period_seconds) VALUES (?,?,?,?,?,?,1,1,1000,0)")
    .run(CFG, ADMIN, 'deepseek', 'deepseek-chat', '', null);
});

describe('shared resolution', () => {
  it('sharedConfigs returns admin shared (provider needsApiKey=false path ok if no key required); listSharedForUser has NO key', () => {
    const list = svc.listSharedForUser(USER);
    const m = list.find((x: any) => x.configId === CFG);
    expect(m).toBeTruthy();
    expect(m.provider).toBe('deepseek');
    expect(m.enabledForMe).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/api_?key/i); // 无 key 字段
    expect(m.quota).toMatchObject({ cap: 1000, used: 0, over: false });
  });

  it('opt-out removes it from the user pool but keeps it listed (enabledForMe=false)', () => {
    svc.setSharedOptout(USER, CFG, false); // false = 关掉
    expect(svc.enabledConfigs(USER).some((c: any) => c.ownerConfigId === CFG)).toBe(false);
    const m = svc.listSharedForUser(USER).find((x: any) => x.configId === CFG);
    expect(m.enabledForMe).toBe(false);
    svc.setSharedOptout(USER, CFG, true); // 重新开
    expect(svc.enabledConfigs(USER).some((c: any) => c.ownerConfigId === CFG)).toBe(true);
  });

  it('enabledConfigs puts self before shared; shared carries scope/ref/ownerConfigId', () => {
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
    const { recordSharedUsage } = require('./usage');
    recordSharedUsage(CFG, USER, 1000); // hit cap (period 0 => window 0)
    expect(svc.enabledConfigs(USER).some((c: any) => c.ownerConfigId === CFG)).toBe(false);
    const m = svc.listSharedForUser(USER).find((x: any) => x.configId === CFG);
    expect(m.quota.over).toBe(true);
    require('./usage').resetConfigUsage(CFG);
  });
});

describe('setShared (admin only writes own row)', () => {
  it('writes shared + quota onto own config', () => {
    svc.setShared(ADMIN, 'deepseek', { shared: true, maxTokens: 500, periodSeconds: 18000 });
    const pub = svc.listConfigs(ADMIN).find((c: any) => c.provider === 'deepseek');
    expect(pub).toMatchObject({ shared: 1, shareMaxTokens: 500, sharePeriodSeconds: 18000 });
    svc.setShared(ADMIN, 'deepseek', { shared: true, maxTokens: 1000, periodSeconds: 0 }); // restore
  });
});
```

> 说明：deepseek 的 `needsApiKey` 若为 true 而本行无 key，会被 `sharedConfigs` 的可用性过滤剔除。若测试中 deepseek 需要 key，给上面 INSERT 的 `api_key_enc` 填一个非空占位串（如 `'x'`）即可（解密失败返回 ''，但 needsApiKey 检查只看 `!!api_key_enc`）。实现时按 `getProvider('deepseek').needsApiKey` 实际值决定是否填占位 key。

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && npx jest ai/sharing -i`
Expected: FAIL — `svc.listSharedForUser is not a function` 等。

- [ ] **Step 3: 扩展 `ResolvedConfig` 与 `AiConfigRow`**

`backend/src/ai/service.ts`，`ResolvedConfig`（约 117-122）改为：
```ts
export interface ResolvedConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  scope?: 'self' | 'shared';
  ref?: string;
  ownerConfigId?: string;
}
```
`AiConfigRow`（约 8-18）加三列：
```ts
  shared?: number;
  share_max_tokens?: number;
  share_period_seconds?: number;
```

- [ ] **Step 4: import usage 助手**（文件顶部 import 区，`./manager` 之后加）

```ts
import { currentConfigUsage } from './usage';
```

- [ ] **Step 5: 新增共享解析与展示函数**（加在 `enabledConfigs` 之前）

```ts
// admin 的「可用」共享配置（已剔除全局超限的），用于解析池。
export function sharedConfigs(nowMs: number = Date.now()): ResolvedConfig[] {
  const rows = getDb()
    .prepare(`SELECT c.* FROM ai_configs c JOIN users u ON u.id = c.user_id
              WHERE u.role = 'admin' AND c.shared = 1 AND c.enabled = 1`)
    .all() as AiConfigRow[];
  return rows
    .filter((r) => {
      const def = getProvider(r.provider);
      if (!def || (def.needsApiKey && !r.api_key_enc)) return false;
      const cap = r.share_max_tokens ?? 0;
      if (cap > 0 && currentConfigUsage(r.id, r.share_period_seconds ?? 0, nowMs) >= cap) return false; // 全局超限→对所有人停用
      return true;
    })
    .map((r) => ({
      provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptSecret(r.api_key_enc ?? ''),
      scope: 'shared' as const, ref: 'shared:' + r.id, ownerConfigId: r.id,
    }));
}

function optoutSet(userId: string): Set<string> {
  const rows = getDb().prepare('SELECT config_id FROM shared_ai_optout WHERE user_id = ?').all(userId) as { config_id: string }[];
  return new Set(rows.map((r) => r.config_id));
}

export function sharedConfigsForUser(userId: string, nowMs: number = Date.now()): ResolvedConfig[] {
  const out = optoutSet(userId);
  return sharedConfigs(nowMs).filter((c) => !out.has(c.ownerConfigId!));
}
```

- [ ] **Step 6: 改 `enabledConfigs` 拼接共享池（自有在前）**

把 `enabledConfigs`（约 133-143）改为：
```ts
export function enabledConfigs(userId: string): ResolvedConfig[] {
  const rows = getDb()
    .prepare('SELECT * FROM ai_configs WHERE user_id = ? AND enabled = 1 ORDER BY provider')
    .all(userId) as AiConfigRow[];
  const self = rows
    .filter((r) => {
      const def = getProvider(r.provider);
      return def && (!def.needsApiKey || !!r.api_key_enc);
    })
    .map((r) => ({ provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptSecret(r.api_key_enc ?? ''), scope: 'self' as const, ref: 'self:' + r.provider }));
  return [...self, ...sharedConfigsForUser(userId)];
}
```

- [ ] **Step 7: 改 `getRoleAssignment`/`setRoleAssignment` 支持 `shared_config_id`**

`getRoleAssignment`（约 152-156）的 SELECT 加列：
```ts
export function getRoleAssignment(userId: string, role: string): RoleAssignmentRow | undefined {
  return getDb()
    .prepare('SELECT role, mode, provider, model, shared_config_id FROM ai_role_assignments WHERE user_id = ? AND role = ?')
    .get(userId, role) as RoleAssignmentRow | undefined;
}
```
`RoleAssignmentRow` 接口加 `shared_config_id?: string | null;`（在其定义处）。

`setRoleAssignment`（约 158-182）改为支持 `sharedConfigId`（手动钉共享）：
```ts
export function setRoleAssignment(
  userId: string,
  role: string,
  input: { mode: 'manual' | 'auto'; provider?: string | null; model?: string | null; sharedConfigId?: string | null }
): void {
  if (!getRole(role)) throw new Error('UNKNOWN_ROLE');
  let provider: string | null = null;
  let model: string | null = null;
  let sharedConfigId: string | null = null;

  if (input.mode === 'manual') {
    if (input.sharedConfigId) {
      // 钉共享模型：必须仍可用（在该用户的共享池里）
      const sc = sharedConfigsForUser(userId).find((c) => c.ownerConfigId === input.sharedConfigId);
      if (!sc) throw new Error('NOT_ENABLED');
      sharedConfigId = input.sharedConfigId;
      model = sc.model;
    } else {
      if (!input.provider) throw new Error('PROVIDER_REQUIRED');
      const cfg = row(userId, input.provider);
      if (!cfg || !cfg.enabled) throw new Error('NOT_ENABLED');
      const def = getProvider(input.provider);
      if (def?.needsApiKey && !cfg.api_key_enc) throw new Error('API_KEY_REQUIRED');
      provider = input.provider;
      model = input.model ?? null;
    }
  }

  const db = getDb();
  const existing = getRoleAssignment(userId, role);
  if (existing) {
    db.prepare('UPDATE ai_role_assignments SET mode = ?, provider = ?, model = ?, shared_config_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND role = ?')
      .run(input.mode, provider, model, sharedConfigId, userId, role);
  } else {
    db.prepare('INSERT INTO ai_role_assignments (id, user_id, role, mode, provider, model, shared_config_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), userId, role, input.mode, provider, model, sharedConfigId);
  }
}
```

- [ ] **Step 8: 改 `getModelForRole` 支持共享手动钉**

把 `getModelForRole`（约 186-207）手动钉那段改为先看 `shared_config_id`：
```ts
  const a = getRoleAssignment(userId, role);
  if (a && a.mode === 'manual') {
    if (a.shared_config_id) {
      const cfg = pool.find((c) => c.ownerConfigId === a.shared_config_id);
      if (cfg) return cfg;
    } else if (a.provider) {
      const cfg = pool.find((c) => c.scope !== 'shared' && c.provider === a.provider);
      if (cfg) return { ...cfg, model: a.model || cfg.model };
    }
  }
```
（其余 auto/兜底不变。）

- [ ] **Step 9: 新增 `setShared` / `setSharedOptout` / `listSharedForUser`，并扩展 `PublicAiConfig`/`listConfigs`**

`PublicAiConfig`（约 20-27）加三字段：
```ts
  shared: number;
  shareMaxTokens: number;
  sharePeriodSeconds: number;
```
`listConfigs` 的 map 里补：
```ts
    shared: r.shared ?? 0,
    shareMaxTokens: r.share_max_tokens ?? 0,
    sharePeriodSeconds: r.share_period_seconds ?? 0,
```
新增函数（放文件末尾导出区）：
```ts
export function setShared(userId: string, provider: string, input: { shared: boolean; maxTokens?: number; periodSeconds?: number }): void {
  const cfg = row(userId, provider);
  if (!cfg) throw new Error('NOT_FOUND');
  getDb()
    .prepare('UPDATE ai_configs SET shared = ?, share_max_tokens = ?, share_period_seconds = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND provider = ?')
    .run(input.shared ? 1 : 0, Math.max(0, Math.floor(input.maxTokens ?? 0)), Math.max(0, Math.floor(input.periodSeconds ?? 0)), userId, provider);
}

export function setSharedOptout(userId: string, configId: string, enabled: boolean): void {
  const db = getDb();
  if (enabled) {
    db.prepare('DELETE FROM shared_ai_optout WHERE user_id = ? AND config_id = ?').run(userId, configId);
  } else {
    db.prepare('INSERT OR IGNORE INTO shared_ai_optout (id, user_id, config_id) VALUES (?, ?, ?)').run(uuidv4(), userId, configId);
  }
}

// 展示用：列出所有 admin 共享模型(含已超限的，标 over)，无 key。
export function listSharedForUser(userId: string, nowMs: number = Date.now()): Array<{ configId: string; provider: string; model: string; label: string; enabledForMe: boolean; quota: { cap: number; used: number; remaining: number | null; periodSeconds: number; over: boolean } }> {
  const rows = getDb()
    .prepare(`SELECT c.* FROM ai_configs c JOIN users u ON u.id = c.user_id
              WHERE u.role = 'admin' AND c.shared = 1 AND c.enabled = 1 ORDER BY c.provider`)
    .all() as AiConfigRow[];
  const out = optoutSet(userId);
  return rows
    .filter((r) => {
      const def = getProvider(r.provider);
      return def && (!def.needsApiKey || !!r.api_key_enc);
    })
    .map((r) => {
      const cap = r.share_max_tokens ?? 0;
      const period = r.share_period_seconds ?? 0;
      const used = currentConfigUsage(r.id, period, nowMs);
      return {
        configId: r.id, provider: r.provider, model: r.model, label: `共享·${r.model}`,
        enabledForMe: !out.has(r.id),
        quota: { cap, used, remaining: cap > 0 ? Math.max(0, cap - used) : null, periodSeconds: period, over: cap > 0 && used >= cap },
      };
    });
}
```

- [ ] **Step 10: 运行测试确认通过 + 回归**

Run: `cd backend && npx jest ai/sharing -i && npm test 2>&1 | tail -5`
Expected: sharing 全绿；总套件全绿（含原有 ai 测试不回归）。

- [ ] **Step 11: 提交**

```bash
git add backend/src/ai/service.ts backend/src/ai/sharing.test.ts
git commit -m "feat(ai): 共享模型解析(enabledConfigs/getModelForRole)+opt-out+配额闸门+listSharedForUser+setShared"
```

---

## Task 4: `manager.ts` — 按 key 自适应节流 + usage 记账（TDD）

**Files:** Modify `backend/src/ai/manager.ts`、Create `backend/src/ai/manager.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/ai/manager.test.ts`**

> 用 mock `global.fetch` 模拟 openai 风格响应（带 `usage.total_tokens`）与 429。`NODE_ENV=test` 下 interval=0、MAX_RETRIES=0，所以这里主要验证 usage 解析与记账；节流自适应用直接调用导出的内部 helper 测。

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mgr-'));

const { getDb } = require('../db');
const mgr = require('./manager');
const usage = require('./usage');

const CFG = 'mgrcfg';
beforeAll(() => {
  getDb().prepare("INSERT INTO ai_configs (id, user_id, provider, model, base_url, enabled, shared, share_max_tokens, share_period_seconds) VALUES (?,?,?,?,?,1,1,0,0)")
    .run(CFG, 'adm', 'deepseek', 'deepseek-chat', '', );
});

function mockFetchOnce(json: any, ok = true, status = 200, headers: Record<string, string> = {}) {
  (global as any).fetch = jest.fn(async () => ({
    ok, status, statusText: ok ? 'OK' : 'ERR',
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }));
}

afterEach(() => jest.restoreAllMocks());

describe('chat usage accounting', () => {
  it('records tokens to shared_ai_usage when account given (openai usage.total_tokens)', async () => {
    mockFetchOnce({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 42 } });
    const text = await mgr.chat('openai', { baseUrl: 'http://x', model: 'm', apiKey: 'k' }, 'p', 64, { userId: 'uZ', configId: CFG });
    expect(text).toBe('hi');
    expect(usage.currentConfigUsage(CFG, 0)).toBe(42);
  });
  it('does not record when no account', async () => {
    mockFetchOnce({ choices: [{ message: { content: 'yo' } }], usage: { total_tokens: 5 } });
    await mgr.chat('openai', { baseUrl: 'http://x', model: 'm', apiKey: 'k' }, 'p');
    expect(usage.currentConfigUsage(CFG, 0)).toBe(42); // unchanged
  });
});

describe('extractUsage', () => {
  it('openai/anthropic/ollama shapes', () => {
    expect(mgr.extractUsage('openai', { usage: { total_tokens: 10 } })).toBe(10);
    expect(mgr.extractUsage('anthropic', { usage: { input_tokens: 3, output_tokens: 4 } })).toBe(7);
    expect(mgr.extractUsage('ollama', { prompt_eval_count: 2, eval_count: 6 })).toBe(8);
    expect(mgr.extractUsage('openai', {})).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && npx jest ai/manager -i`
Expected: FAIL — `mgr.extractUsage is not a function` / 记账未发生。

- [ ] **Step 3: 改 `manager.ts` 顶部常量 + 按 key 节流结构**

把现有 `MIN_INTERVAL_MS`/`lastStart`/`chain`/`schedule`（约 16-36）替换为：
```ts
const BASE_INTERVAL_MS = IS_TEST ? 0 : Number(process.env.AI_MIN_INTERVAL_MS) || 700;
const MAX_INTERVAL_MS = IS_TEST ? 0 : Number(process.env.AI_MAX_INTERVAL_MS) || 8000;
const RELAX_STEP_MS = 150;

interface KeyState { chain: Promise<unknown>; lastStart: number; interval: number; }
const keyStates = new Map<string, KeyState>();
function keyState(id: string): KeyState {
  let st = keyStates.get(id);
  if (!st) { st = { chain: Promise.resolve(), lastStart: 0, interval: BASE_INTERVAL_MS }; keyStates.set(id, st); }
  return st;
}
function widen(id: string): void { const st = keyState(id); st.interval = Math.min(MAX_INTERVAL_MS, (st.interval || BASE_INTERVAL_MS) * 2 || 1); }
function relax(id: string): void { const st = keyState(id); st.interval = Math.max(BASE_INTERVAL_MS, st.interval - RELAX_STEP_MS); }

// 同一 key 串行 + 间隔；不同 key 各自并行。
function schedule<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const st = keyState(id);
  const run = st.chain.then(async () => {
    const wait = Math.max(0, st.lastStart + st.interval - Date.now());
    if (wait) await sleep(wait);
    st.lastStart = Date.now();
    return fn();
  });
  st.chain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

import { createHash } from 'crypto';
function keyIdOf(style: ApiStyle, config: ChatConfig): string {
  return createHash('sha256').update(`${style}|${config.baseUrl}|${config.apiKey}`).digest('hex');
}
```
> `import { createHash }` 也可移到文件顶部 import 区；放这里亦可（Node 允许）。实现时若 lint 要求 import 在顶部，移到顶部。

- [ ] **Step 4: 改 `withRetry` 接受 keyId 并自适应**

```ts
async function withRetry<T>(keyId: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await fn();
      relax(keyId);
      return r;
    } catch (e) {
      const err = e as HttpError;
      const retryable = err.status === 429 || (typeof err.status === 'number' && err.status >= 500 && err.status < 600);
      if (err.status === 429) widen(keyId);
      if (retryable && attempt < MAX_RETRIES) {
        const backoff = err.retryAfterMs ?? 600 * 2 ** attempt + Math.floor(((attempt * 137) % 300));
        await sleep(backoff);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}
```

- [ ] **Step 5: 加 `extractUsage` + 改 `send`/`chat` 解析 usage 并记账**

加导出 helper：
```ts
export function extractUsage(style: ApiStyle, data: any): number {
  try {
    if (style === 'anthropic') return (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0);
    if (style === 'ollama') return (data?.prompt_eval_count || 0) + (data?.eval_count || 0);
    return data?.usage?.total_tokens || 0;
  } catch { return 0; }
}
```
把 `send` 改为返回文本 + 原始 data（以便取 usage）。现 `send` 末尾 `return pick(data)` 改为 `return { text: pick(data), data };`，函数返回类型改 `Promise<{ text: string; data: any }>`。

`chat`（约 88-114）末尾改为：
```ts
  const keyId = keyIdOf(style, config);
  const { text, data } = await schedule(keyId, () => withRetry(keyId, () => send(url, headers, body, pick)));
  if (account) {
    try {
      const { recordSharedUsage } = require('./usage');
      recordSharedUsage(account.configId, account.userId, extractUsage(style, data));
    } catch { /* 记账失败绝不影响聊天 */ }
  }
  return text;
```
并把 `chat` 签名改为：
```ts
export async function chat(style: ApiStyle, config: ChatConfig, prompt: string, maxTokens = 64, account?: { userId: string; configId: string }): Promise<string> {
```

- [ ] **Step 6: 运行测试确认通过 + 回归**

Run: `cd backend && npx jest ai/manager -i && npm test 2>&1 | tail -5`
Expected: manager 全绿；总套件不回归（节流泛化对单 key 行为等价）。

- [ ] **Step 7: 提交**

```bash
git add backend/src/ai/manager.ts backend/src/ai/manager.test.ts
git commit -m "feat(ai): 按key自适应节流(AIMD防429)+usage解析+chat account记账"
```

---

## Task 5: 调用方透传 `account`（共享模型用量归因）

**Files:** Modify（各文件里调用 `chat(...)` 之处）：`backend/src/analysis/orchestrator.ts`、`backend/src/chat/service.ts`、`backend/src/meetings/service.ts`、`backend/src/screen/service.ts`、`backend/src/rulebook/propose-service.ts`、`backend/src/rulebook/memory.ts`、`backend/src/agent/profiles-service.ts`

- [ ] **Step 1: 对每个文件，定位用「角色解析出的 cfg」调用 `chat(` 的地方，加 account 末参**

模式（每处统一改）：在拿到 `cfg = getModelForRole(userId, role) || getModelForRole(userId, 'core')` 之后、调用 `chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, maxTokens)` 处，改为：
```ts
const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
const raw = await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, maxTokens, acct);
```
逐文件先 `Read` 该 `chat(` 调用确认变量名（`cfg`/`userId` 可能叫别的，如 meetings 的 `aiCall` 闭包里），按实际变量名套用同样的「scope==='shared' 时传 {userId, configId: ownerConfigId}」。**自有模型 cfg.scope 非 'shared' → acct=undefined → 行为不变。**

> 注：部分服务把 chat 包在 `defaultAiCall(userId, prompt)` 里——改那一个内部 chat 调用即可，userId 在闭包可见。

- [ ] **Step 2: 编译 + 全量回归**

Run: `cd backend && npx tsc --noEmit && npm test 2>&1 | tail -5`
Expected: tsc 0；测试全绿（这些改动 additive，不影响既有用例——它们用自有模型，acct=undefined）。

- [ ] **Step 3: 提交**

```bash
git add backend/src/analysis/orchestrator.ts backend/src/chat/service.ts backend/src/meetings/service.ts backend/src/screen/service.ts backend/src/rulebook/propose-service.ts backend/src/rulebook/memory.ts backend/src/agent/profiles-service.ts
git commit -m "feat(ai): 各调用方在用共享模型时透传 account 以记账"
```

---

## Task 6: 路由 `routes/ai.ts`（TDD）

**Files:** Modify `backend/src/routes/ai.ts`、`backend/src/routes/ai.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `ai.test.ts`）

> 参照该测试现有 setup（admin token + 普通用户 token）。若现无普通用户，仿 `routes/data.test.ts` 的 invite→register 造一个 `uh()`。

```ts
describe('shared models', () => {
  it('non-admin cannot toggle share', async () => {
    const r = await request(app).post('/api/ai/configs/deepseek/share').set(uh()).send({ shared: true });
    expect(r.status).toBe(403);
  });
  it('admin shares own config with quota; GET /ai/shared exposes no key', async () => {
    // admin 先存一个 deepseek 配置
    await request(app).put('/api/ai/configs/deepseek').set(h()).send({ apiKey: 'sk-abc12345', baseUrl: '', model: 'deepseek-chat' });
    const sh = await request(app).post('/api/ai/configs/deepseek/share').set(h()).send({ shared: true, maxTokens: 1000, periodSeconds: 18000 });
    expect(sh.status).toBe(200);
    const list = await request(app).get('/api/ai/shared').set(uh());
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body.data)).not.toMatch(/sk-abc/); // 无 key
    expect(list.body.data[0]).toMatchObject({ provider: 'deepseek' });
  });
  it('user opt-out toggle works', async () => {
    const cfgId = (await request(app).get('/api/ai/shared').set(uh())).body.data[0].configId;
    expect((await request(app).post(`/api/ai/shared/${cfgId}/enable`).set(uh()).send({ enabled: false })).status).toBe(200);
  });
  it('usage endpoint is admin+owner only', async () => {
    const cfgId = (await request(app).get('/api/ai/shared').set(uh())).body.data[0].configId;
    expect((await request(app).get(`/api/ai/shared/${cfgId}/usage`).set(uh())).status).toBe(403);
    expect((await request(app).get(`/api/ai/shared/${cfgId}/usage`).set(h())).status).toBe(200);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend && npx jest routes/ai -i -t "shared models"`
Expected: FAIL（路由 404/无鉴权）。

- [ ] **Step 3: 加 import + 路由**

`routes/ai.ts` 顶部 import 加 `adminMiddleware`：
```ts
import { authMiddleware, adminMiddleware } from '../middleware/auth';
```
在角色路由附近、`export default router` 之前加：
```ts
import { getUsageForConfig, resetConfigUsage } from '../ai/usage';

// admin：切共享 + 配额
router.post('/configs/:provider/share', adminMiddleware, (req: Request, res: Response) => {
  const parsed = z.object({ shared: z.boolean(), maxTokens: z.number().int().min(0).optional(), periodSeconds: z.number().int().min(0).optional() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    svc.setShared(req.user!.userId, req.params.provider, parsed.data);
    successResponse(res, null, parsed.data.shared ? '已共享' : '已取消共享');
  } catch (e: any) {
    if (e.message === 'NOT_FOUND') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '请先配置该模型再共享');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '操作失败');
  }
});

// admin：查看某共享模型用量（仅 owner）
function ownShared(req: Request, res: Response): { id: string; provider: string; share_period_seconds: number } | null {
  const r = require('../db').getDb().prepare('SELECT id, provider, share_period_seconds FROM ai_configs WHERE id = ? AND user_id = ?').get(req.params.configId, req.user!.userId) as any;
  if (!r) { errorResponse(res, 403, 'AUTH_FORBIDDEN', '无权访问'); return null; }
  return r;
}
router.get('/shared/:configId/usage', adminMiddleware, (req: Request, res: Response) => {
  const cfg = ownShared(req, res); if (!cfg) return;
  const rows = getUsageForConfig(cfg.id, cfg.share_period_seconds);
  const total = rows.reduce((s, r) => s + r.total_tokens, 0);
  successResponse(res, { total, periodSeconds: cfg.share_period_seconds, rows });
});
router.post('/shared/:configId/reset-usage', adminMiddleware, (req: Request, res: Response) => {
  const cfg = ownShared(req, res); if (!cfg) return;
  resetConfigUsage(cfg.id);
  successResponse(res, null, '已清零');
});

// 所有用户：看共享模型 + opt-out
router.get('/shared', (req: Request, res: Response) => {
  successResponse(res, svc.listSharedForUser(req.user!.userId));
});
router.post('/shared/:configId/enable', (req: Request, res: Response) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  svc.setSharedOptout(req.user!.userId, req.params.configId, parsed.data.enabled);
  successResponse(res, null, parsed.data.enabled ? '已启用' : '已停用');
});
```

- [ ] **Step 4: 角色路由支持 `sharedConfigId`**

`PUT /roles/:role` 的 `roleSchema` 加可选 `sharedConfigId: z.string().optional()`（找到 `roleSchema` 定义补上）。其处理已透传 `parsed.data` 给 `svc.setRoleAssignment`，service 已支持。错误映射已含 NOT_ENABLED。

- [ ] **Step 5: 运行测试确认通过 + 回归**

Run: `cd backend && npx jest routes/ai -i && npm test 2>&1 | tail -5`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add backend/src/routes/ai.ts backend/src/routes/ai.test.ts
git commit -m "feat(api): /ai/configs/:p/share, /ai/shared(+enable), /ai/shared/:id/usage|reset-usage, 角色钉共享"
```

---

## Task 7: 账号导出/清空纳入 opt-out

**Files:** Modify `backend/src/account/service.ts`

- [ ] **Step 1: 把 `shared_ai_optout` 加进 `PER_USER_TABLES`**

找到 `PER_USER_TABLES` 数组，加一行 `'shared_ai_optout',`（与 `ai_configs` 等并列）。

- [ ] **Step 2: 回归**

Run: `cd backend && npm test 2>&1 | tail -4`
Expected: 全绿（account 测试若断言表清单需同步——按测试报错更新）。

- [ ] **Step 3: 提交**

```bash
git add backend/src/account/service.ts
git commit -m "feat(account): shared_ai_optout 纳入 per-user 导出/清空"
```

---

## Task 8: 前端 `api/ai.ts`

**Files:** Modify `frontend/src/api/ai.ts`

- [ ] **Step 1: 加类型 + 方法**

`AiConfig` 接口加：
```ts
  shared?: number;
  shareMaxTokens?: number;
  sharePeriodSeconds?: number;
```
新增类型：
```ts
export interface Quota { cap: number; used: number; remaining: number | null; periodSeconds: number; over: boolean }
export interface SharedModel { configId: string; provider: string; model: string; label: string; enabledForMe: boolean; quota: Quota }
```
`aiApi` 对象加：
```ts
  setShared: (provider: string, body: { shared: boolean; maxTokens?: number; periodSeconds?: number }) => api.post(`/ai/configs/${provider}/share`, body),
  getShared: () => api.get<{ data: SharedModel[] }>('/ai/shared'),
  setSharedEnabled: (configId: string, enabled: boolean) => api.post(`/ai/shared/${configId}/enable`, { enabled }),
  getSharedUsage: (configId: string) => api.get<{ data: { total: number; periodSeconds: number; rows: Array<{ userId: string; username: string; calls: number; total_tokens: number }> } }>(`/ai/shared/${configId}/usage`),
  resetSharedUsage: (configId: string) => api.post(`/ai/shared/${configId}/reset-usage`),
```
`setRole` 的 body 类型加可选 `sharedConfigId?: string | null`。

- [ ] **Step 2: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/api/ai.ts
git commit -m "feat(api): aiApi 共享模型(setShared/getShared/enable/usage/reset)+类型"
```

---

## Task 9: 前端 `AiSettingsView.vue`

**Files:** Modify `frontend/src/views/AiSettingsView.vue`

- [ ] **Step 1: script 加 isAdmin + 共享状态 + 加载**

`<script setup>` import 区加：
```ts
import { useAuthStore } from '../stores/auth';
import type { SharedModel } from '../api/ai';
```
state 区加：
```ts
const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);
const shared = ref<SharedModel[]>([]);
const shareForm = reactive<Record<string, { maxTokens: number; periodValue: number; periodUnit: 'none' | 'hour' | 'day' | 'week' }>>({});
const usageOpen = ref<string | null>(null);
const usageRows = ref<Array<{ username: string; calls: number; total_tokens: number }>>([]);
const usageTotal = ref(0);

function periodToSeconds(v: number, unit: string): number {
  if (unit === 'none' || !v) return 0;
  const mult: Record<string, number> = { hour: 3600, day: 86400, week: 604800 };
  return Math.floor(v * (mult[unit] || 0));
}
```
`reload()` 末尾加：`shared.value = (await aiApi.getShared()).data.data;`

- [ ] **Step 2: script 加 共享/配额/用量 方法**

```ts
async function toggleShare(c: AiConfig, on: boolean) {
  const f = shareForm[c.provider] || { maxTokens: c.shareMaxTokens || 0, periodValue: 0, periodUnit: 'none' as const };
  await aiApi.setShared(c.provider, { shared: on, maxTokens: f.maxTokens, periodSeconds: periodToSeconds(f.periodValue, f.periodUnit) });
  await reload();
}
async function saveShareQuota(c: AiConfig) {
  const f = shareForm[c.provider];
  await aiApi.setShared(c.provider, { shared: true, maxTokens: f.maxTokens, periodSeconds: periodToSeconds(f.periodValue, f.periodUnit) });
  await reload();
}
async function openUsage(c: AiConfig) {
  const cfgId = shared.value.find((s) => s.provider === c.provider)?.configId;
  if (!cfgId) return;
  usageOpen.value = cfgId;
  const d = (await aiApi.getSharedUsage(cfgId)).data.data;
  usageRows.value = d.rows; usageTotal.value = d.total;
}
async function resetUsage() {
  if (!usageOpen.value) return;
  await aiApi.resetSharedUsage(usageOpen.value);
  await openUsageById(usageOpen.value);
}
async function openUsageById(cfgId: string) {
  const d = (await aiApi.getSharedUsage(cfgId)).data.data;
  usageRows.value = d.rows; usageTotal.value = d.total;
}
async function toggleSharedEnabled(m: SharedModel) {
  await aiApi.setSharedEnabled(m.configId, !m.enabledForMe);
  await reload();
}
```
并在 script 里初始化 `shareForm`（reload 后，对每个 config）：在 reload() 里 `shared.value=...` 之后加：
```ts
  for (const c of configs.value) {
    if (!shareForm[c.provider]) shareForm[c.provider] = { maxTokens: c.shareMaxTokens || 0, periodValue: 0, periodUnit: 'none' };
  }
```

- [ ] **Step 3: 模板 — admin 在「已配置的模型」表加共享列/配额**

在 Models tab 的已配置表 `<tr v-for="c in configs">` 里、删除按钮那格之后（或新增一格），加 admin-only 共享控件。最简：在该 section 下方加一个 admin-only 卡：
```vue
      <section class="card" v-if="isAdmin && configs.length">
        <h2>共享给所有用户</h2>
        <p class="hint">勾选后，所有用户都能用你这个模型（走你的 Key，他们看不到 Key）。可设每窗口 token 上限与重置周期，超限对所有人暂停到下个周期。</p>
        <div v-for="c in configs" :key="c.provider" class="share-row">
          <label><input type="checkbox" :checked="(c.shared || 0) === 1" @change="toggleShare(c, ($event.target as HTMLInputElement).checked)" /> {{ providerLabel(c.provider) }} · {{ c.model }}</label>
          <template v-if="(c.shared || 0) === 1 && shareForm[c.provider]">
            上限 <input type="number" v-model.number="shareForm[c.provider].maxTokens" style="width:90px" /> tokens
            重置 <input type="number" v-model.number="shareForm[c.provider].periodValue" style="width:60px" />
            <select v-model="shareForm[c.provider].periodUnit">
              <option value="none">不重置</option><option value="hour">小时</option><option value="day">天</option><option value="week">周</option>
            </select>
            <button @click="saveShareQuota(c)">保存配额</button>
            <button @click="openUsage(c)">查看使用情况</button>
          </template>
        </div>
        <div v-if="usageOpen" class="usage">
          <p>本窗口合计：<b>{{ usageTotal }}</b> tokens <button @click="resetUsage">清零用量</button></p>
          <table><thead><tr><th>用户</th><th>调用</th><th>tokens</th></tr></thead>
            <tbody><tr v-for="r in usageRows" :key="r.username"><td>{{ r.username }}</td><td>{{ r.calls }}</td><td>{{ r.total_tokens }}</td></tr></tbody>
          </table>
        </div>
      </section>
```

- [ ] **Step 4: 模板 — 所有用户「管理员共享的模型」区**

在 Models tab 末尾加：
```vue
      <section class="card" v-if="shared.length">
        <h2>管理员共享的模型</h2>
        <p class="hint">这些是管理员共享的模型，你可直接用（看不到也改不了 Key），也可与自己的模型一起用。</p>
        <table>
          <thead><tr><th>启用</th><th>模型</th><th>本周期额度</th></tr></thead>
          <tbody>
            <tr v-for="m in shared" :key="m.configId">
              <td><input type="checkbox" :checked="m.enabledForMe" @change="toggleSharedEnabled(m)" /></td>
              <td><span class="badge">共享</span> {{ providerLabel(m.provider) }} · {{ m.model }}</td>
              <td>
                <span v-if="m.quota.cap > 0" :class="{ err: m.quota.over }">
                  {{ m.quota.used }} / {{ m.quota.cap }}（剩 {{ m.quota.remaining }}）
                  <em v-if="m.quota.over">· 本周期已用完，已暂停，下个周期恢复</em>
                </span>
                <span v-else class="muted">不限</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
```

- [ ] **Step 5: 任务分工下拉并入共享模型**

`modelOptions` computed 改为也包含共享模型（值用 `shared:<configId>`）：在其 `return out;` 之前加：
```ts
  for (const m of shared.value.filter((s) => s.enabledForMe)) {
    out.push({ key: `shared:${m.configId}`, provider: m.provider, model: m.model, label: m.label });
  }
```
`onRoleChange` 解析 value 时区分共享：找到把 `key`（形如 `provider|model` 或 `__auto__`）转成 setRole body 的地方，改为：
```ts
  // value 形如 'shared:<id>' | 'provider|model' | '__auto__'
  if (value === '__auto__') return aiApi.setRole(r.role, { mode: 'auto' });
  if (value.startsWith('shared:')) return aiApi.setRole(r.role, { mode: 'manual', sharedConfigId: value.slice(7) });
  const [provider, model] = value.split('|');
  return aiApi.setRole(r.role, { mode: 'manual', provider, model });
```
（按实际 `onRoleChange` 现有结构套用；保留其 await/reload/提示逻辑。）`roleValue(r)` 也要能回显共享：若 `r.pinnedProvider` 为空但分工指向共享……当前 RoleAssignment 类型没带 sharedConfigId 回显——**够用即可**：共享钉选后 `resolvedModel` 仍会显示实际模型，下拉回显可暂以 resolved 匹配；如需精确回显，可在 `listRoleAssignments` 返回 `sharedConfigId`（可选增强，不在本步必须）。

- [ ] **Step 6: 样式（`<style scoped>` 末尾，若无）**

```css
.badge { background: var(--accent, #2a8a2a); color: #fff; border-radius: 4px; padding: 0 6px; font-size: 12px; }
.share-row { padding: 6px 0; border-bottom: 1px solid #eee; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.usage { margin-top: 10px; }
```

- [ ] **Step 7: 类型检查**

Run: `cd frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/views/AiSettingsView.vue
git commit -m "feat(ai-ui): admin 共享/配额/用量 + 用户共享模型区 + 任务分工纳入共享"
```

---

## 端到端验证（实现完成后）

1. `cd backend && npm test` → 全绿（241 + 新增）。
2. `cd frontend && npx vue-tsc --noEmit` → exit 0。
3. `docker compose up -d --build`，浏览器：
   - admin 在 AI 模型页把某模型「共享」+ 设上限/周期；普通用户登录 → AI 模型页见「管理员共享的模型」（无 Key），默认开，可关；任务分工可选共享模型。
   - 普通用户用共享模型聊天/分析 → admin 的「查看使用情况」出现该用户 token；累计到上限后该共享模型对所有人暂停（用户回退到自有模型），下个窗口恢复。
   - 多人并发：观察不再频繁 429（按 key 自适应节流）。

## 风险 / 注意
- 共享模型用 admin 的 key（admin 额度/费用）——默认开是产品取向，admin 勾选即知情。
- 节流是**按 key 泛化**，单 key 行为与今天等价；`IS_TEST` 下 interval=0、MAX_RETRIES=0 不拖慢测试。
- 记账 try/catch 包裹，绝不影响聊天主流程。
- Task 5 的 7 处改动需逐文件 Read 确认变量名后套用统一模式（self 模型 acct=undefined 不变行为）。
- 改共享模型周期后旧用量行 window 不匹配→该模型用量视作归零（可接受）。
