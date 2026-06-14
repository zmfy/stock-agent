# 规则引擎支持多系统（A/B/C…）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让规则引擎支持任意多系统（A/B/C…），并以「是否有仓位风险配置」区分真实交易系统(进选股/计敞口)与零仓位复盘系统(C，仅评估展示)。

**Architecture:** 引擎与多数前端展示本就按系统动态。本次：放宽保存校验接受任意单字母系统；synthesize 不再把 C 折叠成 A；新增 `tradeableSystems`（`single_trade_risk_pct[sys]>0`）并据此泛化 screen（C 不进选股）；`ScreenResult.aPass/bPass` → `passedSystems`；前端类型放宽。

**Tech Stack:** Express/TS + better-sqlite3 + jest（后端）；Vue 3 + Vite（前端，`vue-tsc --noEmit` 把关）。

Spec：`docs/superpowers/specs/2026-06-14-multi-system-rulebook-design.md`。测试：后端 `cd backend && npm test`（当前 358 绿）；前端 `cd frontend && npx vue-tsc --noEmit`。

> **约定**：仅当用户说「提交」才 commit。各 Task 的 Commit 步骤写好 message 但不执行，攒到放行。

---

## 文件结构

**后端**
- Modify `backend/src/routes/rulebook.ts` — gate/softRule 的 `system` 枚举放宽。
- Modify `backend/src/rulebook/synthesize-service.ts` — validateSynth 保留系统字母 + prompt。
- Modify `backend/src/rulebook/propose-service.ts` — 系统字母 regex 守卫 + prompt。
- Modify `backend/src/rulebook/service.ts` — 新增 `tradeableSystems`。
- Modify `backend/src/screen/service.ts` — passedSystems 泛化 + 消费点。
- Modify `backend/src/chat/service.ts:308` — screen 摘要兼容 passedSystems。
- Tests：`routes/rulebook.test.ts`、`rulebook/synthesize-service.test.ts`、`rulebook/service.test.ts`、`screen/service.test.ts`。

**前端**
- Modify `frontend/src/api/rulebook.ts`、`frontend/src/api/screen.ts`、`frontend/src/views/HomeView.vue`。

---

## Task 1: 放宽保存校验，接受任意单字母系统

**Files:** Modify `backend/src/routes/rulebook.ts`（gateSchema ~29、softRuleSchema ~43）；Test `backend/src/routes/rulebook.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `backend/src/routes/rulebook.test.ts` 末尾追加（沿用文件已有的 app/token 脚手架；若该文件用别的登录辅助，照其现有写法取 token）：

```ts
describe('apply 接受 C 系统门槛', () => {
  it('含 system:C 的门槛可保存(不再 422)', async () => {
    // 复用文件已有的已登录用户 token 辅助；下面 hAuth() 换成本文件实际的鉴权头函数
    const body = {
      versionLabel: '三系统 v1',
      proposal: {
        persona: '纪律操盘',
        gates: [
          { system: 'A', gate_key: 'roe', label: 'ROE', field: 'roe_ttm', op: '>=', threshold: 10, threshold2: null, ref_field: null, unit: '%', veto: 1, teach: '' },
          { system: 'C', gate_key: 'c_demo', label: '复盘项', field: 'close', op: '>', threshold: 0, threshold2: null, ref_field: null, unit: '', veto: 1, teach: '零仓位复盘' },
        ],
        softRules: [{ system: 'C', text: '只复盘不下单', teach: '' }],
        positionRules: { single_trade_risk_pct: { A: 1.0 } },
      },
    };
    const r = await request(app).post('/api/rulebook/apply').set(hAuth()).send(body);
    expect(r.status).toBe(201);
  });
});
```
> 说明：`hAuth()` 替换为本测试文件已有的「普通用户鉴权头」函数名（打开文件看顶部 beforeAll/辅助）。本用例关键是断言 status 201（而非旧的 422）。

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest routes/rulebook -i -t "C 系统门槛"`。Expected: FAIL（422，enum 拒绝 C）。

- [ ] **Step 3: 实现** — `backend/src/routes/rulebook.ts`：把 `gateSchema` 与 `softRuleSchema` 里的 `system: z.enum(['A', 'B']),` 改为：
```ts
  system: z.string().regex(/^[A-Z]$/, '系统须为单个大写字母'),
```
（两处都改。`applySchema` 复用这两个 schema，自动生效。）

