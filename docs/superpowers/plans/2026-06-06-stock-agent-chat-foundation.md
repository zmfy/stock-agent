# 股票小作手 Chat Foundation Implementation Plan (Plan 7, phase-2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** Lay the substrate for the chat-style redesign: a rulebook **template library** (novices pick one), **agent profiles** (main-agent persona decoupled from the rulebook + auto-generated sub-agent personas), and **chat infrastructure** (sessions/messages + a chat endpoint driven by the user's agent models). Then the onboarding wizard + chat-style main page (7b).

Split: **7a backend** (this plan, fully TDD) → **7b frontend** (onboarding wizard + chat shell).

**Key decisions (confirmed):** start here; screening later runs within the morning-meeting's hot sectors; meetings scaffold on existing data first.

---

## 7a — Backend

### Template library (`rulebook/templates.ts`)
- `TEMPLATES: { key, label, description, baseline: Baseline }[]` — reuse the `Baseline` shape from baseline-v3.
  - `v3-dual-system` → existing `BASELINE_V3` (the user's default).
  - `ma-bullish`（多头并列）→ gates: ma5>ma10, ma10>ma20, ma20>ma60 (gt_field), system 'A'; soft rules about volume; needs ma5/ma10 (added to snapshot).
  - `value-quality`（价值质量）→ roe_ttm>=15, pe between 0..30, pb<3, net_profit>0.
- `listTemplates()`, `getTemplate(key)`.
- Extend `data/service` snapshot with `ma5`, `ma10` (mean of recent 5/10 closes) + add to StockSnapshot type + _missing check.
- rulebook route: `GET /api/rulebook/templates`; change `POST /api/rulebook/init` to accept `{ template?: key }` (default v3-dual-system) → instantiate that baseline.

### Agent profiles (`agent/profiles-service.ts` + table `agent_profiles`)
- Table: `(id, user_id, role, persona, generated INTEGER, updated_at, UNIQUE(user_id, role))`. roles: `core`(=主 agent) + `data`/`analysis`/`qualitative`/`review`(子 agent). Defaults from `ai/roles.ts` hints + a default main persona.
- service: `listProfiles(userId)` (role + persona, default if no row), `setProfile(userId, role, persona)`, `getCorePersona(userId)` (core profile → fallback to default), `generateSubAgents(userId, opts?)` — main(core) agent drafts personas for the 4 sub-roles via an AI call (`aiCall` injectable; default uses core model), stored generated=1.
- Update `analysis/orchestrator.ts` to use `getCorePersona(userId)` (fallback to rulebook persona then default) instead of `rb.version.persona`.

### Chat infrastructure (`chat/service.ts` + tables)
- `chat_sessions (id, user_id, kind, ref_id, title, created_at)`; kind ∈ `general|core_principle|stock|morning|evening`.
- `chat_messages (id, session_id, role, content, created_at)` role ∈ `user|assistant|system`.
- service: `createSession(userId,kind,refId?,title?)`, `listSessions(userId,kind?)`, `getMessages(sessionId)`, `postMessage(userId, sessionId, content, opts?)` → append user msg → build prompt (system = core persona + kind-specific framing + prior messages) → call the agent model (role 'core' via getModelForRole; injectable `aiCall` for tests) → append assistant msg → return it. Non-streaming v1.
- routes `chat/`: POST /sessions, GET /sessions, GET /sessions/:id/messages, POST /sessions/:id/messages, DELETE /sessions/:id.
- Tests: templates list+init; snapshot ma5/ma10; profiles defaults + set + generateSubAgents(mock AI) persists 4; chat create→post(mock AI)→messages persisted, per-user isolation, NO_MODEL guard.

## 7b — Frontend (next plan-stage)
- Onboarding wizard `/onboarding`: ① pick template → init ② AI key + main persona → save core profile ③ generate sub-agents (editable) → done.
- Main page redesign: left rail (早会 / 核心原则 / 选股 / 自由查询 / 晚会 placeholders + general chat sessions) + right chat area (send/receive against a session). Reuse existing pages via left menu.

## Done criteria (7a)
Backend supports: list/choose a rulebook template; per-user main + sub agent personas (auto-generated, editable); chat sessions/messages answered by the user's agent model. All per-user, TDD-green. 7b wires the UI.
