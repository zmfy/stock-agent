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
5. **每用户 token 上限(配额)**:admin 设**全局默认上限** + 可**按用户覆盖**;按用户**在所有共享模型上的累计**算;达上限后该用户的共享模型移出池(自动回退到自己的模型,不崩)。**重置周期可由 admin 自由设定**(任意时长:如 5 小时 / 一周 / 不重置),用「固定窗口」实现。

## 数据模型

**改 `ai_configs`** — 加一列：
```sql
ALTER TABLE ai_configs ADD COLUMN shared INTEGER DEFAULT 0;   -- 1 = admin 共享给所有用户
```
（仅当行属于 admin 用户时有意义；非 admin 的 shared 位忽略。）

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

**新表 `shared_ai_user_limit`** — 按用户覆盖上限（无行=用全局默认）：
```sql
CREATE TABLE IF NOT EXISTS shared_ai_user_limit (
  user_id TEXT PRIMARY KEY,
  max_tokens INTEGER NOT NULL    -- 该用户上限(0=不限)
);
```

**全局配额设置** — 存 `settings` 单行 `shared_ai_limit`(JSON)：`{ defaultMaxTokens: number, periodSeconds: number }`。`defaultMaxTokens=0`=不限；`periodSeconds=0`=不重置(终身)，否则按固定窗口重置。`data/service.ts` 的 settings 存取模板可参考(或新增 `getSharedAiLimit/setSharedAiLimit`)。

（migrate() 用 `IF NOT EXISTS` + 对 `ai_configs`/`ai_role_assignments` 的 ALTER 做幂等 try/catch，沿用现有 migrate 习惯。）

**当前窗口算法**：`currentWindow(periodSeconds) = periodSeconds > 0 ? Math.floor(Date.now()/1000/periodSeconds)*periodSeconds : 0`。固定窗口：每过一个 `periodSeconds` 自动进新窗口（如 periodSeconds=5*3600 即每 5 小时；=7*86400 即每周）。

`shared_ai_optout` 进 `account/service.ts` 的 `PER_USER_TABLES`（用户清空/导出随之处理）。`shared_ai_usage` 是 admin 面向的分析数据，**不**进 per-user 清空（保留）。

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
- `sharedConfigs(): ResolvedConfig[]` — `SELECT c.* FROM ai_configs c JOIN users u ON c.user_id=u.id WHERE u.role='admin' AND c.shared=1 AND c.enabled=1`，过滤可用（needsApiKey 的要有 key），解密 admin key，标 `scope:'shared'`、`ref:'shared:'+id`、`ownerConfigId:id`。
- `sharedConfigsForUser(userId): ResolvedConfig[]` — `sharedConfigs()` 去掉该用户 `shared_ai_optout` 命中的，**再做配额闸门**：若 `isOverSharedLimit(userId)` 为真 → 返回 `[]`（共享全部移出池，用户回退到自己的模型）。
- `effectiveLimit(userId): number` — 该用户上限：有 `shared_ai_user_limit` 行用其 `max_tokens`，否则用全局 `defaultMaxTokens`。
- `currentSharedUsage(userId): number` — 当前窗口内、该用户在所有共享模型上的 token 合计：`SELECT COALESCE(SUM(total_tokens),0) FROM shared_ai_usage WHERE user_id=? AND window_start=?`（`window_start`=当前窗口；跨窗口的旧行不计入，等于自动归零）。
- `isOverSharedLimit(userId): boolean` — `const cap = effectiveLimit(userId); return cap > 0 && currentSharedUsage(userId) >= cap;`（cap≤0=不限，永不超）。
- `enabledConfigs(userId)` — 在原「用户自有 enabled」结果（标 `scope:'self'`、`ref:'self:'+provider`）之后 **拼接 `sharedConfigsForUser(userId)`**。自有在前（优先级高于共享）。
- `getModelForRole(userId, role)`：
  - 手动钉：若 `assignment.shared_config_id` 有值 → 在共享池里按 `ownerConfigId` 找（仍 shared+enabled+未 opt-out 才命中）；否则按 `provider` 在自有池找（现有逻辑）。
  - auto：在合成池上按 tier 选（共享条目同样参与）。
  - 兜底 'core' 不变。