- [ ] **Step 4: 运行确认通过 + 回归** — `cd backend && npx jest routes/rulebook -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/routes/rulebook.ts backend/src/routes/rulebook.test.ts
git commit -m "feat(rulebook): 保存校验放宽为任意单字母系统(支持 C…),不再拒 received 'C'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: synthesize 保留系统字母（不再把 C 折叠成 A）

**Files:** Modify `backend/src/rulebook/synthesize-service.ts`（validateSynth ~58/75、buildSynthesizePrompt ~28-37）；Test `backend/src/rulebook/synthesize-service.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `backend/src/rulebook/synthesize-service.test.ts` 的 `describe('validateSynth', …)` 内追加：

```ts
  it('保留 C 系统，不折叠成 A', () => {
    const obj = {
      versionLabel: 'v', persona: 'p',
      gates: [{ system: 'C', gate_key: 'c1', label: '复盘', field: 'close', op: '>', threshold: 0, unit: '', veto: 1, teach: '' }],
      softRules: [{ system: 'C', text: '只复盘' }],
      positionRules: {},
    };
    const r = syn.validateSynth(obj);
    expect(r.proposal.gates[0].system).toBe('C');
    expect(r.proposal.softRules[0].system).toBe('C');
  });
```
> `syn = require('./synthesize-service')`（文件顶部已有）。

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest synthesize-service -i -t "保留 C"`。Expected: FAIL（得到 'A'）。

- [ ] **Step 3: 实现** — `backend/src/rulebook/synthesize-service.ts`：
  - 第 ~58 行 `system: a.system === 'B' ? 'B' : 'A',` 改为：
```ts
      system: /^[A-Z]$/.test(String(a.system)) ? String(a.system) : 'A',
```
  - 第 ~75 行 softRules 的 `system: r.system === 'B' ? 'B' : 'A'` 改为：
```ts
    if (r?.text) softRules.push({ system: /^[A-Z]$/.test(String(r.system)) ? String(r.system) : 'A', text: String(r.text), teach: String(r.teach ?? '') });
```
  - `buildSynthesizePrompt`（~28 行「系统：A=… B=…」附近）把系统说明改为：
```
系统：可用 A/B/C… 任意单字母标签区分不同打法。给出仓位风险配置(positionRules.single_trade_risk_pct)的系统=真实交易系统；纯复盘/零仓位（只做认知训练、不下单）的系统不要在 single_trade_risk_pct 里配置，它只评估门槛不参与选股与仓位。
```
（positionRules 示例保持只给交易系统的风险/上限。）

- [ ] **Step 4: 运行确认通过** — `cd backend && npx jest synthesize-service -i`。Expected: 全绿。

- [ ] **Step 5: Commit（待放行）**
```bash
git add backend/src/rulebook/synthesize-service.ts backend/src/rulebook/synthesize-service.test.ts
git commit -m "feat(rulebook): synthesize 保留 C 等系统字母(不再折叠成 A)+prompt 说明零仓位系统

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: propose 系统字母守卫 + prompt

**Files:** Modify `backend/src/rulebook/propose-service.ts`（~106 gates_add、~116 soft_add、prompt ~40-46）

- [ ] **Step 1: 实现（小改，无新测试，靠回归）** — `backend/src/rulebook/propose-service.ts`：
  - 第 ~106 行 `system: a.system || 'A',` 改为：
```ts
      system: /^[A-Z]$/.test(String(a.system)) ? String(a.system) : 'A',
```
  - 第 ~116 行 `system: sa.system || 'A',` 改为：
```ts
      system: /^[A-Z]$/.test(String(sa.system)) ? String(sa.system) : 'A',
```
  - `buildProposePrompt` 里系统说明补一句：「系统可含 A/B/C…；零仓位/复盘系统(不配仓位风险)只评估不交易。」

- [ ] **Step 2: 编译 + 回归** — `cd backend && npx tsc --noEmit && npx jest propose-service -i`。Expected: exit 0 + 绿。

- [ ] **Step 3: Commit（待放行）**
```bash
git add backend/src/rulebook/propose-service.ts
git commit -m "feat(rulebook): propose 系统字母守卫(允许 C…)+prompt 说明

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: tradeableSystems + screen 泛化（passedSystems）

**Files:** Modify `backend/src/rulebook/service.ts`（新增 `tradeableSystems`）、`backend/src/screen/service.ts`、`backend/src/chat/service.ts:308`；Test `backend/src/rulebook/service.test.ts`、`backend/src/screen/service.test.ts`

- [ ] **Step 1: 写失败测试（tradeableSystems）** — 在 `backend/src/rulebook/service.test.ts` 末尾的 describe 内追加：
```ts
  it('tradeableSystems 只取有仓位风险(>0)的系统', () => {
    expect(svc.tradeableSystems({ single_trade_risk_pct: { A: 1.0, B: 0.5, C: 0 } })).toEqual(['A', 'B']);
    expect(svc.tradeableSystems({ single_trade_risk_pct: { A: 1.0 } })).toEqual(['A']);
    expect(svc.tradeableSystems({})).toEqual([]);
  });
