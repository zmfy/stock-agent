# 股票小作手 Data Layer Implementation Plan (Plan 5 of phase-1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** Give the agent real A-share data: a Python AkShare sidecar (HTTP), a unified Node data interface with SQLite caching (by code+date, traceable), manual CSV quote upload (通达信导出), a manual refresh endpoint and a nightly cron. Produces a per-stock **snapshot** whose field names align with `gate.field` so Plan 6's rule-engine can read it directly.

**Reality caveat:** AkShare is live/network. The sidecar is written defensively (per-field try/except, partial data OK) and exact AkShare call→field mapping may need tuning on first real run. Node degrades gracefully when the sidecar/data is unavailable (cache-only, never crashes). TDD focuses on the Node cache/CSV/snapshot logic (deterministic); the sidecar is built + health-checked, data accuracy verified later against a real environment.

**Architecture:** `akshare-mcp` = a FastAPI service wrapping AkShare, exposing `/health`, `/fundamentals/{code}`, `/quote/{code}`, `/market/sentiment`. Node `data/sidecar.ts` calls it over HTTP, using the URL from the user's enabled **akshare-data** plugin config (Plan 4 integration). `data/service.ts` caches results in SQLite (global market data, keyed by code+date) and assembles a snapshot. CSV upload overrides quotes. node-cron refreshes nightly.

**Tech Stack:** + Python 3.11 + FastAPI + akshare (new container in docker-compose). Node: node-cron, multer (CSV upload). Reuse existing patterns.

---

## Cache schema (global market data — objective, not per-user)
```
quote_daily ( code TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL,
              volume REAL, source TEXT, fetched_at DATETIME, PRIMARY KEY(code,date) )
fundamentals ( code TEXT, date TEXT, data TEXT(JSON), source TEXT, fetched_at DATETIME,
               PRIMARY KEY(code,date) )
market_sentiment ( date TEXT PRIMARY KEY, limit_up_count INT, limit_down_count INT,
                   sse_ma20_slope REAL, data TEXT(JSON), source TEXT, fetched_at DATETIME )
```

## Snapshot (the bridge to Plan 6 rule-engine — field names = gate.field)
`getStockSnapshot(code, asOfDate?)` returns:
```
{ code, name, date,
  roe_ttm, pe, pb, ps, net_profit, turnover_rate,   // from fundamentals JSON
  ma20, ma60, year_high, close,                       // computed from quote_daily
  limit_up_count, limit_down_count, sse_ma20_slope,   // from market_sentiment (latest)
  _missing: [field...] }                              // fields we couldn't fill (transparency)
```
MAs = mean of last 20/60 closes in quote_daily; year_high = max close over ~250 rows.

---

## Tasks

### Task 1: cache schema + types
- Add the 3 tables to `db.ts initSchema()` (+ index on quote_daily(code)).
- Types in `types/index.ts`: `StockSnapshot`, `QuoteRow`.
- db.test: tables exist.

### Task 2: sidecar HTTP client (`data/sidecar.ts`)
- `resolveSidecarBase(userId)`: read enabled `akshare-data` plugin config `.url` (Plan 4 `getEnabledCapabilities`); null if not enabled.
- `fetchFundamentals(base, code)`, `fetchQuotes(base, code, days)`, `fetchMarket(base)` — GET the sidecar; on any error return null (graceful).
- Test (mock fetch): parses success; returns null on non-2xx / throw.

### Task 3: data service — cache + snapshot (`data/service.ts`)
- `cacheQuotes(code, rows, source)`, `cacheFundamentals(code, date, data, source)`, `cacheMarket(date, m, source)` (upserts).
- `getStockSnapshot(userId, code)`: ensure fresh-ish data — if today's fundamentals/quotes missing, try sidecar (via Task 2) and cache; then assemble snapshot from cache (compute MAs/year_high). Always returns a snapshot object with `_missing` listing unfilled fields (never throws).
- `refreshMarket(userId)`: fetch market sentiment from sidecar → cache (today). Returns the row or null.
- `listCachedCodes()`: distinct codes in cache (for cron).
- Tests (mock sidecar client): cache hit avoids refetch; snapshot computes ma20/ma60 from seeded quotes; `_missing` lists fields with no data; market sentiment cached + read.

### Task 4: CSV upload + refresh routes (`routes/data.ts`, authMiddleware)
- `POST /api/data/quotes/csv` (multer memory): parse CSV `code,date,open,high,low,close,volume` (header-detected; tolerate 通达信 column names via a small alias map) → cacheQuotes(source='csv'). Returns {inserted, codes}.
- `GET /api/data/snapshot/:code` → getStockSnapshot.
- `POST /api/data/refresh` → refreshMarket + refresh fundamentals/quotes for :code if body.code given; returns what was refreshed + which fields still missing.
- `GET /api/data/source` → { sidecarConfigured: boolean, base, sidecarHealthy: boolean } (pings /health).
- Mount `/api/data`. Tests: CSV parse→snapshot reflects uploaded close & computed MAs; snapshot endpoint; source endpoint with mocked health.

### Task 5: Python AkShare sidecar
- `sidecar/main.py` (FastAPI): `/health`; `/fundamentals/{code}` (roe_ttm, pe, pb, ps, net_profit, turnover_rate, name — each in try/except, partial OK); `/quote/{code}?days=120` (daily OHLCV via ak.stock_zh_a_hist); `/market/sentiment` (limit up/down counts via ak.stock_zt_pool_em / dt pool; sse_ma20_slope from index hist).
- `sidecar/requirements.txt` (fastapi, uvicorn, akshare, pandas), `sidecar/Dockerfile`.
- Add `akshare-mcp` service to `docker-compose.yml` (port 8000); set the app's default akshare-data plugin URL to `http://akshare-mcp:8000`.
- No unit tests (network); `docker compose` builds it and `/health` returns ok.

### Task 6: nightly cron + frontend
- `cron/nightly.ts`: node-cron at 23:00 (Asia/Shanghai) → for an admin/system context, refresh market sentiment + fundamentals/quotes for `listCachedCodes()`. Started in index.ts (guarded by env `ENABLE_CRON!=='false'`). Log results; never throw.
- `frontend/src/api/data.ts` + `views/DataView.vue` at `/data`: source/health banner; CSV upload; stock code lookup → show snapshot table (fields + which are missing); "刷新" button. Home/nav link "数据".
- Verify: backend npm test x2; vue-tsc; docker compose build (incl. sidecar); smoke: /api/data/source shows sidecar health; upload a tiny CSV → snapshot reflects it; (real AkShare call best-effort).

## Done criteria
A logged-in user can upload 通达信 CSV quotes and/or rely on the AkShare sidecar; `getStockSnapshot(userId, code)` returns a cached, traceable snapshot with gate-aligned field names (and an explicit `_missing` list). Nightly cron keeps cache warm. This is exactly what Plan 6's rule-engine consumes.