- `getActiveConfig` 不变（=`getModelForRole(userId,'core')`）。

**展示用**（不解密）：
- `listSharedForUser(userId)` —— 给 `GET /ai/shared`，**绝不含 key/掩码**。返回 `{ models: Array<{configId, provider, model, label, enabledForMe}>, quota: { cap, used, remaining, periodSeconds, over } }`（cap=effectiveLimit；used=currentSharedUsage；remaining=cap>0?max(0,cap-used):null=不限）。让用户看到本周期剩余额度。label 形如 `共享·<model>`。
- `setSharedOptout(userId, configId, enabled)` —— enabled=false 写 opt-out 行，true 删行。
- admin 侧 `setShared(userId, provider, shared)` —— 切自己 config 的 `shared` 位（仅本人 config）。
- `listConfigs(userId)` 的 `PublicAiConfig` 增 `shared: number`（admin 看到自己模型的共享状态）。

## 用量记账（`ai/manager.ts`）

`chat()` 增可选末参，签名变为：
```ts
export async function chat(style, config, prompt, maxTokens = 64, account?: { userId: string; configId: string }): Promise<string>
```
- 解析响应 `usage`：openai 风格 `usage.total_tokens`；anthropic `usage.input_tokens+output_tokens`；ollama `prompt_eval_count+eval_count`。取不到则 0。
- 返回值仍是文本（**不破坏现有调用**）。
- 若传了 `account` 且 token 解析成功（或即便 0）→ `recordSharedUsage(configId, userId, tokens)`。**整段 try/catch，记账失败绝不影响聊天**。

记账函数放**新模块 `backend/src/ai/usage.ts`**（只依赖 `db`，不依赖 service/manager，避免 import 环；manager 与 routes/service 都可引用）：
- `recordSharedUsage(configId, userId, tokens)`：**窗口感知 UPSERT**——算当前窗口 `cur=currentWindow(periodSeconds)`（从全局 `shared_ai_limit` 读 periodSeconds）；取该 `(config_id,user_id)` 行，若不存在或 `window_start != cur` → 重置为 `{calls:1, total_tokens:tokens, window_start:cur}`，否则 `calls+1, total_tokens+=tokens`。`updated_at=now`。
- `getUsageForConfig(configId): Array<{userId, username, calls, total_tokens}>`：JOIN users 取用户名（取当前窗口口径或累计——展示用，取该 config 行即可）。
- `resetUserUsage(userId)`：删该用户全部 `shared_ai_usage` 行（admin 手动清零）。
- 量度/窗口 helper（`currentWindow`、读 periodSeconds）也放此模块或 `service.ts`，避免环即可。

各调用方（orchestrator / chat·service / meetings / screen / rulebook·propose / rulebook·memory / agent·profiles，约 7 处）把 chat 调用改为透传 account：
```ts
const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
await chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, maxTokens, acct);
```
（additive：不传 account 的路径行为不变。）

## API（`routes/ai.ts`）

- **admin**：`POST /ai/configs/:provider/share { shared: boolean }`（adminMiddleware；切本人该 provider 的 shared 位）。`GET /ai/shared/:configId/usage`（adminMiddleware + 校验该 config 属于本 admin → 否则 403）→ `getUsageForConfig`（每行附该用户 cap/override 以便展示）。
- **admin 配额**：`GET /ai/shared-limit` → `{ defaultMaxTokens, periodSeconds }`；`PUT /ai/shared-limit { defaultMaxTokens, periodSeconds }`（校验非负整数）。`PUT /ai/shared-limit/user/:userId { maxTokens }`（写/删 `shared_ai_user_limit`，maxTokens 省略或 <0 视为删除覆盖=回到默认）。`POST /ai/shared-usage/:userId/reset` → `resetUserUsage`。全部 adminMiddleware。
- **所有用户**：`GET /ai/shared` → `listSharedForUser(userId)`（无 key）。`POST /ai/shared/:configId/enable { enabled }` → `setSharedOptout`。
- **角色钉**：`PUT /ai/roles/:role` body 增可选 `sharedConfigId`；存到 `ai_role_assignments.shared_config_id`（与 provider 二选一）。`listRoleAssignments`/`autoAssignRoles` 纳入共享池，resolved 展示标签「共享·…」。