```

- [ ] **Step 2: 运行确认失败** — `cd backend && npx jest rulebook/service -i -t "tradeableSystems"`。Expected: FAIL（not a function）。

- [ ] **Step 3: 实现 tradeableSystems** — `backend/src/rulebook/service.ts` 末尾追加并导出：
```ts
// 真实交易系统 = positionRules.single_trade_risk_pct 里风险>0 的系统；无配置的系统(如 C)为零仓位/复盘。
export function tradeableSystems(positionRules: any): string[] {
  const risk = (positionRules && positionRules.single_trade_risk_pct) || {};
  return Object.keys(risk).filter((k) => Number(risk[k]) > 0).sort();
}
```

- [ ] **Step 4: 运行确认通过** — `cd backend && npx jest rulebook/service -i -t "tradeableSystems"`。Expected: PASS。

- [ ] **Step 5: 写 screen 失败测试** — 先 `sed -n '1,40p' backend/src/screen/service.test.ts` 看清本文件的脚手架：它如何造「已激活策略」(多半 `rb.instantiateBaseline(USER)`)、如何用 `seedStock(code, fund)` 喂行情让个股**通过 A 系统门槛**。然后在末尾追加一个用例，按现有脚手架造数据，断言 `passedSystems`：

```ts
describe('screen 多系统：C 零仓位不参与选股', () => {
  it('能过 A 的个股 passedSystems 含 A、不含零仓位系统 C', async () => {
    const rbsvc = require('../rulebook/service');
    const U = 'u-multi-screen';
    // 造一套：A 系统一个会过的门槛(净利>0) + C 系统门槛(无仓位配置=零仓位)。
    rbsvc.createVersion(U, {
      versionLabel: '多系统', persona: 'p', parentVersionId: null,
      gates: [
        { system: 'A', gate_key: 'np', label: '净利>0', field: 'net_profit', op: '>', threshold: 0, threshold2: null, ref_field: null, unit: '元', veto: 1, teach: '' },
        { system: 'C', gate_key: 'cd', label: '复盘项', field: 'net_profit', op: '>', threshold: 0, threshold2: null, ref_field: null, unit: '元', veto: 1, teach: '' },
      ],
      softRules: [],
      positionRules: { single_trade_risk_pct: { A: 1.0 } }, // 只有 A 有仓位 → C 零仓位
    });
    // 激活刚建的版本（取该用户最新版本 id）
    const v = rbsvc.listVersions(U)[0];
    rbsvc.activateVersion(U, v.id);
    // 喂一只净利>0 的个股数据（用本文件的 seedStock；字段名以本文件为准）
    seedStock('600000', { net_profit: 1e8 });
    const svc2 = require('./service');
    const r = await svc2.screenCode(U, '600000');
    expect(Array.isArray(r.passedSystems)).toBe(true);
    expect(r.passedSystems).toContain('A'); // A 过
    expect(r.passedSystems).not.toContain('C'); // C 零仓位不参与
  });
});
```
> 注：`seedStock` 用本文件已有的同名辅助（看 Step 5 开头 sed 出来的签名/字段）。若 `createVersion` 的 payload 形状与本仓库不同，按 `rulebook/service.ts` 的 `VersionPayload`/`createVersion` 实参为准（实现前 `grep -n "export function createVersion\|VersionPayload" backend/src/rulebook/service.ts`）。本用例**必须**有真实断言（`passedSystems` 含 A、不含 C），不得留占位。

- [ ] **Step 6: 实现 screen 泛化** — `backend/src/screen/service.ts`：
  - 顶部从 `../rulebook/service` 引入 `tradeableSystems`（与 `getActive` 同处 import）。
  - `ScreenResult` 接口（~57-66）：删 `aPass: boolean; bPass: boolean;`，加 `passedSystems: string[];`。
  - `screenCode`（~71-90）改为：
```ts
  const ev = evaluateGates(snap, rb.gates);
  const tradeable = tradeableSystems(rb.positionRules);
  const passedSystems = tradeable.filter((sys) => {
    const veto = ev.gateResults.filter((g) => g.system === sys && g.veto === 1);
    return veto.length > 0 && veto.every((g) => g.status === 'pass');
  });
  const passed = ev.gateResults.filter((g) => g.status === 'pass').length;
  const failed = ev.gateResults.filter((g) => g.status === 'fail').map((g) => g.gate_key);
  let reason: string;
  if (passedSystems.length) {
    const sys = passedSystems[0];
    const passedLabels = ev.gateResults.filter((g) => g.system === sys && g.status === 'pass').map((g) => g.label);
    reason = `入选（${passedSystems.join('、')} 系统）：通过 ${passedLabels.join('、') || '（无明确门槛）'}`;
  } else {
    const blockers = ev.gateResults.filter((g) => g.veto === 1 && g.status !== 'pass').map((g) => `${g.label}${g.status === 'unknown' ? '(数据缺失)' : '(未达标)'}`);
    reason = `未入选：${blockers.join('、') || '无符合系统'}`;
  }
  return { code, name: snap.name, passedSystems, passed, total: ev.gateResults.length, failed, reason };
