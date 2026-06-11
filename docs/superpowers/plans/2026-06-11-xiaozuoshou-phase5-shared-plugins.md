# 小作手 1.0 · 阶段⑤ G：能力插件共享 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** admin 可把自己的能力插件「共享给所有用户」；普通用户能看到管理员共享的插件、只能开/关使用(写 opt-out)，**看不到也改不了其配置**；用户仍可加/管自己的插件。完全复用「共享 AI 模型」那套模式。

**Architecture:** `plugins` 表加 `shared` 列(admin 行标记共享)；新表 `shared_plugin_optout(user_id, plugin_key)`(默认开、只存停用)。`plugins/service.ts` 加 `sharedPlugins()`(JOIN users role=admin)、`setShared`、`setSharedEnabled`/opt-out、`listSharedForUser`(配置隐藏)、`getEnabledCapabilities` 并入未停用的共享插件(用 admin 真实 config，仅服务端)。路由：admin 共享开关 + 用户 opt-in/out + GET 合并(共享项不含 config)。前端 `PluginsView`：admin 每个自定义插件加「共享」勾选；用户新增「管理员共享的插件」区(只读 + 启用开关)。

**Tech Stack:** Express/TS + jest(后端,Phase4 自测 76 绿) + Vue 3。

参照 spec：`docs/superpowers/specs/2026-06-10-xiaozuoshou-1.0-design.md` G 节；复用先例：`backend/src/ai/service.ts`(`sharedConfigs`/`shared_ai_optout`/`optoutSet`)。

**设计要点/取舍：**
- 共享对**自定义插件**有意义；内置插件每个用户本就有(`CATALOG`)，所以共享内置对用户是 no-op——`listSharedForUser`/`getEnabledCapabilities` 用「用户已拥有的 key(全部 catalog key + 用户自有 custom key)」过滤掉重复，admin 标记内置共享不会给用户重复项。前端「共享」勾选只对 `source==='custom'` 显示。
- 共享项对用户**永不返回 config 明文**(MCP 含密钥)；只给 `configured` 布尔。
- admin 自己的 `getEnabledCapabilities` 不会因 `sharedPlugins()` 含自己的行而重复(被「用户已拥有 key」过滤)。

---

## 数据结构 / PluginView 扩展

`PluginView`(后端 `plugins/service.ts` 与前端 `api/plugins.ts` 同步)新增：
```ts
  shared?: boolean;        // true=该项是「管理员共享」给当前(非 admin)用户的插件
  owner?: 'me' | 'admin';  // me=自己的插件；admin=管理员共享
  sharedByMe?: boolean;    // 自己的插件：是否已被(admin)共享出去
  configured?: boolean;    // 共享项：admin 是否配了非空 config(值不返回)
```

## 文件结构

- Modify `backend/src/db.ts` — `plugins.shared` 列 + `shared_plugin_optout` 表(migrate)
- Modify `backend/src/plugins/service.ts` — 共享相关函数 + PluginView 字段 + getEnabledCapabilities 合并
- Create `backend/src/plugins/service.test.ts` — service 单测
- Modify `backend/src/routes/plugins.ts` — share / shared-enable 路由 + GET 合并
- Modify `backend/src/routes/plugins.test.ts` — 路由鉴权/行为测试
- Modify `frontend/src/api/plugins.ts` — PluginView 字段 + `share`/`setSharedEnabled`
- Modify `frontend/src/views/PluginsView.vue` — admin 共享勾选 + 用户共享区

---

## Task 1: db — plugins.shared 列 + shared_plugin_optout 表

**Files:** Modify `backend/src/db.ts`

- [ ] **Step 1: 在 `migrate()` 内、`shared_ai_optout` 建表附近(约 line 439)加**

```ts
  const plCols = db.prepare("PRAGMA table_info('plugins')").all() as { name: string }[];
  if (plCols.length && !plCols.some((c) => c.name === 'shared')) {
    db.exec('ALTER TABLE plugins ADD COLUMN shared INTEGER DEFAULT 0');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS shared_plugin_optout (
    user_id TEXT NOT NULL,
    plugin_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, plugin_key)
  )`);
```
> 先 Read `migrate()` 确认 `db` 变量名与 `shared_ai_optout` 块位置，紧邻其后插入，保持风格一致。

- [ ] **Step 2: 编译检查** — `cd ~/projects/stock-agent/backend && npx tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/db.ts
git commit -m "feat(db): plugins.shared 列 + shared_plugin_optout 表(能力插件共享)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端 service — 共享逻辑（TDD）

