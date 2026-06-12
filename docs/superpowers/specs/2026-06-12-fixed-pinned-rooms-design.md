# 固定置顶房间 + 移除操作面板 Design

> 把「当前策略 / 早会 / 晚会 / 选股」做成左栏固定置顶、用户不可撤销的 4 个聊天房间；操作面板(右侧操作框)整块删除，其动作内联进各自房间。仅影响普通用户聊天主页。

最后更新：2026-06-12。仓库：`github.com/zmfy/stock-agent`。

## 背景

当前 `HomeView.vue`(普通用户聊天主页)左栏是会话列表(可置顶/删除)，右侧有一个「操作框/操作面板」(`ops`)集中放：打开早会/晚会/选股/当前策略的导航按钮、生成早会/晚会、按当前策略选股、更换模板、让来财提议修改策略、A 股日历。

每个特殊 kind(`core_principle`/`morning`/`evening`/`screen`)其实是**每用户一个持久会话**(`sessions.find(x => x.kind === ...)`)，首次打开时 lazy 创建。`pinned` 已是 `chat_sessions` 的现有列，`listSessions` 已按 `pinned DESC, created_at DESC` 排序。

目标：把这 4 个房间固定置顶在左栏最上、用户不可取消置顶/删除；删除整个操作面板，把其动作搬进各自房间。这样左栏即导航，交互更直观。

## 已确认决策

- **动作归属**：操作面板的「动作」类按钮(生成早会/晚会、按当前策略选股、更换模板、提议修改策略)移进各自置顶房间内；操作面板整块删除。
- **A 股日历**：挪到顶栏(topnav)一个小按钮，跨房间通用(不塞进某房间)。
- **新用户显示**：4 个房间**始终都显示**；未定策略时各房间内自处理空态(选股室提示去定策略；早/晚会室照常只看大盘/板块；策略室引导聊出策略)。

## A. 左栏 4 个固定置顶房间

### 前端 `HomeView.vue`
- 进入聊天主页(普通用户分支)`onMounted` 里调用 `ensureFixedRooms()`：对 `['core_principle','morning','evening','screen']` 逐个确保会话存在(不存在则创建)且 `pinned=1`，随后 `loadSessions()`。
- 会话列表渲染顺序：**先按固定 kind 次序排 4 个特殊房间**(`core_principle` → `morning` → `evening` → `screen`)，再排其余(`stock`)会话(`pinned DESC, created_at DESC`)。用一个 computed `orderedSessions` 实现：把特殊 kind 抽出按固定次序置顶，其余追加在后。
- 4 个特殊房间：**不渲染** 📌 置顶切换按钮与 × 删除按钮(模板里这两个按钮加 `v-if="!isFixedRoom(s.kind)"`)。`isFixedRoom(kind)` = kind ∈ 上述 4 个。
- 左栏标题「讨论记录」保留；4 个房间用各自 `kindIcon` + `sessionLabel` 显示(当前策略探讨 / 早会讨论 / 晚会讨论 / 选股讨论)。

### 后端 `chat/service.ts`(双保险)
- `togglePin(userId, sessionId)`：若该会话 kind ∈ 4 个固定 kind → 抛 `FIXED_ROOM`(不允许改置顶；它们恒为 pinned)。
- 删除会话(现有删除函数，确认其名，如 `deleteSession`/`removeSession`)：kind ∈ 4 个固定 kind → 抛 `FIXED_ROOM`。
- 路由层把 `FIXED_ROOM` 映射为 409(`errorResponse(res, 409, 'BUSINESS_CONFLICT', '固定房间不可置顶/删除')`)。
- 保证特殊会话 `pinned=1`：新增后端 `ensureFixedRooms(userId)` 幂等创建并置顶，返回会话列表。

> 实现取舍(留给 writing-plans 定细节)：`ensureFixedRooms` 放后端(新 `POST /api/chat/ensure-fixed-rooms` 幂等返回 4 个会话)还是前端循环 `createSession`。本设计倾向**后端 `ensureFixedRooms`**：一次调用幂等建齐 4 个并置顶，返回会话列表，更省往返且保证 `pinned=1`。

## B. 删除操作面板，动作内联进各房间

### 删除
- 删除 `HomeView.vue` 右侧「操作框」整段(`ops-head` + 各 `ops-btn` + 日历区)、右下角 `ops-fab` 悬浮按钮、`opsOpen` 状态及相关样式。

### 各房间视图顶部动作(在聊天区 `active` 视图内，按 `active.kind` 分支)
- **早会室(`morning`)**：今日已生成 → 显示内容(现状)；未生成 → 「📈 生成今日早会」按钮(调 `genMeeting('morning')`)。
- **晚会室(`evening`)**：同理「🌙 生成今日晚会」(`genMeeting('evening')`)。
- **选股室(`screen`)**：「🔍 按当前策略选股」按钮(`runScreen`) + 现有「历史选股记录」折叠区(`screen-box`)。无当前策略 → 显示「先去『当前策略』房间定一套」+ 点击切到 `core_principle` 房间(不调用选股)。
- **当前策略室(`core_principle`)**：把现有 ops 面板里的「更换模板」入口 + 模板区 + 「🛠 生成当前策略 / 让来财提议修改」(`synthesizePrinciple`/`propose`，按 `needsInit` 分支)搬进该房间视图顶部。保留现有 `needsInit` 的引导(聊出策略 / 选模板)。

### A 股日历
- 顶栏(`topnav`)加一个 📅 小按钮(普通用户分支)，点击弹出当月日历(复用现有 `toggleCalendar` + 日历渲染，从 ops 面板迁出)。admin 顶栏不加。

## C. 空态 / 文案
- 空聊天首页(无 `active`)CTA：保留 `needsInit`「你还没有当前策略」+ 个股快速输入框。把文案「或在右侧操作框点『当前策略讨论 / 更换模板』」「点右侧操作框…」等改为指向左侧房间(如「点左侧『当前策略』房间」)。
- 4 个房间始终显示，空/无策略态在各房间内处理(见 B)。

## D. 错误处理 / 边界
- 固定房间不可取消置顶/删除：前端隐藏入口 + 后端 409 兜底。
- `ensureFixedRooms` 幂等：重复调用不产生重复会话(按 `(user_id, kind)` 查重，每 kind 至多一个固定房间)。
- 早/晚会、选股的「生成/选股」失败：沿用现有 `genErr`/`noteErrorToSession` 错误展示，不变。
- admin 纯运维无聊天主页，本改动不触及 admin 分支。

## E. 不在本次范围
- 不改早会/晚会/选股的生成逻辑与后端算法本身(只搬动按钮位置)。
- 不改个股(`stock`)会话的置顶/删除行为。
- 不动 AI/插件/数据等其它面板。

## F. 测试
- 后端(jest)：`ensureFixedRooms` 幂等(调两次仍只 4 个、均 pinned=1)；`togglePin`/删除对固定 kind 抛 `FIXED_ROOM`(路由 409)；普通(stock)会话仍可置顶/删除。
- 前端(无 runner)：`vue-tsc --noEmit` + 走查——4 房间固定置顶且无 📌/×；操作面板与 fab 已删除；各房间动作就位；A 股日历在顶栏；选股室无策略提示。
