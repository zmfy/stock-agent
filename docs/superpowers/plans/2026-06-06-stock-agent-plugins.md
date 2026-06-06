# 股票小作手 MCP/Skill Plugin Management Implementation Plan (Plan 4 of phase-1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Per-user capability plugin management. The system ships a catalog of MCP servers (Playwright browse, AkShare A-share data) and skills (Research, Memory). A user enables/configures the ones they want for their agent; a custom plugin can be added (user supplies its own MCP server / skill). This is the registry the data layer (Plan 5) and analysis engine (Plan 6) read to know which capabilities are on.

**Scope boundary (honest):** Plan 4 is the **registry + management layer** — enable/disable, configure, add custom. It does NOT open live MCP connections; the AkShare MCP server itself is built in Plan 5, and actual MCP client wiring / skill execution happens in Plan 5–6 when there's something to connect to. Plan 4 exposes `getEnabledCapabilities(userId)` for those plans to consume.

**Architecture:** Static catalog of built-in plugins in code (`plugins/catalog.ts`). Per-user state in a new `plugins` table (one row per user×plugin_key) holding enabled flag + JSON config (override of catalog defaults, or full definition for custom). Built-ins start disabled; enabling creates/updates a row. Custom plugins carry their own label/kind/transport/config with `source='custom'`.

**Tech Stack:** same as before. Reuse `authMiddleware`, `getDb()`, response helpers, the `api` client.

---

## Built-in catalog (`backend/src/plugins/catalog.ts`)

```ts
type Kind = 'mcp' | 'skill';
type Transport = 'stdio' | 'http';
interface PluginDef {
  key: string; kind: Kind; label: string; description: string;
  recommended?: boolean;
  transport?: Transport;               // mcp only
  defaultConfig: Record<string, unknown>;
  configHint?: string;
}
```

| key | kind | transport | label | defaultConfig |
|---|---|---|---|---|
| playwright | mcp | stdio | Playwright 浏览器 | `{command:'npx',args:['-y','@playwright/mcp@latest'],env:{}}` |
| akshare-data | mcp | http | AkShare A股数据源 | `{url:'http://akshare-mcp:8000/sse'}` |
| research | skill | — | Research 探索技能（对标 superpowers） | `{}` |
| memory | skill | — | Memory 记忆技能（对标 agentmemory） | `{}` |
| fetch | mcp | stdio | Fetch 网页抓取（推荐） | `{command:'npx',args:['-y','mcp-server-fetch'],env:{}}` |
| sequential-thinking | skill | — | 分步推理技能（推荐） | `{}` |

`research` / `memory` / `playwright` / `akshare-data` are the user's named core four; `fetch` / `sequential-thinking` are `recommended: true` extras.

## Data model — table `plugins`
```
id TEXT PK
user_id TEXT NOT NULL
plugin_key TEXT NOT NULL
kind TEXT NOT NULL          -- 'mcp' | 'skill'
label TEXT                 -- catalog label, or custom label
source TEXT NOT NULL        -- 'builtin' | 'custom'
transport TEXT             -- 'stdio'|'http'|null
config TEXT                 -- JSON
enabled INTEGER DEFAULT 0
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
UNIQUE(user_id, plugin_key)
```
Index `(user_id, enabled)`.

---

## Tasks

### Task 1: catalog + schema
- `plugins/catalog.ts`: export `CATALOG: PluginDef[]` + `getCatalogPlugin(key)`.
- Add `plugins` table + index to `db.ts initSchema()`.
- Tests: `db.test.ts` — table exists.

### Task 2: service (`plugins/service.ts`)
- `listForUser(userId)` → merged view: every catalog plugin with `{ ...def, source:'builtin', enabled, config (merged default+override) }`, PLUS any custom rows. Built-ins with no row → enabled:false, config:defaultConfig.
- `setEnabled(userId, key, enabled, config?)` → upsert a row for a catalog key (validates key in catalog); stores enabled + config (merged). Throws UNKNOWN_PLUGIN if not catalog & no existing custom row.
- `addCustom(userId, { key, label, kind, transport?, config })` → insert source='custom' row (enabled:true). Throws DUPLICATE_KEY if key exists (catalog or row).
- `updateConfig(userId, key, config)` → update config JSON (parse-validated by caller).
- `remove(userId, key)` → delete custom row; for builtin just disable + clear override.
- `getEnabledCapabilities(userId)` → `{ mcp: [{key,label,transport,config}], skills: [{key,label,config}] }` for enabled rows. (Consumed by Plan 5/6.)
- Tests `service.test.ts` (isolated DATA_DIR): list shows 6 catalog plugins all disabled initially; enable playwright → enabled + config defaulted; per-user isolation; addCustom appears & enabled; duplicate key throws; getEnabledCapabilities groups mcp vs skill.

### Task 3: routes (`routes/plugins.ts`, authMiddleware, per-user)
- `GET /api/plugins/catalog` → CATALOG.
- `GET /api/plugins` → `listForUser`.
- `POST /api/plugins/:key/enable` → zod `{ enabled: boolean, config?: object }` → setEnabled.
- `POST /api/plugins/custom` → zod `{ key, label, kind:'mcp'|'skill', transport?: 'stdio'|'http', config: object }` → addCustom (409 DUPLICATE_KEY).
- `PUT /api/plugins/:key/config` → `{ config: object }` → updateConfig.
- `DELETE /api/plugins/:key` → remove.
- `GET /api/plugins/enabled` → getEnabledCapabilities.
- Mount `/api/plugins` in `index.ts`.
- Tests `plugins.test.ts` (supertest): catalog (6) + auth required; enable playwright; list reflects it; per-user isolation (second user sees all disabled); add custom mcp; duplicate 409; enabled endpoint groups.

### Task 4: frontend
- `frontend/src/api/plugins.ts`: getCatalog, list, setEnabled, addCustom, updateConfig, remove.
- `frontend/src/views/PluginsView.vue` at `/plugins` (requiresAuth):
  - Two groups: **MCP 工具** and **技能 Skill**. Each plugin = card with label, description, "推荐" tag, enable toggle, and a collapsible 配置 (JSON textarea prefilled with effective config; save → updateConfig). Custom plugins get a 删除 button.
  - "添加自定义插件" form: key, label, kind(select), transport(select, mcp only), config(JSON textarea).
  - Note line: MCP 实际连接 / skill 实际生效在后续计划接入；这里负责选择与配置。
- Home nav link → `/plugins` ("能力插件"). Add route.

### Task 5: verify
- `cd backend && npm test` twice (green).
- `cd frontend && npx vue-tsc --noEmit`.
- `docker compose up -d --build`; smoke: login → GET /catalog (6) → enable playwright → GET /plugins (playwright enabled) → add custom → GET /enabled (groups mcp/skill).
- Commit per task.

## Done criteria
A logged-in user can browse the built-in MCP/skill catalog, enable+configure the ones they want, and add a custom plugin — all per-user. `getEnabledCapabilities(userId)` gives Plan 5/6 the enabled MCP servers + skills to actually connect/use.