**Files:** Modify `backend/src/plugins/service.ts`；Create `backend/src/plugins/service.test.ts`

- [ ] **Step 1: 写失败测试 `backend/src/plugins/service.test.ts`**

```ts
import path from 'path';
import os from 'os';
import fs from 'fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-plugsvc-'));

const { getDb } = require('../db');
const svc = require('./service');

const ADMIN = 'admin-uid';
const USER = 'user-uid';

beforeAll(() => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'adm', 'x', 'admin')").run(ADMIN);
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, 'usr', 'x', 'user')").run(USER);
});
beforeEach(() => {
  getDb().exec('DELETE FROM plugins; DELETE FROM shared_plugin_optout;');
});

describe('shared plugins', () => {
  function adminSharesMcp() {
    svc.addCustom(ADMIN, { key: 'mymcp', label: '管理员MCP', kind: 'mcp', transport: 'http', config: { url: 'http://secret' } });
    svc.setShared(ADMIN, 'mymcp', true);
  }

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
    svc.setSharedEnabled(USER, 'mymcp', true); // 重新启用
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
```
> 先确认 `users` 表列名(`password_hash`、`role`)与 INSERT 匹配——Read db.ts 的 users 建表(约 line 27)。若列名不同，改 seed INSERT。

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest plugins/service -i`。Expected: FAIL（`sharedPlugins is not a function` 等）。

- [ ] **Step 3: 实现**（`backend/src/plugins/service.ts`）

3a. `PluginRow` 接口加 `shared?: number;`（在 `enabled: number;` 后）。
3b. `PluginView` 接口加：
```ts
  shared?: boolean;
  owner?: 'me' | 'admin';
  sharedByMe?: boolean;
  configured?: boolean;
```
3c. `listForUser` 的 builtins/customs 两处 map，各加字段：内置 `owner: 'me'`, `shared: false`, `sharedByMe: r ? !!r.shared : false`；自定义 `owner: 'me'`, `shared: false`, `sharedByMe: !!r.shared`。
3d. 在文件末尾追加共享相关函数：
```ts
// ---- 共享(admin → 用户) ----

// 用户「已拥有」的 key：全部内置 catalog key + 用户自有 custom key。
// 共享项凡命中这些 key 的都跳过(内置人人都有；同名 custom 用户自己的优先)。
function userOwnKeys(userId: string): Set<string> {
  const customs = getDb()
    .prepare("SELECT plugin_key FROM plugins WHERE user_id = ? AND source = 'custom'")
    .all(userId) as { plugin_key: string }[];
  return new Set<string>([...CATALOG.map((d) => d.key), ...customs.map((r) => r.plugin_key)]);
}

function sharedOptoutSet(userId: string): Set<string> {
  const rows = getDb().prepare('SELECT plugin_key FROM shared_plugin_optout WHERE user_id = ?').all(userId) as { plugin_key: string }[];
  return new Set(rows.map((r) => r.plugin_key));
}

export interface SharedPlugin {
  key: string;
  kind: PluginKind;
  label: string;
  transport: Transport | null;
  config: Record<string, unknown>;
}

// admin 已共享且启用的插件(含真实 config，仅服务端用)
export function sharedPlugins(): SharedPlugin[] {
  const rows = getDb()
    .prepare(`SELECT p.* FROM plugins p JOIN users u ON p.user_id = u.id
              WHERE u.role = 'admin' AND p.shared = 1 AND p.enabled = 1`)
    .all() as PluginRow[];
  return rows.map((r) => ({
    key: r.plugin_key,
    kind: r.kind,
    label: r.label || r.plugin_key,
    transport: r.transport,
    config: parse(r.config),
  }));
}

// admin 切换自己某插件的共享位(内置无行时先建行，仿 setEnabled)
export function setShared(adminUserId: string, key: string, shared: boolean): void {
  const def = getCatalogPlugin(key);
  const existing = rowFor(adminUserId, key);
  const db = getDb();
  if (existing) {
    db.prepare('UPDATE plugins SET shared = ? WHERE id = ?').run(shared ? 1 : 0, existing.id);
  } else if (def) {
    db.prepare(
      'INSERT INTO plugins (id, user_id, plugin_key, kind, label, source, transport, config, enabled, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
    ).run(uuidv4(), adminUserId, key, def.kind, def.label, 'builtin', def.transport ?? null, JSON.stringify(def.defaultConfig), shared ? 1 : 0);
  } else {
    throw new Error('UNKNOWN_PLUGIN');
  }
}

