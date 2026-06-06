# 股票小作手 Data Validation + Provenance + Gating (Plan 12, phase-3)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans.

**Goal:** A data-validation sub-agent that vets each stock's data before the main agent analyzes it. Priority: uploaded (通达信) data is authoritative → else cross-source → else internal sanity. If validation fails, **block analysis (no report)**. Surface **time + data source (address + fetch time)** on snapshots/reports/chats.

**Confirmed decisions:** all three methods, priority uploaded > cross-source > internal sanity; cross-source needs a 2nd source (scaffold now, slot reserved); fail → hard block; show time + source everywhere.

---

## 12a — Backend (this turn)
- `ai/roles.ts`: add role `validation` (prefer 'fast'); it joins agent_profiles + sub-agent generation automatically.
- `data/service.ts`: snapshot carries **provenance** — `sources: { quote, fundamentals, market }` each `{ source, date, fetched_at }` + `sidecarBase`. Add latestQuoteRow/latestFundamentalsRow/latestMarketRow helpers.
- `validation/service.ts`: `validateStock(userId, snapshot)` (deterministic) →
  `{ trusted, authority: 'uploaded'|'cross'|'internal'|'none', checks: [{name,ok,detail}], missing: string[], sources }`.
  - missing = active rulebook veto-gate fields that are null in the snapshot.
  - recency = quote date within ~7 days; ranges = pe (if present) > 0 etc.
  - authority = uploaded if quote source ∈ {csv,tdx}; else internal. (cross-source check returns 'na' until a 2nd source is wired — quote_daily currently 1 row/code/date.)
  - trusted = missing.length===0 && recency ok && ranges ok.
- `analysis/orchestrator.ts` runAnalysis: validate first; if `!trusted` throw an error carrying `.validation` (DATA_UNTRUSTED) → **no report**. When trusted, store `sources` + `validation` on the report (migrate: ADD COLUMN sources, validation).
- routes/analysis + chat analyze: catch DATA_UNTRUSTED → 400 with the missing fields + guidance ("请上传该股行情或在『数据』刷新后重试").
- Tests: validateStock trusted when all veto fields present + recent; untrusted (lists missing) when a field null; runAnalysis blocks (throws DATA_UNTRUSTED) on missing data; passes when seeded complete; report carries sources+validation.

## 12b — Frontend (next turn)
- Chat: show each message's time. Reports: show created_at + data_date + per-field source + fetch time + sidecar URL + validation verdict. DataView snapshot: source + fetched_at + URL per field. Blocked analysis: show the validation failure (missing/stale fields) instead of a report.

## (separate) Item 4 — manual data collection panel incl 热点新闻 (next)
- Settings 数据采集 panel: refresh market / per-stock, upload CSV (reuse), and 采集热点新闻 (new sidecar /news + cache + display).

## Done criteria (12a)
Analysis is gated on deterministic validation (uploaded-authority → sanity), blocks with clear reasons when data is untrustworthy, and reports carry data provenance + validation verdict. Cross-source slot reserved.
