# 股票小作手 Hot-Sector Screening Implementation Plan (Plan 11, phase-2 finale)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** "按核心原则选股" — screen stocks within the morning meeting's hot sectors using the rule-engine (deterministic gates), list the qualifying ones (foldable, per the UI), each clickable into the Plan-9 stock chat. Per the confirmed decision: universe = hot-sector constituents, not the whole market; sector data is best-effort (fallback to cached codes), scaffold-first.

**Architecture:** deterministic `screenCodes` (snapshot + evaluateGates per code; "selected" = strictly PASSES all A-system veto gates, so data-missing stocks are NOT falsely selected). `resolveUniverse` = explicit codes → else hot-sector constituents via sidecar → else cached codes (offline fallback). Persist the latest run per user. New sidecar endpoints for sector heat/constituents (best-effort, network-dependent like Plan 5).

---

## Backend
- `screening` table: `(id, user_id, created_at, source_note, results TEXT(JSON))`, keep latest per user (or list).
- `data/sidecar.ts`: `fetchHotSectors(base, top)`, `fetchSectorStocks(base, name)` (null on error).
- `screen/service.ts`:
  - `screenCode(userId, code)` → `{ code, name, aPass, bPass, passed, total, failed: string[], oneLineGates }` via getStockSnapshot + evaluateGates; aPass = every A veto gate status==='pass'.
  - `screenCodes(userId, codes)` → results sorted (aPass first, then passed count desc). Cap input.
  - `resolveUniverse(userId, opts)` → opts.codes → else hot sectors→constituents (cap ~20) → else listCachedCodes. Returns `{ codes, note }`.
  - `runScreen(userId, opts)` → resolve + screenCodes + persist + return `{ note, results }`.
  - `getLatest(userId)`.
- `routes/screen.ts`: POST /api/screen/run `{ codes?, top? }`; GET /api/screen/latest. Mount /api/screen.
- Sidecar `main.py`: `/sectors/hot?top=N` (ak.stock_board_industry_name_em sorted by 涨跌幅 desc), `/sectors/{name}/cons` (ak.stock_board_industry_cons_em -> codes). Defensive.
- Tests (TDD): seed two codes (one passes all A veto gates, one fails roe) → screenCodes selects the passer first, marks the other aPass=false; resolveUniverse with no sidecar+no codes → cached codes; runScreen persists and getLatest returns it.

## Frontend
- `api/screen.ts`: run(codes?/top?), latest().
- HomeView: replace the 选股 placeholder with a 「按核心原则选股」button → runScreen → foldable list of results (✅A / ✅B badges, code+name, passed/total); click a row → freeQuery(code) (opens the Plan-9 stock chat). Show source note (which sectors / fallback). Loading + empty states.

## Done criteria
"按核心原则选股" runs a deterministic gate screen over the hot-sector universe (or fallback), lists qualifying stocks foldably, and each opens into the stock chat. Closes phase-2.
