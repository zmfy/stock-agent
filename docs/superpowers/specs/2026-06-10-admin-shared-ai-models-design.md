# Admin 共享 AI 大模型 Design

> admin 可把自己配置的 AI 大模型「共享」给所有用户;用户在自己的 AI 设置里能看到并选用共享模型(默认开、可关),**看不到也改不了 key**,只能用/不用;可与自己的模型一起用。admin 能看到谁在用自己共享的模型、各消耗多少 token。

最后更新：2026-06-10。仓库：`github.com/zmfy/stock-agent`。

## 背景 / 动机

当前 AI 配置全是 per-user(`ai_configs` 按 `(user_id, provider)`),解析全部过 `getModelForRole()`+`enabledConfigs()`(`backend/src/ai/service.ts`)。admin 只是 `role='admin'` 的普通用户、有自己的 `ai_configs` 行。没有任何共享概念。本功能让 admin 把模型共享出去,新手无需自备 key 即可用系统(走 admin 的 key),也方便统一供给。

## 已确认决策

1. **每个共享模型 per-user 开关,默认开**:admin 一共享,所有用户立刻进池(auto 分工也考虑);用户可各自关掉某个。复用项目「默认全开、只存停用行」模式(只存 opt-out)。
2. **key 绝不外泄**:共享模型对非 admin **不返回 key、连掩码都不给**;只在 server 端解密 admin 的 key 来跑。用户对共享模型**不能编辑/删除/测试**,只能用/不用。
3. **admin 查看用量**:谁在用 + 各用户消耗 token(精确取 provider 返回的 usage)。
4. 共享模型身份 = 该 `ai_configs.id`(admin 拥有),对多 admin / 同 provider 不歧义。
5. **共享模型配额 = 按每个共享模型、全局统一计量**(2026-06-10 修订):admin 给某共享模型设 `max_tokens`(如 1000)+ `period_seconds`(如 5 小时)。一个窗口内,**所有用户(含 admin)用这个模型的 token 总和** ≥ cap → 这个共享模型对**所有人**暂时停用,到下个窗口恢复。**不区分 per-user**(统一计量,省去逐人设定,也保证 token 不浪费)。admin 仍能看「谁用了多少」明细。`period_seconds=0`=不重置(终身);`max_tokens=0`=不限。
6. **防 429 算法**:很多人同时打 admin 这一个共享 key 易触发大模型限流。用**按 key 的自适应节流**(per-key 串行队列 + 最小间隔 + 429 时自适应加宽间隔 / 成功后衰减回落,遵循 Retry-After)。

## 数据模型

**改 `ai_configs`** — 加三列（仅当行属于 admin 用户时有意义）：
```sql
ALTER TABLE ai_configs ADD COLUMN shared INTEGER DEFAULT 0;              -- 1 = admin 共享给所有用户
ALTER TABLE ai_configs ADD COLUMN share_max_tokens INTEGER DEFAULT 0;   -- 该共享模型窗口内全局 token 上限(0=不限)
ALTER TABLE ai_configs ADD COLUMN share_period_seconds INTEGER DEFAULT 0; -- 重置窗口秒数(0=不重置/终身)
```

**改 `ai_role_assignments`** — 加一列：
```sql
ALTER TABLE ai_role_assignments ADD COLUMN shared_config_id TEXT;  -- 手动钉到共享模型时存其 config id；否则 NULL（钉自有 provider）
```

**新表 `shared_ai_optout`** — 只在用户「关掉」某共享模型时存一行（默认开=无行）：
```sql
CREATE TABLE IF NOT EXISTS shared_ai_optout (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, config_id)
);
```

**新表 `shared_ai_usage`** — admin 共享模型的用量账（按 共享config × 消费用户 × 当前窗口）：
```sql
CREATE TABLE IF NOT EXISTS shared_ai_usage (
  config_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  calls INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  window_start INTEGER DEFAULT 0,   -- 当前统计窗口起点(unix 秒)；0=不重置(终身累计)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (config_id, user_id)
);
```

（无 per-user 上限表、无全局上限设置——配额改为「每个共享模型自带 max+period」，全局统一计量。）

（migrate() 用 `IF NOT EXISTS` + 对 `ai_configs`/`ai_role_assignments` 的 ALTER 做幂等 try/catch，沿用现有 migrate 习惯。）

**当前窗口算法**：`currentWindow(periodSeconds) = periodSeconds > 0 ? Math.floor(Date.now()/1000/periodSeconds)*periodSeconds : 0`。固定窗口：每过一个 `periodSeconds` 自动进新窗口（如 periodSeconds=5*3600 即每 5 小时；=7*86400 即每周）。`period_seconds` 取自**该共享模型**的 `ai_configs.share_period_seconds`。

