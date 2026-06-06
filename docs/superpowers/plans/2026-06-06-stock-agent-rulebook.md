# 股票小作手 Rulebook Versioning Implementation Plan (Plan 2 of phase-1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Per-user rulebook with immutable versioned snapshots — import the user's V3.0 A/B dual-system manual as a baseline, view/list versions, create new (edited) versions, diff two versions, and "adopt" (activate) one. This is the structured "brain" the analysis engine (Plan 4) will read.

**Architecture:** A `rulebook_versions` row holds metadata + persona + `position_rules` (JSON). Two child tables `gates` (machine-readable hard thresholds) and `soft_rules` (judgment rules) are tied to a version_id. A version is an immutable snapshot; creating a new version copies+edits rows under a new id and links `parent_version_id`. Exactly one version per user has `is_active = 1` ("当前使用"). Agent proposes (Plan 4), user adopts (here).

**Tech Stack:** same as Plan 1 (Express + better-sqlite3 + TS; Vue 3 + Pinia). Reuse `getDb()`, `successResponse/errorResponse`, `authMiddleware`, the `api` client.

---

## Data model

### Table `rulebook_versions`
```
id TEXT PK
user_id TEXT NOT NULL
version_label TEXT            -- e.g. "V3.0", "V3.1"
persona TEXT                  -- agent 人设
position_rules TEXT           -- JSON: 仓位/出场/熔断/大盘闸门 (see baseline)
note TEXT                     -- 本版改了什么/为什么
author TEXT                   -- 'user' | 'agent'
parent_version_id TEXT        -- nullable, for history/rollback/diff
is_active INTEGER DEFAULT 0
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
```

### Table `gates` (machine-readable hard thresholds — Plan 4 evaluates these)
```
id TEXT PK
version_id TEXT NOT NULL
system TEXT                   -- 'A' | 'B'
gate_key TEXT                 -- stable key, e.g. 'roe_ttm'
label TEXT                    -- display, e.g. 'ROE(TTM)'
field TEXT                    -- data field name, e.g. 'roe_ttm'
op TEXT                       -- '>=','>','<=','<','between','gt_field'
threshold REAL                -- nullable
threshold2 REAL               -- nullable (upper bound for 'between')
ref_field TEXT                -- nullable (other field for 'gt_field', e.g. 'ma60')
unit TEXT                     -- '%','倍',''
veto INTEGER DEFAULT 1        -- 1 = 一票否决; 0 = 质量项(不否决)
exception_channel TEXT        -- nullable JSON (例外通道条件)
teach TEXT                    -- 教学层一句话
sort_order INTEGER
```

### Table `soft_rules` (judgment rules fed to the AI in Plan 4)
```
id TEXT PK
version_id TEXT NOT NULL
system TEXT                   -- 'A' | 'B'
text TEXT                     -- the rule
teach TEXT                    -- 教学层
sort_order INTEGER
```

## V3.0 baseline content (encode in `backend/src/rulebook/baseline-v3.ts`)

**persona:** "你是一位经验丰富的 A 股操盘手,深谙中线业绩股(A 系统)与短线题材股(B 系统)。你严格执行 A/B 双系统规则、绝不混用:A 让利润奔跑,B 让亏损止步。你只判断今天有没有资格、用哪套规则去做,不预测涨跌。"

**A-system gates** (system 'A', veto 1 unless noted):
| gate_key | label | field | op | threshold | threshold2 | ref_field | unit | teach |
|---|---|---|---|---|---|---|---|---|
| roe_ttm | ROE(TTM) | roe_ttm | >= | 10 | | | % | ROE<10% 说明用自有资本赚钱能力不足,中线买的是真实盈利能力 |
| pe | 市盈率PE(TTM) | pe | between | 0 | 60 | | 倍 | PE 为正排除亏损股;>60 倍估值过高,中线买公司不是买故事 |
| pb | 市净率PB | pb | < | 5 | | | 倍 | PB 过高资产溢价大;重资产行业应更低(<1.5) |
| ps | 市销率PS | ps | < | 8 | | | 倍 | 市销率过高说明营收撑不起市值 |
| net_profit | 真实利润(归母净利>0) | net_profit | > | 0 | | | 元 | 必须是真实盈利,不是讲故事 |
| ma_trend | 趋势向上(20>60日线) | ma20 | gt_field | | | ma60 | | 20 日线在 60 日线上方=中期趋势向上;且不在年内高点追高 |

