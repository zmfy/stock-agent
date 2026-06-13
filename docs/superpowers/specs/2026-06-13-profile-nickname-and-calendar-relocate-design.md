# 账号昵称编辑 + A股日历移入状态条 Design

> 两处独立小改：① 账号设置里显示用户名(只读)、可编辑昵称(需新后端端点)；② A 股日历从顶栏移入状态条最右端，抽成独立小图标弹层组件。

最后更新：2026-06-13。仓库：`github.com/zmfy/stock-agent`。

## 背景

- `users` 表有 `nickname` 列；`auth.user.nickname` 已存在;右上角按钮显示 `nickname || username`。但**无更新昵称的后端端点**(`routes/account.ts` 只有 backup/restore/reset)，SettingsView 也无「我的账号信息」区(现有内容偏用户管理/备份/登录日志)。
- A 股日历当前在 `HomeView` 顶栏(`cal-wrap`)：状态 `calToday/calOpen/calYear/calMonth/calDays/calLead/atCalMax/calMax` + 函数 `toggleCalendar/loadCalendar/prevMonth/nextMonth`，取数 `dataApi.tradeCalendar(year,month)`。`MarketStatusBar.vue` 是独立子组件，常驻聊天区底部。

## A. 账号昵称编辑

### 后端
- 新 `PUT /api/account/profile { nickname }`(authMiddleware)：更新当前用户 `users.nickname`。
  - 校验：`nickname` 字符串，`trim` 后长度 ≤ 30；允许空串(=清除昵称，UI 回落用户名)。非字符串 → 422。
  - 新 service `account/service.ts`(或并入现有 account 逻辑)函数 `updateNickname(userId, nickname)`。
  - 返回更新后的用户公开字段 `{ id, username, role, nickname }`(供前端刷新 store)。
- **用户名不可改**：端点不接受 username，只改 nickname。

### 前端
- `api/account.ts`：`updateProfile(nickname: string)` → `PUT /account/profile`，返回更新后的 user。
- `SettingsView.vue` 顶部新增「账号信息」区：
  - 用户名：只读文本(`auth.user.username`)。
  - 昵称：`<input>`(预填 `auth.user.nickname`)+「保存」按钮。
  - 保存 → `accountApi.updateProfile(nickname)` → 成功后用返回值刷新 `auth.user`(或调 `auth.fetchMe()`)→ 右上角按钮等即时更新；显示「已保存」。
- 该区对所有登录用户可见(普通用户 + admin 都能改自己昵称)。

## B. A 股日历移入状态条

### 新组件 `frontend/src/views/CalendarPopover.vue`(自包含)
- 内部持有 `calToday/calOpen/calYear/calMonth/calDays` + `calLead`/`atCalMax`/`calMax` computed + `toggleCalendar/loadCalendar/prevMonth/nextMonth`(从 HomeView 原样迁入)。取数用 `dataApi.tradeCalendar`。
- 渲染：一个**小图标按钮 `📅`**，`title="A股日历"`(无文字)。点击 toggle 弹层。
- 弹层**向上、右对齐**(状态条在屏幕最底部)：`position: absolute; bottom: 110%; right: 0`(原顶栏是 `top:110%` 向下，这里改向上)。月历网格样式复用(`cal-grid/cal-cell/closed/today` 等，迁入组件 scoped style)。

### `MarketStatusBar.vue`
- 在右侧 `.right`(「数据更新于…」所在)**最右端**加 `<CalendarPopover />`。

### `HomeView.vue`
- 顶栏移除 `<div class="cal-wrap">…</div>` 整段；移除迁走的 `cal*` 状态/computed/函数(grep 确认无其它引用后删)。`dataApi` 若仍被 HomeView 其它处使用则保留 import。

## C. 错误处理 / 边界

- 昵称保存失败 → SettingsView 显示错误信息;空昵称合法(清除)。
- 用户名永远只读，端点也不接受。
- 日历取数失败 → 弹层显示空网格(沿用现状 catch→[])。
- 日历弹层在状态条最右、向上弹，窄屏用 `max-width`/右对齐避免溢出。
- admin 状态条不显示(无聊天区)→ admin 看不到日历;但 admin 顶栏原也有日历——**移除后 admin 顶栏不再有日历**(可接受:admin 是运维账号，日历非其所需;若要保留可后续单议)。

> 取舍(确认点)：日历原在普通用户**与 admin** 顶栏都显示(`v-if="!auth.isAdmin"` 实际只普通用户)。查代码：顶栏 cal-wrap 是 `v-if="!auth.isAdmin"`，本就只普通用户。移入状态条(也只普通用户)→ 行为一致，admin 本就没有。

## D. 范围 / 测试

- 后端：`PUT /api/account/profile` + service `updateNickname` + jest(更新昵称读回、空串清除、超长/非字符串 422、用户名不受影响)。
- 前端(无 runner)：`vue-tsc` + 走查——账号信息区(用户名只读/昵称可改保存/右上角即时更新)；状态条最右端 📅 小图标弹层(向上、当月、可切月)；HomeView 顶栏日历已移除。

## E. 不在本次范围

- 不做改用户名/改密码(密码重置已有单独流程)。
- 不改日历取数逻辑(`dataApi.tradeCalendar`/交易日历同步)。
- 不给 admin 单独保留日历入口。