`shared_ai_optout` 进 `account/service.ts` 的 `PER_USER_TABLES`（用户清空/导出随之处理）。`shared_ai_usage` 是 admin 面向的用量/配额数据，**不**进 per-user 清空（保留——它是全局计量的一部分）。

## 解析层（核心 hook，`ai/service.ts`）

扩展 `ResolvedConfig` 增加溯源字段（向后兼容，现有字段不变）：
```ts
export interface ResolvedConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  scope?: 'self' | 'shared';     // 缺省视为 self
  ref?: string;                  // 'self:<provider>' | 'shared:<configId>'，池内稳定标识
  ownerConfigId?: string;        // 共享时=admin 的 config id（记账/解 key 用）
}
```

新增/改：
- `currentConfigUsage(configId, periodSeconds): number` — **全局**（所有用户含 admin）当前窗口该模型的 token 合计：`SELECT COALESCE(SUM(total_tokens),0) FROM shared_ai_usage WHERE config_id=? AND window_start=?`（`window_start`=`currentWindow(periodSeconds)`；跨窗口旧行不计入=自动归零）。
- `isConfigOverLimit(cfgRow): boolean` — `cfgRow.share_max_tokens > 0 && currentConfigUsage(cfgRow.id, cfgRow.share_period_seconds) >= cfgRow.share_max_tokens`。
- `sharedConfigs(): ResolvedConfig[]` — `SELECT c.* FROM ai_configs c JOIN users u ON c.user_id=u.id WHERE u.role='admin' AND c.shared=1 AND c.enabled=1`，过滤可用（needsApiKey 的要有 key），**再剔除 `isConfigOverLimit` 为真的**（全局超限→对所有人停用），解密 admin key，标 `scope:'shared'`、`ref:'shared:'+id`、`ownerConfigId:id`。
- `sharedConfigsForUser(userId): ResolvedConfig[]` — `sharedConfigs()` 去掉该用户 `shared_ai_optout` 命中的。（配额是全局的，已在 `sharedConfigs` 里按模型剔除，无需 per-user 判定。）
- `enabledConfigs(userId)` — 在原「用户自有 enabled」结果（标 `scope:'self'`、`ref:'self:'+provider`）之后 **拼接 `sharedConfigsForUser(userId)`**。自有在前（优先级高于共享）。
- `getModelForRole(userId, role)`：
  - 手动钉：若 `assignment.shared_config_id` 有值 → 在共享池里按 `ownerConfigId` 找（仍 shared+enabled+未 opt-out 才命中）；否则按 `provider` 在自有池找（现有逻辑）。
  - auto：在合成池上按 tier 选（共享条目同样参与）。
  - 兜底 'core' 不变。
- `getActiveConfig` 不变（=`getModelForRole(userId,'core')`）。

**展示用**（不解密）：
- `listSharedForUser(userId)` —— 给 `GET /ai/shared`，**绝不含 key/掩码**。返回 `Array<{ configId, provider, model, label, enabledForMe, quota: { cap, used, remaining, periodSeconds, over } }>`：**注意 `sharedConfigs` 这里要列出全部共享模型(含已超限的，标 `over:true`)以便展示**——所以展示用单独查 `ai_configs`（不经 `sharedConfigs` 的剔除）。每个模型的 `used=currentConfigUsage(id, period)`、`cap=share_max_tokens`、`remaining=cap>0?max(0,cap-used):null`、`over=isConfigOverLimit`。让用户看到该共享模型本周期的全局剩余额度。label 形如 `共享·<model>`。
- `setSharedOptout(userId, configId, enabled)` —— enabled=false 写 opt-out 行，true 删行。
- admin 侧 `setShared(userId, provider, { shared, maxTokens, periodSeconds })` —— 切自己 config 的 `shared` 位并写 `share_max_tokens`/`share_period_seconds`（仅本人 config）。
- `listConfigs(userId)` 的 `PublicAiConfig` 增 `shared: number`、`shareMaxTokens: number`、`sharePeriodSeconds: number`（admin 看到自己模型的共享状态与配额）。

## 用量记账（`ai/manager.ts`）

`chat()` 增可选末参，签名变为：
```ts
export async function chat(style, config, prompt, maxTokens = 64, account?: { userId: string; configId: string }): Promise<string>
```
- 解析响应 `usage`：openai 风格 `usage.total_tokens`；anthropic `usage.input_tokens+output_tokens`；ollama `prompt_eval_count+eval_count`。取不到则 0。
- 返回值仍是文本（**不破坏现有调用**）。
- 若传了 `account` 且 token 解析成功（或即便 0）→ `recordSharedUsage(configId, userId, tokens)`。**整段 try/catch，记账失败绝不影响聊天**。