## 前端

`frontend/src/api/ai.ts` 增：`setShared(provider, shared)`、`getShared()`(返回 `{models, quota}`)、`setSharedEnabled(configId, enabled)`、`getSharedUsage(configId)`、`getSharedLimit()`、`setSharedLimit({defaultMaxTokens, periodSeconds})`、`setUserLimit(userId, maxTokens?)`、`resetUserUsage(userId)`；`setRole` body 支持 `sharedConfigId`；`AiConfig` 类型加 `shared`，新增 `SharedModel`/`Quota` 类型。

`frontend/src/views/AiSettingsView.vue`（模型标签页）：
- **admin**：自己每个模型卡加「☑ 共享给所有用户」勾选 + 共享态下显示「查看使用情况」（展开 `getSharedUsage` 的 用户名/调用次数/token 表，每行可设该用户上限 `setUserLimit` + 「清零用量」`resetUserUsage`）。新增「共享配额」区：默认上限(tokens) + 重置周期（数字 + 单位下拉：不重置/小时/天/周 → 折算成 `periodSeconds`），调 `getSharedLimit/setSharedLimit`。
- **所有用户**：新增「管理员共享的模型」区（仅当 `getShared().models` 非空显示）：每条 provider + model + 「共享」徽标 + 启用开关（默认开，调 `setSharedEnabled`）。区顶显示本周期配额（`quota`：已用 used / 上限 cap / 剩余 remaining；超限红字提示「已达上限，已回退到你自己的模型」）。**无 key 字段、无编辑/删除/测试**。
- **任务分工标签页**：角色下拉候选并入共享模型（值用 `sharedConfigId`，标签「共享·model」）；auto 分工照常。

## 错误处理 / 边界

- 共享模型被 admin 取消共享 / 关 enabled / 删除 → 自动移出池；用户若手动钉了它，`getModelForRole` 找不到则按 auto/兜底解析（不崩）。
- `GET /ai/shared/:configId/usage`：config 不属于当前 admin → 403。
- 非 admin 调 share / usage 路由 → 403。
- 记账（usage）任何异常吞掉，不影响 chat。
- 多 admin：各自共享各自的;用户看到所有 admin 的共享池（按 configId 区分）。

## 测试

- **service**：`shared` 切位、`sharedConfigs` 只取 admin+shared+enabled+可用、`enabledConfigs` 含共享且自有在前、opt-out 默认开/关掉即移出、`getModelForRole` 手动钉 `shared_config_id` 命中共享、auto 选共享、`listSharedForUser` 无 key。
- **配额**：`effectiveLimit`(覆盖优先于默认)、`currentSharedUsage`(只算当前窗口)、`isOverSharedLimit`(cap≤0 不限)、超限时 `sharedConfigsForUser` 返回 []（共享移出池，自有仍在）、`recordSharedUsage` 跨窗口归零(模拟两个窗口 window_start 不同→重置)、`resetUserUsage` 清零、`getUsageForConfig` JOIN 用户名。窗口边界用注入/可控的 now 或显式 periodSeconds 计算（避免依赖真实时间的 flaky）。
- **manager**：`chat` 解析三种风格 usage（mock fetch 返回带 usage 的响应）；传 account 时写 `shared_ai_usage`，不传不写；记账抛错时 chat 仍返回文本。
- **routes**：admin 才能 share（非 admin 403）;`GET /ai/shared` 不漏 key;`GET /ai/shared/:id/usage` 非 owner admin 403;opt-out 开关;角色钉 `sharedConfigId`。

## 不在本次范围

按金额计费、共享模型实时成本估算、跨实例聚合、超额自动通知/告警。配额只做「按 token 总量 + 可配重置窗口的软闸门」（超限即把共享移出该用户的池、回退到自有模型）。
