# 股票小作手 Analysis Engine Implementation Plan (Plan 6 of phase-1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** The payoff loop. Given a stock code: code computes the hard gates deterministically (rule-engine), the orchestrator feeds gate results + soft rules + position rules + snapshot to the analysis-role AI for soft judgment + conclusions, and produces a 瑞丰光电-style structured report (A/B verdicts, gate table ✅❌⚠️, position suggestion, one-liner, teaching notes), persisted and traceable.

**Architecture:** Pure deterministic core (`rule-engine.ts`) — no AI, fully tested. `orchestrator.ts` wires snapshot (Plan 5) + active rulebook (Plan 2) + gate eval + a pluggable `aiCall` (default routes to the user's `analysis` model from Plan 3). Prompt build + response parse are pure functions. Report persisted in a `reports` table, every row pinned to rulebook version + data date + AI model (the spec's audit requirement).

**Tech Stack:** reuse everything. AI call via `ai/manager.chat` + `ai/service.getModelForRole(userId,'analysis')` + `ai/providers.getProvider().apiStyle`.

---

## reports table
```
id, user_id, stock_code, stock_name, rulebook_version_id, data_date,
ai_provider, ai_model, snapshot(JSON), gate_results(JSON), soft_findings(JSON),
a_conclusion, b_conclusion, exception_channel, position_suggestion, one_liner,
teach_notes(JSON), raw_ai_response, created_at
```

## rule-engine (pure, the heart)
`evaluateGates(snapshot, gates)` →
```
{ gateResults: [{ gate_key, label, system, field, op, threshold, threshold2, unit, veto,
                  actual, status: 'pass'|'fail'|'unknown', teach }],
  aVeto: { passed: boolean, failed: string[] },     // all A-system veto gates pass?
  bEmotion: { passed: boolean, failed: string[] } } // all B-system veto gates pass?
```
- read `snapshot[gate.field]`; null → status 'unknown'.
- ops: `>=,>,<=,<`; `between` → threshold < actual < threshold2; `gt_field` → snapshot[field] > snapshot[ref_field] (either null → unknown).
- aVeto.passed = no A veto gate is 'fail' (unknown does NOT fail the veto, but is surfaced).

## prompt + parse (pure)
- `buildAnalysisPrompt(persona, gateResults, softRules, positionRules, snapshot)` → instructs the model to return ONLY JSON: `{ a_conclusion, b_conclusion, exception_channel, position_suggestion, one_liner, teach_notes:[{gate_key,note}] }`, grounded in the precomputed gate table (model must NOT recompute numbers).
- `parseAnalysisResponse(text)` → extract first `{...}` JSON; tolerant; on failure return `{ one_liner: text.slice(0,200), ...empties }`.

## Tasks

### Task 1: reports schema + types + rule-engine
- Add `reports` table to db.ts. Types: `GateResult`, `GateEvaluation`, `AnalysisReport`.
- `analysis/rule-engine.ts` + `rule-engine.test.ts`: seed a snapshot (e.g. 瑞丰光电-like: roe 1.28, pe 80, pb 2.3, ps 2.8, ma20>ma60, limit_up 39, limit_down 18) against the V3.0 gates → assert roe fails, pe fails, pb passes, ma_trend passes, B emotion fails (limit_up<50); aVeto.passed=false; unknown when field missing.

### Task 2: orchestrator (prompt/parse pure + runAnalysis)
- `analysis/orchestrator.ts`: `buildAnalysisPrompt`, `parseAnalysisResponse` (pure), and `runAnalysis(userId, code, opts?)` where `opts.aiCall?(prompt):Promise<string>` (default = real AI via analysis role; throws 'NO_MODEL' if none). Flow: snapshot → getActive rulebook (throw 'NO_RULEBOOK' if none) → evaluateGates → buildPrompt → aiCall → parse → persist report (pin version/date/model) → return.
- `analysis/report-service.ts`: saveReport, listReports(userId), getReport(userId,id).
- Tests: `orchestrator.test.ts` — parseAnalysisResponse handles clean JSON + junk-wrapped JSON + garbage; runAnalysis with injected aiCall + seeded snapshot/rulebook persists a report with gate_results and the mocked conclusions; throws NO_RULEBOOK when none.

### Task 3: routes (`routes/analysis.ts`, authMiddleware)
- `POST /api/analysis/run` `{code}` → runAnalysis → 201 report (400 NO_RULEBOOK / NO_MODEL with helpful message).
- `GET /api/analysis/reports` → list (newest first, summary fields).
- `GET /api/analysis/reports/:id` → full report (404).
- Mount `/api/analysis`. Tests (supertest, monkeypatch the analysis AI via a test hook OR seed config + mock fetch): run with rulebook+data seeded + mocked AI → 201; reports list/get; run without rulebook → 400.

### Task 4: frontend
- `api/analysis.ts`: run, listReports, getReport.
- `views/AnalysisView.vue` at `/analysis`: input code + 「分析」; renders report — header (code/name, 用了哪版规则/哪天数据/哪个模型), A-system gate table (✅❌⚠️ + 实测 vs 阈值 + 教学 tooltip), A结论, B情绪闸门 table + B结论, 例外通道, 仓位建议, 一句话结论, 教学层. Past-reports list (click to view). Empty-state hints if no rulebook/AI/data configured.
- Home nav "选股分析".

### Task 5: verify
- backend npm test x2; vue-tsc; docker compose build; smoke: seed rulebook(init) + a CSV + an AI config (or mock); run analysis → report persisted with gate verdicts. (Real AI call only if a real key present.)

## Done criteria
A user with a rulebook + an AI model + some data can run an analysis on a code and get a persisted, auditable 瑞丰光电-style report: deterministic gate verdicts + AI soft judgment + position suggestion + one-liner + teaching. This closes the phase-1 core loop (规则 → 数据 → 分析 → 记录).