// 用户对某共享插件 opt-in/out(默认开；停用才写行)
export function setSharedEnabled(userId: string, key: string, enabled: boolean): void {
  const db = getDb();
  if (enabled) {
    db.prepare('DELETE FROM shared_plugin_optout WHERE user_id = ? AND plugin_key = ?').run(userId, key);
  } else {
    db.prepare('INSERT OR IGNORE INTO shared_plugin_optout (user_id, plugin_key) VALUES (?, ?)').run(userId, key);
  }
}

// 管理员共享给该用户的插件视图(隐藏 config，仅给 configured 标记)
export function listSharedForUser(userId: string): PluginView[] {
  const own = userOwnKeys(userId);
  const optout = sharedOptoutSet(userId);
  return sharedPlugins()
    .filter((sp) => !own.has(sp.key))
    .map((sp) => ({
      key: sp.key,
      kind: sp.kind,
      label: sp.label,
      description: '管理员共享的插件',
      recommended: false,
      source: 'custom' as const,
      transport: sp.transport,
      enabled: !optout.has(sp.key),
      config: {},
      shared: true,
      owner: 'admin' as const,
      configured: Object.keys(sp.config || {}).length > 0,
    }));
}
```
3e. 把现有 `getEnabledCapabilities` 替换为合并共享版：
```ts
export function getEnabledCapabilities(userId: string): EnabledCapabilities {
  const enabled = listForUser(userId).filter((p) => p.enabled);
  const mcp = enabled.filter((p) => p.kind === 'mcp').map((p) => ({ key: p.key, label: p.label, transport: p.transport, config: p.config }));
  const skills = enabled.filter((p) => p.kind === 'skill').map((p) => ({ key: p.key, label: p.label, config: p.config }));
  // 并入未停用、且不与用户已拥有 key 重复的 admin 共享插件(用真实 config)
  const own = userOwnKeys(userId);
  const optout = sharedOptoutSet(userId);
  for (const sp of sharedPlugins()) {
    if (own.has(sp.key) || optout.has(sp.key)) continue;
    if (sp.kind === 'mcp') mcp.push({ key: sp.key, label: sp.label, transport: sp.transport, config: sp.config });
    else skills.push({ key: sp.key, label: sp.label, config: sp.config });
  }
  return { mcp, skills };
}
```

- [ ] **Step 4: 运行确认通过** — `cd ~/projects/stock-agent/backend && npx jest plugins/service -i`。Expected: PASS(6 例)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/plugins/service.ts backend/src/plugins/service.test.ts
git commit -m "feat(plugins): 能力插件共享 service(sharedPlugins/setShared/opt-out/合并能力，config 不外泄)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端路由 — share / shared-enable + GET 合并（TDD）

**Files:** Modify `backend/src/routes/plugins.ts`、`backend/src/routes/plugins.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `plugins.test.ts`；先读文件确认 admin/user token 辅助名——预期 `h()`=admin、`uh()`=user，与 data.test 一致；若不同则适配）

```ts
describe('shared plugins routes', () => {
  it('admin 才能共享：用户 403、admin 200', async () => {
    await request(app).post('/api/plugins/custom').set(h()).send({ key: 'shmcp', label: '共享MCP', kind: 'mcp', transport: 'http', config: { url: 'http://x' } });
    const u = await request(app).post('/api/plugins/shmcp/share').set(uh()).send({ shared: true });
    expect(u.status).toBe(403);
    const a = await request(app).post('/api/plugins/shmcp/share').set(h()).send({ shared: true });
    expect(a.status).toBe(200);
  });

  it('GET /plugins 给用户返回共享项且无 config', async () => {
    const res = await request(app).get('/api/plugins').set(uh());
    const m = res.body.data.find((p: any) => p.key === 'shmcp');
    expect(m).toMatchObject({ shared: true, owner: 'admin' });
    expect(m.config).toEqual({});
  });

  it('用户可 opt-out 共享插件', async () => {
    const off = await request(app).post('/api/plugins/shared/shmcp/enable').set(uh()).send({ enabled: false });
    expect(off.status).toBe(200);
    const res = await request(app).get('/api/plugins').set(uh());
    expect(res.body.data.find((p: any) => p.key === 'shmcp').enabled).toBe(false);
  });
});
```
> 这些用例有先后依赖(同一 describe 内顺序执行：admin 先建并共享 shmcp，后续用例才能看到)。若该测试文件用每例独立 DB/清理，请把建插件+共享放进每个用例或一个 `beforeAll`。读文件确认其隔离方式后适配。