记账函数放**新模块 `backend/src/ai/usage.ts`**（只依赖 `db`，不依赖 service/manager，避免 import 环；manager 与 routes/service 都可引用）：
- `recordSharedUsage(configId, userId, tokens)`：**窗口感知 UPSERT**——读该 `configId` 的 `share_period_seconds`，算 `cur=currentWindow(period)`；取该 `(config_id,user_id)` 行，若不存在或 `window_start != cur` → 重置为 `{calls:1, total_tokens:tokens, window_start:cur}`，否则 `calls+1, total_tokens+=tokens`。`updated_at=now`。
- `getUsageForConfig(configId, periodSeconds): Array<{userId, username, calls, total_tokens}>`：`WHERE config_id=? AND window_start=currentWindow(periodSeconds)` + JOIN users 取用户名（只列当前窗口在用的用户；旧窗口行不展示）。
- `resetConfigUsage(configId)`：删该模型全部 `shared_ai_usage` 行（admin 手动清零该共享模型用量）。
- `currentWindow(periodSeconds)` helper 放此模块。

各调用方（orchestrator / chat·service / meetings / screen / rulebook·propose / rulebook·memory / agent·profiles，约 7 处）把 chat 调用改为透传 account：
```ts
const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, maxTokens, acct);
```
（additive：不传 account 的路径行为不变。）

## 防 429 算法：按 key 自适应节流（`ai/manager.ts`）

现状：单条**全局**链 + 700ms 间隔串行**所有** LLM 调用 + `withRetry`(429/5xx 指数退避，遵循 Retry-After)。问题：共享模型让很多用户都打 admin 这**同一个 key**，全局串行虽不并发，但固定 700ms 未必匹配该 key 的真实限速；且不相关的 key 被同一条链拖慢。

**升级为按 key 的自适应节流**：
- `keyId = sha256(provider + '|' + baseUrl + '|' + apiKey)`（只做 map 键，不存原 key）。
- `Map<keyId, { chain: Promise; lastStart: number; interval: number }>`。`schedule(keyId, fn)`：每个 keyId 一条链，`wait = max(0, lastStart + interval - now)`，**同 key 串行 + 间隔**；**不同 key 各自独立并行**（互不拖慢）。
- **自适应间隔(AIMD)**：`interval` 初值 `BASE`(=现 700ms，env `AI_MIN_INTERVAL_MS`)，上限 `MAX`(如 8000ms)。
  - 命中 429 时：该 keyId `interval = min(MAX, interval * 2)`（乘性增大）；本次重试的 backoff 仍优先用 `Retry-After`。
  - 连续成功时：`interval = max(BASE, interval - STEP)`（线性回落，STEP 如 150ms），慢慢恢复。
- 这样**所有人打共享 key 时会自动排队 + 间隔，并按该 key 实际限速自调**，把 429 压到最低；用户自有 key 不受影响。
- 测试环境(`IS_TEST`)维持 `interval=0`、`MAX_RETRIES=0`（不拖慢测试，与现状一致）。
- chat() 计算 keyId 走此 `schedule`；`withRetry` 在 429 分支回调「加宽该 keyId interval」，成功路径回调「回落」。

> 这是对现有全局节流的**泛化**（单 key 时行为等价于今天），不改 chat() 对外签名（除已说的可选 `account` 末参）。

## API（`routes/ai.ts`）

- **admin**：`POST /ai/configs/:provider/share { shared: boolean, maxTokens?: number, periodSeconds?: number }`（adminMiddleware；切本人该 provider 的 shared 位并写配额，校验非负整数）。`GET /ai/shared/:configId/usage`（adminMiddleware + 校验该 config 属于本 admin → 否则 403）→ `{ total, cap, periodSeconds, rows: getUsageForConfig }`（total=当前窗口全局合计）。`POST /ai/shared/:configId/reset-usage`（同上鉴权）→ `resetConfigUsage`。
- **所有用户**：`GET /ai/shared` → `listSharedForUser(userId)`（无 key，含每模型全局配额 used/cap/remaining/over）。`POST /ai/shared/:configId/enable { enabled }` → `setSharedOptout`。
- **角色钉**：`PUT /ai/roles/:role` body 增可选 `sharedConfigId`；存到 `ai_role_assignments.shared_config_id`（与 provider 二选一）。`listRoleAssignments`/`autoAssignRoles` 纳入共享池，resolved 展示标签「共享·…」。

