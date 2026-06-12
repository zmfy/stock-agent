# 聊天主页导航微调 Design（策略弹层 / 换模板弹层 / 用户下拉）

> 普通用户聊天主页的几处入口重排：把「当前策略」「更换组合模板」做成「当前策略探讨」房间标题栏的弹层按钮；顶部菜单去掉这两项；「账号设置」移入右上角用户下拉（含登出）。纯前端 `HomeView.vue` + 一个通用 `Modal.vue`。

最后更新：2026-06-13。仓库：`github.com/zmfy/stock-agent`。

## 背景

当前 `HomeView.vue`(普通用户聊天主页)：
- 顶部菜单(`settingsMenu`)含「当前策略」(`rulebook`→`RulebookView`) 与「账号设置」(`account`→`SettingsView`)等项。
- 右上角(`topnav-user`)：`👤 用户名` + 独立「登出」按钮。
- 「当前策略探讨」(`core_principle`)房间正文里有「📜 更换 / 组合模板」(`tplOpen` 切换的 `tplswitch` 多选/预览/换入面板) + synthesize/propose 按钮；每个打开的会话标题栏有「🧹 清理」(`clearCurrent`)。

目标：减少顶部菜单杂项，把策略相关操作就近放到「当前策略探讨」房间标题栏（弹层），账号入口收进用户下拉。

## 已确认决策

- 标题栏的「当前策略」「更换组合模板」两个按钮**只在「当前策略探讨」(`core_principle`)房间**显示，位于「🧹 清理」左侧，顺序：**[📜 当前策略] [🔀 更换组合模板] [🧹 清理]**。
- 两个按钮点击都弹**弹出层(Modal)**：当前策略弹层=`RulebookView`；更换组合模板弹层=原 `tplswitch` 面板。
- 顶部菜单去掉「当前策略」「账号设置」两项。
- 「账号设置」移入右上角用户下拉(点 👤 弹出 [账号设置] [登出])；账号设置仍打开现有面板(`settingsKey='account'`)，非再套弹层。

## A. 「当前策略探讨」房间标题栏按钮

`HomeView.vue` 活动会话标题栏(`<div class="title">`)：当 `active.kind === 'core_principle'` 时，在「🧹 清理」按钮**之前**渲染：
- `📜 当前策略`：点击 `rulebookModalOpen = true`。
- `🔀 更换组合模板`：点击 `tplModalOpen = true`(沿用现有 `tplOpen` ref 即可，改为弹层显隐)。

其它 kind 的标题栏不变。

## B. 两个弹出层

用新增通用 `Modal.vue` 承载：
- **当前策略弹层**(`v-if="rulebookModalOpen"`)：标题「当前策略」，内容 `<RulebookView />`(组件自取数)。
- **更换组合模板弹层**(`v-if="tplOpen"`)：标题「更换 / 组合模板」，内容=把现房间正文里的 `tplswitch` 整段(多选 `templates`/`tplSelected`、`previewCompose`、`composeRes`/`orderedKeys`/`moveKey`、`applyCompose`、`tplMsg`、`startInterview` 入口)移入弹层。所有相关 ref/函数沿用，仅 DOM 位置改变。
- 关闭：点遮罩或 ✕ → 置 false。

房间正文(`active.kind === 'core_principle'` 的 room-actions)**保留** synthesize/propose 两个按钮(🛠 聊出当前策略 / 让 agent 提议修改)，**移除** 正文里的「更换 / 组合模板」触发按钮与 `tplswitch` 面板(已移入弹层；触发改到标题栏)。

## C. 顶部菜单精简

`SETTINGS` 数组：
- 删除 `{ key: 'rulebook', ... }`(普通用户「当前策略」菜单项)。
- 删除 `{ key: 'account', ... }`(「账号设置」菜单项)。
- 其余不变：普通用户菜单 = 策略历史 | 分析历史 | AI模型 | 能力插件；admin 菜单 = 数据管理 | 数据告警 | 定时任务 | AI模型 | 能力插件。
> `RulebookView` 仍被「当前策略」弹层用，import 保留；`SettingsView` 仍被账号设置面板用(`settingsKey='account'`)，import 保留。

## D. 右上角用户下拉

`topnav-user`：
- `👤 用户名` 改为可点击(`userMenuOpen = !userMenuOpen`)。
- 弹出下拉菜单：**[账号设置]**(点击 → `settingsKey = 'account'; userMenuOpen = false`) + **[登出]**(点击 → `logout()`)。
- 移除现有独立「登出」按钮(并入下拉)。
- 点击下拉外部/选项后关闭(可用简单 `@click` 关闭 + 失焦/再次点击切换；不强求 click-outside,选项点击即关足够)。
- admin 同样适用(admin 也需账号设置/登出)。

## E. 通用 Modal 组件

新增 `frontend/src/views/Modal.vue`(或 `components/`)：props `title`，emits `close`，默认插槽放内容；遮罩 + 居中卡片 + ✕；点遮罩/✕ emit `close`。两个弹层都用它。

## F. 错误处理 / 边界

- 弹层互斥非必须(同一时刻一般只开一个；不强制)。
- 更换组合模板弹层内 `applyCompose` 成功后行为不变(换入新版本)；可保留弹层打开或自动关闭——本期保持现有逻辑，不额外改(如需关闭再说)。
- admin 无 `core_principle` 房间，标题栏弹层按钮天然不出现；admin 用户下拉同样含账号设置/登出。
- `RulebookView`/`tplswitch` 内部逻辑不改，仅迁移位置 + 弹层包裹。

## G. 范围 / 测试

- 仅前端：`HomeView.vue` + 新 `Modal.vue`。无后端改动。
- 无前端单测运行器 → `vue-tsc --noEmit` + 走查：核心策略房间标题栏三按钮、两弹层内容正确、顶部菜单已去两项、用户下拉含账号设置+登出且独立登出按钮已移除、其它房间标题栏不变。

## H. 不在本次范围

- 不改 RulebookView / 模板换入(compose) / SettingsView 的内部逻辑。
- 不动其它房间(个股/复盘/选股)标题栏。
- 不做 click-outside 关闭弹层/下拉的复杂处理(选项点击关闭即可)。
