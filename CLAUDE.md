# CLAUDE.md — stock-agent（小作手）

AI 操盘助手。后端 Express/TS + better-sqlite3 + Python(FastAPI/mootdx) sidecar；前端 Vue 3 + Vite。
后端测试 `cd backend && npm test`；前端无 runner，用 `cd frontend && npx vue-tsc --noEmit` 把关（须 exit 0）。

---

## 前端 UI 设计风格（弹窗 / 设置页）

所有 Modal 内的页面与设置面板统一遵循以下视觉语言。**参考实现**：`frontend/src/views/AiSettingsView.vue` 的「Agent 设定」段。

### 主题变量（全局 `frontend/src/assets/theme.css`，勿硬编码颜色）
- 背景：`--surface`(卡面)、`--surface-2`(浅灰二级面/胶囊底)、`--bg`(页底)
- 文本：`--text`(主)、`--text-soft`(次/说明)、`--muted`(更弱/占位)
- 边框：`--border`、`--border-soft`
- 语义色：`--info`/`--info-soft`(强调/主体)、`--ok`(成功)、`--accent`/`--accent-soft`/`--accent-ink`(警示/危险)
- 圆角：`--radius`(卡)、`--radius-sm`(胶囊/小元素)

### 结构
- **Modal 内的视图不要再渲染自己的页面标题或「返回」链接**——Modal 自带标题栏与关闭按钮。视图根节点直接放内容。
- 内容按**卡片**分组：`background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px;`，卡之间 `gap`/`margin` 10–12px。
- 主体/重点卡可用 `border: 2px solid var(--info)` 突出。
- 段标题 `h2` 18px/600；分组小标题 13px `--muted`；说明/hint 13px `--text-soft`、行高 1.6–1.7。

### 控件
- 表单标签：块级、13px `--text-soft`、`margin-bottom:6px`，置于输入框上方。
- 输入(textarea/select)整宽；按钮成组靠右，或整宽主按钮(`font-weight:600`)。批量保存优先于逐项保存。
- 实体列表项可配圆形头像(36–40px，`--surface-2` 或 `--info-soft` 底) + 名称 + 胶囊徽章(`--info-soft`/`--info`)。仅用于「实体」(如各 agent)，列表/开关类内容不必强加。
- **状态行**：`✓`(`--ok`) / `!`(`--accent`) + 文字 + 胶囊(`--surface-2` 底、`--border` 边、`--radius-sm`)显示具体值。

### 其它
- 图标用 **emoji**（与全站一致），不引外部图标字体（如 Tabler CDN）。
- 改完务必 `cd frontend && npx vue-tsc --noEmit` 确保 0 错。