## 前端

`frontend/src/api/ai.ts` 增：`setShared(provider, {shared, maxTokens, periodSeconds})`、`getShared()`(返回 `SharedModel[]`，每个含 quota)、`setSharedEnabled(configId, enabled)`、`getSharedUsage(configId)`(返回 `{total, cap, periodSeconds, rows}`)、`resetConfigUsage(configId)`；`setRole` body 支持 `sharedConfigId`；`AiConfig` 类型加 `shared/shareMaxTokens/sharePeriodSeconds`，新增 `SharedModel`/`Quota` 类型。

`frontend/src/views/AiSettingsView.vue`（模型标签页）：
- **admin**：自己每个模型卡加「☑ 共享给所有用户」勾选 + **配额输入**（最大 token 数 + 重置周期：数字 + 单位下拉 不重置/小时/天/周 → 折算 `periodSeconds`），保存调 `setShared`。共享态下显示「查看使用情况」：本窗口全局合计 total / cap、各用户用量明细（`getSharedUsage` 的 用户名/调用次数/token）+「清零用量」`resetConfigUsage`。
- **所有用户**：新增「管理员共享的模型」区（仅当 `getShared()` 非空显示）：每条 provider + model + 「共享」徽标 + 启用开关（默认开，调 `setSharedEnabled`）+ 该模型本周期配额（已用/上限/剩余，全局共享；`over=true` 时红字「该共享模型本周期额度已用完，已暂停，下个周期恢复」）。**无 key 字段、无编辑/删除/测试**。
- **任务分工标签页**：角色下拉候选并入共享模型（值用 `sharedConfigId`，标签「共享·model」）；auto 分工照常。

## 错误处理 / 边界

- 共享模型被 admin 取消共享 / 关 enabled / 删除 → 自动移出池；用户若手动钉了它，`getModelForRole` 找不到则按 auto/兜底解析（不崩）。
- `GET /ai/shared/:configId/usage`、`reset-usage`：config 不属于当前 admin → 403。
- 非 admin 调 share / usage / reset 路由 → 403。
- 记账（usage）任何异常吞掉，不影响 chat。
- 多 admin：各自共享各自的;用户看到所有 admin 的共享池（按 configId 区分）；各模型配额独立。
- 共享模型全局超限 → 对所有人（含 admin 自己）暂停，到下个窗口自动恢复；用户/agent 解析时自动回退到自有模型，无自有则 `NO_MODEL`（现有行为）。
- 改 `share_period_seconds` 后旧用量行 window_start 不匹配新窗口→等于该模型用量归零（可接受）。

## 测试

- **service**：`shared` 切位、`sharedConfigs` 只取 admin+shared+enabled+可用、`enabledConfigs` 含共享且自有在前、opt-out 默认开/关掉即移出、`getModelForRole` 手动钉 `shared_config_id` 命中共享、auto 选共享、`listSharedForUser` 无 key。
- **配额(按模型全局)**：`currentConfigUsage`(只算当前窗口、汇总所有用户)、`isConfigOverLimit`(cap≤0 不限)、超限时 `sharedConfigs` 剔除该模型（对所有人，自有仍在）、`recordSharedUsage` 跨窗口归零(模拟两窗口 window_start 不同→重置)、`resetConfigUsage` 清零、`getUsageForConfig` JOIN 用户名、`listSharedForUser` 的 quota(used/cap/remaining/over)。窗口边界用可控的 periodSeconds / 直接构造不同 window_start 行（避免依赖真实时间的 flaky）。
- **防 429 节流**：同一 keyId 的两次 `schedule` 串行（第二次在第一次后启动）；不同 keyId 可并行；429 后该 keyId interval 翻倍（上限封顶）、成功后回落；`withRetry` 优先用 Retry-After。用 fake timers / 可注入 now + mock fetch 返回 429 来测，`IS_TEST` 下不真 sleep。
- **manager**：`chat` 解析三种风格 usage（mock fetch 返回带 usage 的响应）；传 account 时写 `shared_ai_usage`，不传不写；记账抛错时 chat 仍返回文本。
- **routes**：admin 才能 share（非 admin 403）;`GET /ai/shared` 不漏 key;`GET /ai/shared/:id/usage` 非 owner admin 403;opt-out 开关;角色钉 `sharedConfigId`。

## 不在本次范围

按金额计费、共享模型实时成本估算、跨实例聚合、超额自动通知/告警。配额只做「每个共享模型按 token 全局总量 + 可配重置窗口的软闸门」（超限即把该共享模型对所有人停用、各自回退到自有模型）。