- [ ] **Step 2: 运行确认失败** — `cd ~/projects/stock-agent/backend && npx jest routes/plugins -i -t "shared"`。Expected: FAIL（share 路由 404 / GET 无共享项）。

- [ ] **Step 3: 实现路由**（`backend/src/routes/plugins.ts`）

3a. 顶部 import 加 `adminMiddleware`：
```ts
import { authMiddleware, adminMiddleware } from '../middleware/auth';
```
3b. 改 GET `/` 返回 own + shared 合并：
```ts
router.get('/', (req: Request, res: Response) => {
  const uid = req.user!.userId;
  successResponse(res, [...svc.listForUser(uid), ...svc.listSharedForUser(uid)]);
});
```
3c. 在 `/:key/enable` 路由附近加两个路由(注意：`/shared/:key/enable` 是 3 段，与 `/:key/enable` 2 段不冲突；`/:key/share` 与 `/:key/enable` 末段不同，也不冲突)：
```ts
// admin 共享/取消共享自己的插件
router.post('/:key/share', adminMiddleware, (req: Request, res: Response) => {
  const parsed = z.object({ shared: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    svc.setShared(req.user!.userId, req.params.key, parsed.data.shared);
    successResponse(res, null, parsed.data.shared ? '已共享给所有用户' : '已取消共享');
  } catch (e: any) {
    if (e.message === 'UNKNOWN_PLUGIN') return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '未知插件');
    return errorResponse(res, 400, 'BUSINESS_CONFLICT', e.message || '操作失败');
  }
});

// 用户对管理员共享插件 opt-in/out
router.post('/shared/:key/enable', (req: Request, res: Response) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  svc.setSharedEnabled(req.user!.userId, req.params.key, parsed.data.enabled);
  successResponse(res, null, parsed.data.enabled ? '已启用' : '已停用');
});
```

- [ ] **Step 4: 运行确认通过 + 全量回归** — `cd ~/projects/stock-agent/backend && npx jest routes/plugins -i` 然后 `npm test`。Expected: 路由测试全绿；全量回归(注：`chat/service`、`meetings/service` 真连 live sidecar 的用例可能间歇超时，属既有 flaky，与本改动无关——`plugins`/`data/service` 等本批相关套件应稳定绿)。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/routes/plugins.ts backend/src/routes/plugins.test.ts
git commit -m "feat(api): 插件共享路由(admin /:key/share + 用户 /shared/:key/enable)+ GET 合并共享项

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前端 — admin 共享勾选 + 用户共享区

**Files:** Modify `frontend/src/api/plugins.ts`、`frontend/src/views/PluginsView.vue`

- [ ] **Step 1: api/plugins.ts — 类型 + 方法**

`PluginView` 接口加(与后端对齐)：
```ts
  shared?: boolean;
  owner?: 'me' | 'admin';
  sharedByMe?: boolean;
  configured?: boolean;
```
`pluginsApi` 加：
```ts
  share: (key: string, shared: boolean) => api.post(`/plugins/${key}/share`, { shared }),
  setSharedEnabled: (key: string, enabled: boolean) => api.post(`/plugins/shared/${key}/enable`, { enabled }),
```

- [ ] **Step 2: 类型检查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 3: PluginsView.vue — admin 共享勾选**

3a. `<script setup>` 顶部加：`import { useAuthStore } from '../stores/auth';` 与 `const auth = useAuthStore();`。
3b. `PluginCard` 组件加 `isAdmin` prop 与 `share` emit：
   - props 改为 `{ p: {...}, isAdmin: { type: Boolean, default: false } }`；`emits` 加 `'share'`。
   - 在 `phead` 的 `pops` 里(配置/删除按钮旁)，当 `props.isAdmin && props.p.source === 'custom'` 时加共享勾选：
     ```ts
     props.isAdmin && props.p.source === 'custom'
       ? h('label', { class: 'sharebox' }, [
           h('input', { type: 'checkbox', checked: !!props.p.sharedByMe, onChange: (e: any) => emit('share', props.p, e.target.checked) }),
           ' 共享',
         ])
       : null,
     ```