```
  - 排序（~104）：`out.sort((a, b) => (b.passedSystems.length ? 1 : 0) - (a.passedSystems.length ? 1 : 0) || b.passed - a.passed);`
  - `discussScreen` 候选清单（~38）：`${r.passedSystems.length ? r.passedSystems.join('/') + ' 通过' : '未过'}`。
  - getHistory 选 picks（~167）：`parsed.filter((x) => (x.passedSystems?.length) || x.aPass || x.bPass)`（`|| x.aPass || x.bPass` 兼容旧库记录）。

- [ ] **Step 7: 改 chat 摘要** — `backend/src/chat/service.ts:308`：`${r.aPass || r.bPass ? '入选' : '未入选'}` 改为 `${(r.passedSystems?.length || r.aPass || r.bPass) ? '入选' : '未入选'}`（兼容旧库）。

- [ ] **Step 8: 运行确认通过 + 回归** — `cd backend && npx jest screen/service rulebook/service -i` 然后 `npm test`。Expected: 全绿。

- [ ] **Step 9: Commit（待放行）**
```bash
git add backend/src/rulebook/service.ts backend/src/screen/service.ts backend/src/chat/service.ts backend/src/rulebook/service.test.ts backend/src/screen/service.test.ts
git commit -m "feat(screen): tradeableSystems 泛化选股(C 零仓位不进选股);ScreenResult.aPass/bPass→passedSystems

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 前端类型放宽 + 选股展示

**Files:** Modify `frontend/src/api/rulebook.ts`、`frontend/src/api/screen.ts`、`frontend/src/views/HomeView.vue`

- [ ] **Step 1: api 类型** —
  - `frontend/src/api/rulebook.ts`：两处 `system: 'A' | 'B';`（Gate ~6、SoftRule ~23）改为 `system: string;`。
  - `frontend/src/api/screen.ts`：`ScreenResult` 删 `aPass: boolean; bPass: boolean;`，加 `passedSystems: string[];`。

- [ ] **Step 2: HomeView 选股展示** —
  - `screenPicks`（~407）：`(screen.value?.results || []).filter((r) => r.passedSystems.length)`。
  - 入选行徽章（~186）：
```vue
                      <span class="badge2" :class="r.passedSystems[0] === 'A' ? 'a' : 'b'">{{ r.passedSystems.join('/') }}</span>
```
  - 若历史选股 `sh-pick` 处用了 aPass/bPass，同步改（`grep -n "aPass\|bPass" HomeView.vue` 确认仅这两处）。

- [ ] **Step 3: 类型检查** — `cd frontend && npx vue-tsc --noEmit`。Expected: exit 0。

- [ ] **Step 4: 走查（dev/容器）** — 保存含 A/B/C 的策略成功；「当前策略」与个股报告里 C 的门槛正常显示；选股结果只标交易系统（如 A、B 或 A/B），C 不出现在入选系统里。

- [ ] **Step 5: Commit（待放行）**
```bash
git add frontend/src/api/rulebook.ts frontend/src/api/screen.ts frontend/src/views/HomeView.vue
git commit -m "feat(fe): 规则/选股类型放宽支持多系统;选股展示用 passedSystems

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 端到端验证

1. `cd backend && npm test` → 全绿（358 + 新增）。
2. `cd frontend && npx vue-tsc --noEmit` → exit 0。
3. `docker compose up -d --build app` 重建；以普通用户：把含 A/B/C 的策略「生成/保存为当前策略」成功（不再 `received 'C'`）；当前策略/个股报告显示 C 门槛；按当前策略选股只跑 A/B、C 不入选。

## 风险 / 注意
- `ScreenResult` 改字段是破坏性的——务必改全所有引用（Task 4 列出的后端 8 处 + chat:308 + 前端 2 处）；旧库 screenings 记录仍带 aPass/bPass，getHistory/chat 摘要已加 `|| x.aPass || x.bPass` 兼容。
- 仓位/敞口计算本身不改：C 无 `single_trade_risk_pct` 配置，自然不占敞口。
- 报告散文结论仍两槽（范围外）；C 由门槛级展示体现。
