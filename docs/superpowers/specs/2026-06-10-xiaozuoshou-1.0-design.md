# 小作手 1.0 Design（品牌 + admin 运维化 + 数据收紧/告警 + 实时数据 + 共享插件）

> 一批面向 1.0 的发布级改动。实现按阶段分批做(每阶段独立可测可提交)。

最后更新：2026-06-10。仓库：`github.com/zmfy/stock-agent`。

## 范围(7 块，A–G)与已确认决策
- A 品牌改名:`股票小作手`→`小作手`、版本 `1.0.0`、广告语「您的决策小助手」。
- B 文案改名:用户可见的「核心原则/核心规则」→「当前策略」(内部 key `core_principle` 不动)。
- C **admin = 纯运维账号**:登录后按角色分流,admin 不显示交易功能(聊天/策略/分析/早晚会/选股)。
- D 数据**触发类**接口仅 admin(refresh/采集新闻/同步任务);普通用户保留只读。
- E 数据异常**站内告警**(先做站内,不发邮件)。
- F 实时数据定时任务(每5分钟、仅交易时段、拉已缓存股票),**实时表存盘口五档**。
- G **能力插件共享**(admin 共享插件给用户;用户只能用/不用,不能看/改 admin 共享插件的配置;可加自己的)。

---

## A. 品牌改名

| 位置 | 改动 |
|---|---|
| `frontend/index.html` / `backend/public/index.html` `<title>` | `股票小作手`→`小作手` |
| `frontend/src/views/LoginView.vue` logo/hint | `📈 小作手` + 广告语「您的决策小助手」 |
| `HomeView.vue` brand(line 7)、问候语(line 55) | `小作手`;问候「你好，我是来财。」 |
| `RegisterView.vue`(line 21/23-24) | `注册 · 小作手`，免责声明产品名同改 |
| `frontend/package.json` + `backend/package.json` version | `0.1.0`→`1.0.0`;backend description「小作手 backend」 |
| 版本号展示 | 登录页 + 普通用户左栏底/admin 运维页底显示 `v1.0`(读 `__APP_VERSION__` 或硬编码常量 `APP_VERSION='1.0'`) |

主 agent 名 `AGENT_NAME='来财'` 不变(人设≠产品名)。

## B. 核心原则/核心规则 → 当前策略

所有**用户可见**字符串改「当前策略」;**不改** `core_principle`/`ChatKind`/rulebook 表名/API 路径(纯显示文案)。涉及:
- `HomeView.vue`:CTA「你还没有当前策略」、按钮「当前策略讨论 / 更换模板」、「按当前策略选股」、「重新按当前策略分析」、生成/换入提示等(约 10 处「核心原则」)。
- `OnboardingView.vue`:「① 选当前策略」「选一个策略模板」。
- `RulebookView.vue` 标题 `核心规则`→`当前策略`;`HomeView` SETTINGS 菜单 label `核心规则`→`当前策略`。
- 后端 `chat/service.ts`(KIND_FRAMING、CORE_PRINCIPLE_INTERVIEW_FRAMING)、`agent/profiles-service.ts` 等 **来财对用户说的话** 里「核心原则」→「当前策略」(prompt 文案，保持 UI 一致)。

## C. admin 纯运维账号（角色分流）

**前端**:`HomeView.vue` 按 `auth.isAdmin` 分两套布局:
- **admin → 运维主页**(无聊天 shell):顶部品牌 + 版本 + **数据告警条**(E);菜单(横向标签)= 数据管理 | 定时任务 | 数据告警 | AI模型 | 能力插件 | 用户管理 | 账号。**不渲染** 聊天区、当前策略讨论、选股、早晚会、分析等交易入口。
- **普通用户 → 交易主页**(现状):聊天 shell + 当前策略 | 早晚会 | 分析 | AI模型 | 能力插件 | 账号。**不显示** 数据管理 | 定时任务 | 用户管理 | 数据告警。
- 菜单用 computed 按 role 过滤(`SETTINGS` 加 `roles:['admin'|'user'|'both']` 字段;admin 项如 data/crons/alerts/users 仅 admin,交易项仅 user,ai/plugins/account both)。
- 路由守卫:admin 访问交易路由 → 重定向运维主页;反之同理(可选,先做菜单层隐藏)。

**后端**:无需改鉴权模型(admin 接口已 adminMiddleware;交易接口普通用户可用)。admin 不用交易接口即可。

> 取舍(已确认):admin 是纯运维账号,无法自己体验交易功能。admin 保留 AI模型(用于共享给用户)与能力插件(用于共享，见 G)。

## D. 数据触发类接口仅 admin

`routes/data.ts` 给当前开放给任意登录用户的**写/触发**接口加 `adminMiddleware`:
- `POST /refresh`、`POST /news/refresh`、`POST /:job/run`(stock_universe/eod)。
- **保留普通用户只读**:`GET /snapshot/:code`、`GET /stocks/search`、`GET /trade-calendar`、`GET /news`、`GET /news/content/:id`、`GET /source`、`GET /probe*`(交易页/分析要用)。
- 配置/取消/日志类本就 admin,不变。
- 路由测试:普通用户触发 → 403;admin → 200。

## E. 数据异常站内告警

新 `backend/src/data/alerts.ts`:`getDataAlerts(): Alert[]`，**从现有状态实时计算**(无新表)：
- `sync_status` 中 `stock_universe`/`eod` `state='error'` → 告警(含 error、finished_at)。
- 同两者 `last_success_at` 早于「上一交易日」→「数据陈旧」告警。
- 数据类 `cron_status`(nightly/eod/stock_universe/realtime)`last_status='error'` → 告警。
- sidecar 不可达(`pingHealth` 失败)→ 告警。
- 大盘 `market_sentiment` 最新日期早于上一交易日 → 告警。
- `Alert = { level:'error'|'warn', source, message, since }`；问题恢复后下次计算自动消失(不持久化)。
- 路由 `GET /api/data/alerts`(adminMiddleware)。前端 admin 运维主页顶部红条(有 error)/黄条(warn)显示条数 + 「数据告警」页列明细;轮询(如 30s)刷新。