3c. own 卡片传 `:isAdmin="auth.isAdmin"`：把 `mcps`/`skills` 两处 `<PluginCard ... />` 加 `:isAdmin="auth.isAdmin"` 与 `@share="share"`。
3d. 加 `share` 方法：
```ts
async function share(p: PluginView, shared: boolean) {
  await pluginsApi.share(p.key, shared);
  await reload();
}
```

- [ ] **Step 4: PluginsView.vue — 用户「管理员共享的插件」区**

4a. `mcps`/`skills` 改为只看自己的(排除共享项)：
```ts
const mcps = computed(() => list.value.filter((p) => p.kind === 'mcp' && !p.shared));
const skills = computed(() => list.value.filter((p) => p.kind === 'skill' && !p.shared));
const sharedFromAdmin = computed(() => list.value.filter((p) => p.shared));
```
4b. 在「添加自定义插件」card 之前插入共享区(仅有共享项时显示)：
```vue
    <section v-if="sharedFromAdmin.length" class="card">
      <h2>管理员共享的插件</h2>
      <p class="hint">由管理员配置并共享，你只能选择是否启用，无法查看或修改其配置。</p>
      <div v-for="p in sharedFromAdmin" :key="p.key" class="pcard">
        <div class="phead">
          <label class="pname">
            <input type="checkbox" :checked="p.enabled" @change="toggle(p, ($event.target as HTMLInputElement).checked)" />
            {{ p.label }}
            <span class="tag">{{ p.kind }}</span>
            <span v-if="p.transport" class="tag">{{ p.transport }}</span>
            <span v-if="p.configured" class="tag cust">已配置</span>
          </label>
        </div>
        <div class="pdesc">{{ p.description }}</div>
      </div>
    </section>
```
4c. `toggle` 分流(共享项走 opt-out 接口)：
```ts
async function toggle(p: PluginView, enabled: boolean) {
  if (p.shared) await pluginsApi.setSharedEnabled(p.key, enabled);
  else await pluginsApi.setEnabled(p.key, enabled);
  await reload();
}
```

- [ ] **Step 5: 样式**（`<style scoped>` 末尾）

```css
:deep(.sharebox) { font-size: 12px; color: #446; display: inline-flex; align-items: center; gap: 2px; }
.pcard { border-top: 1px solid #eee; padding: 10px 0; }
.phead { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.pname { font-weight: 600; font-size: 14px; }
.pdesc { color: #777; font-size: 12px; margin: 4px 0; }
.tag { font-size: 11px; background: #eef; color: #446; border-radius: 8px; padding: 1px 6px; margin-left: 6px; }
.tag.cust { background: #e9f7e9; color: #2a8a2a; }
```
> 注：共享区用的 `.pcard/.phead/.pname/.pdesc/.tag` 是普通(非 `:deep`)选择器，因为这段模板在 PluginsView 自身作用域内；已有的 `:deep(.pcard)` 等是给 PluginCard 子组件用的，两者不冲突。

- [ ] **Step 6: 类型检查** — `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 7: 逻辑走查**

- admin：每个**自定义**插件卡右侧出现「共享」勾选，勾上 → `POST /:key/share {shared:true}`；内置插件无勾选。
- 普通用户：底部「管理员共享的插件」区列出 admin 共享的(非用户已有 key)插件,只读 + 启用开关(走 `/shared/:key/enable`),不显示配置/删除;「已配置」标记但无值。
- 用户自己的 MCP/技能区不含共享项(`!p.shared` 过滤)。

- [ ] **Step 8: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/plugins.ts frontend/src/views/PluginsView.vue
git commit -m "feat(plugins-ui): admin 自定义插件「共享」勾选 + 用户「管理员共享的插件」区(只读+启用开关)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收(全部 Task 完成后)

1. `cd ~/projects/stock-agent/backend && npx jest plugins -i` → 全绿；`npm test` → 本批相关套件绿(chat/meetings live-sidecar flaky 除外)。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(可选)：`docker compose up -d --build`——
   - admin → 能力插件：加一个自定义 MCP，勾「共享」。
   - 普通用户 → 能力插件：底部「管理员共享的插件」区出现该 MCP(只读，可开关)，看不到其 config；停用后该用户能力里不再生效。
   - admin 取消共享 → 用户侧该项消失。