**A-system soft_rules** (system 'A'):
- "有机构覆盖且业绩驱动(有清晰买入评级/目标价),不是纯题材故事" 
- "不在年内高点附近追高(接近 52 周高点需警惕)"
- "经营现金流为正/健康(现金流恶化是减分项)"

**B-system gates** (system 'B' — 情绪闸门, veto 1):
| gate_key | label | field | op | threshold | unit | teach |
|---|---|---|---|---|---|---|
| limit_up_count | 涨停家数 | limit_up_count | > | 50 | 家 | 情绪闸门:涨停<50 家说明赚钱效应不足,B 系统空仓 |
| limit_down_count | 跌停家数 | limit_down_count | < | 10 | 家 | 跌停≥10 家说明杀跌情绪重,不开 B |
| sse_ma20_not_down | 上证20日线不向下 | sse_ma20_slope | >= | 0 | | 大盘趋势向下时再好的题材也不碰 |

**B-system gate (quality, veto 0):**
| turnover_rate | 换手率 | turnover_rate | < | 15 | % | 换手>15% 有出货嫌疑,排除出货型涨停 |

**B-system soft_rules** (system 'B'):
- "热点在政策/事件发酵 1–3 天内,不追媒体已铺天盖地的"
- "涨停质量:涨停后不破实体下沿"
- "MACD 金叉初期 / 红柱连续放大"
- "不接纯粹一字板(买不进也跑不掉)"

**position_rules (JSON):**
```json
{
  "single_trade_risk_pct": { "A": 1.0, "B": 0.5 },
  "single_stock_cap_pct": { "A": 20, "B": 10 },
  "system_total_cap_pct": { "B": 30 },
  "position_formula": "买入股数 =（账户总额 × 单笔风险%）÷（买入价 − 止损价）",
  "market_gate_A": [
    { "sse_ma20": "up", "can_open": "yes", "total_cap_pct": 60 },
    { "sse_ma20": "flat", "can_open": "selective", "total_cap_pct": 40 },
    { "sse_ma20": "down", "can_open": "no", "total_cap_pct": null }
  ],
  "exits": {
    "A": ["初始止损:跌破入场关键支撑或 -12%,收盘确认", "移动止盈:收盘有效跌破 20 日线才走", "基本面证伪→无条件清仓"],
    "B": ["时间止损:3 天内不创新高/板块熄火→走", "跌破 10 日线或 -6%→清仓", "板块连续 2 天无涨停→清仓", "大盘单日跌>2% 且放量→B 全清"]
  },
  "add_position": {
    "A": "仅盈利+突破新平台时加仓,加后单票≤20%;禁止向亏损头寸补仓",
    "B": "禁止补仓"
  },
  "circuit_breaker": ["当月亏 5%→停止交易 3 天逐笔复盘", "当月亏 8%→总仓强制降到 10% 以下"],
  "a_share_notes": ["T+1:当天买入次日才能卖,止损最早次日生效", "一字跌停止损失效→单票硬顶才是真正风险上限"]
}
```

---

## Tasks

### Task 1: schema + types
- Add the three tables to `backend/src/db.ts` `initSchema()` (CREATE TABLE IF NOT EXISTS, with indexes on `(version_id)` and `(user_id, is_active)`).
- Add interfaces to `backend/src/types/index.ts`: `RulebookVersion`, `Gate`, `SoftRule`, and a `FullRulebook` (version + gates[] + softRules[] + parsed positionRules).
- Test `db.test.ts`: assert the three tables exist.