## F. 实时数据定时任务（含盘口五档）

- **sidecar**:`/realtime/{code}` 扩展返回**盘口五档**——`bid1..bid5`/`ask1..ask5` 价与量(TDX `c.quotes()` 本就含 bid/ask 5 档)。
- **新表 `realtime_quote`**：
  ```sql
  CREATE TABLE IF NOT EXISTS realtime_quote (
    code TEXT PRIMARY KEY,
    price REAL, open REAL, high REAL, low REAL, prev_close REAL, volume REAL,
    bid1 REAL, bid1_vol REAL, ... bid5 REAL, bid5_vol REAL,
    ask1 REAL, ask1_vol REAL, ... ask5 REAL, ask5_vol REAL,
    time TEXT, source TEXT, fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  ```
- `data/service.ts`:`cacheRealtime(code,data,source)`、`getRealtime(code)`;`ingestRealtime(userId)`:遍历 `listCachedCodes()`,`fetchRealtime`(带五档)写表;**交易时段闸门**——`isTradingDay(beijingToday)` 且北京时间在 09:30–11:30 或 13:00–15:00 才跑,否则 log「非交易时段跳过」并 return。
- `fetchRealtime` 扩展解析五档字段(兼容旧返回)。
- **cron 注册表**加 `{ key:'realtime', label:'实时行情(交易时段)', description:'TDX 拉已缓存股票实时盘口，每5分钟、仅交易时段', defaultExpr:'*/5 * * * *', run: runRealtime }`;`runRealtime` 用 pickRefreshUserId 选数据源用户后 `ingestRealtime`。admin 在「定时任务」页改周期/启停/立即跑(已有)。
- `getStockSnapshot` 的 `realtime` 字段:优先读 `realtime_quote`(新鲜，如 <2min),否则 live `fetchRealtime` 兜底;个股页可展示五档。

## G. 能力插件共享（admin → 用户，仿共享 AI 模型）

复用 shared-AI 模式。`plugins` 表加 `shared INTEGER DEFAULT 0`(admin 行的插件标记共享)。新表 `shared_plugin_optout(user_id, plugin_key, UNIQUE)`（默认开、只存停用）。
- `plugins/service.ts`:
  - `sharedPlugins()`:取 admin 用户 `shared=1` 的插件(key + config)。
  - `setShared(adminUserId, key, shared)`:admin 切自己插件的 shared 位。
  - `listForUser` 合并:用户自有插件 + admin 共享插件(标 `shared:true, owner:'admin'`，**不返回 config 明文**,只给「已配置」标记);用户对共享插件只能 enable/disable(写 `shared_plugin_optout`),不能改 config。
  - `getEnabledCapabilities`/`skillDirectives`:把用户**未 opt-out 的 admin 共享插件**(用 admin 的 config)并入用户的启用能力。
- 路由 `routes/plugins.ts`:admin `POST /plugins/:key/share {shared}`;用户 `POST /plugins/shared/:key/enable {enabled}`(写 opt-out);`GET /plugins` 区分 own / shared(shared 不含 config)。
- 前端 `PluginsView.vue`:admin 每个插件加「共享给所有用户」勾选;用户页新增「管理员共享的插件」区(只读 + 启用开关,无配置/编辑)。
- 共享插件不需要用量/配额(MCP/skill 不计费)。

## 错误处理 / 边界
- C 角色分流:admin 误入交易、用户误入运维 → 菜单不渲染 + 路由重定向兜底。
- D：普通用户触发取数 403,前端交易页不暴露这些按钮(交易页本就不含数据触发)。
- E：告警全靠现有状态计算,问题修复自动清;sidecar 探测失败用短超时,不拖慢。
- F：非交易时段 cron 直接跳过(不空跑);realtime_quote 按 code upsert(只留最新);拉取失败单只跳过、不中断整轮。
- G：admin 取消共享/删除插件 → 用户侧自动消失;共享插件对用户**永不返回 config**(含密钥的 MCP 配置不外泄)。

## 测试
- A/B：改名为字符串,靠 vue-tsc + 冒烟;关键文案加 1-2 个断言(如登录页含「小作手」「您的决策小助手」)。
- C：前端 `settingsMenu`/分流 computed 单测(admin 菜单不含交易项、user 不含运维项)。
- D：`routes/data.test` 普通用户触发 403、admin 200。
- E：`alerts` 纯函数测(造 sync_status error / 陈旧 / cron error → 期望告警;全正常 → 空)。
- F：`ingestRealtime` 交易时段闸门(注入 now,非交易时段跳过、交易时段写表);五档解析;`getStockSnapshot` 优先读 realtime_quote。cron 真实定时不测。
- G：service 测(setShared、sharedPlugins、listForUser 合并且无 config、opt-out、getEnabledCapabilities 并入共享);路由 admin/用户鉴权;前端 vue-tsc。

## 实现分阶段(建议)
1. **A+B 改名**(纯文案/版本)。
2. **C+D admin 运维化 + 数据触发收紧**(角色分流 + 接口鉴权)。
3. **E 数据告警**。
4. **F 实时数据(五档)**。
5. **G 共享插件**。
每阶段一个 writing-plans 计划、独立 TDD + 提交 + 容器验证。

## 不在本次范围
邮件/SMTP 告警(E 先只做站内)、自选股(F 用已缓存股票)、共享插件的用量统计、盘口逐笔/分时。