### Task 2: V3.0 baseline module + instantiate
- Create `backend/src/rulebook/baseline-v3.ts` exporting `BASELINE_V3` (persona, gates[], softRules[], positionRules object, versionLabel 'V3.0').
- Create `backend/src/rulebook/service.ts` with `instantiateBaseline(userId): FullRulebook` — inserts version (is_active=1, author='user') + gate rows + soft_rule rows in a transaction; returns the full rulebook.
- Test `service.test.ts` (isolated temp DATA_DIR): after instantiate, active rulebook has 6 A gates + (3 B emotion + 1 quality) gates, the 'roe_ttm' gate has op '>=' threshold 10 veto 1, positionRules.single_stock_cap_pct.A === 20.

### Task 3: service operations
In `service.ts` add:
- `getActive(userId): FullRulebook | null`
- `listVersions(userId): RulebookVersion[]` (metadata only, newest first)
- `getVersion(userId, versionId): FullRulebook | null`
- `createVersion(userId, payload): FullRulebook` — payload = { versionLabel, persona, note, parentVersionId, author, gates[], softRules[], positionRules }. Inserts a NEW version (is_active=0 by default) with fresh gate/soft rows. Does NOT activate.
- `activateVersion(userId, versionId): void` — transaction: set all this user's versions is_active=0, then set the target =1. Throws if version not found / not owned.
- `diffVersions(userId, aId, bId): RulebookDiff` — compare gates by gate_key (added/removed/changed threshold/op), soft_rules by text (added/removed), persona changed?, positionRules deep-diff (changed keys). Plain JS, returns structured object.
- Tests for each in `service.test.ts`: create v3.1 from active with roe threshold 8 → diff shows roe_ttm threshold 10→8; activate v3.1 → getActive returns v3.1 and old one is_active=0.

### Task 4: routes
Create `backend/src/routes/rulebook.ts` (all `authMiddleware`, per-user via `req.user!.userId`):
- `GET /api/rulebook/active` → FullRulebook or `data:null`
- `POST /api/rulebook/init` → 409 if user already has any version; else instantiateBaseline → 201
- `GET /api/rulebook/versions` → list
- `GET /api/rulebook/versions/:id` → full or 404
- `POST /api/rulebook/versions` → createVersion (zod-validate payload) → 201
- `POST /api/rulebook/versions/:id/activate` → activate → 200 (404 if not found)
- `GET /api/rulebook/versions/:id/diff?against=<otherId>` → diff (against defaults to active version) → 200
Mount in `index.ts` at `/api/rulebook`. Supertest tests in `rulebook.test.ts`: init→active, second init 409, create new version (edit roe), diff, activate, list reflects active flag.

### Task 5: frontend
- `frontend/src/api/rulebook.ts`: getActive, init, listVersions, getVersion, createVersion, activate, diff.
- `frontend/src/views/RulebookView.vue` at route `/rulebook` (requiresAuth):
  - If no active rulebook → show "导入 V3.0 基线" button (calls init).
  - Show active version: persona, A-system gates table (label/op/threshold/unit, 教学 tooltip), B-system gates, soft rules, position rules (formatted).
  - Version list with "采纳/激活" buttons + active badge; clicking a version shows it; "与当前版对比" → diff view (added/removed/changed highlighted).
  - Edit mode: edit persona + gate thresholds + position_rules numbers → "另存为新版本"(createVersion with parentVersionId=active) → appears in list as draft → user clicks 采纳 to activate.
- Add nav link on Home → `/rulebook`. Add route.

### Task 6: verify
- `cd backend && npm test` (all suites green, run twice for repeatability).
- `cd frontend && npx vue-tsc --noEmit`.
- `docker compose up -d --build`; smoke test in container: login as stock-agent → POST /api/rulebook/init → GET /api/rulebook/active shows 'V3.0' with gates; create a version; activate it; diff.
- Commit per task.

## Done criteria
A logged-in user can import the V3.0 baseline, see it rendered as A/B gates + soft rules + position rules, create an edited new version, diff it against the active one, and adopt it — all per-user and persisted. This is the foundation Plan 4's rule-engine + orchestrator will consume.
