# 股票小作手 (stock-agent)

一款 A 股操盘**研究辅助**工具：把你自定的操盘规则（多套 A/B/C… 系统）编码成 agent 的"思考"，
对个股做可审计、可归因、带教学的结构化分析，并通过早会 / 晚会 / 复盘让规则在实战中进化。

> ⚠️ 仅供学习与研究参考，不构成任何投资建议。据此操作盈亏自负。

---

## 功能概览

- **聊天式主界面**：左侧讨论记录，中间对话，右侧操作面板（早会 / 晚会 / 按核心原则选股 / 核心原则讨论·更换模板，可收起）。手机端自适应（抽屉式侧栏）。
- **主 agent「来财」**：全局召唤词——任意会话输入「来财」即与主 agent 讨论核心原则。系统只做**个股**与**核心原则**两类有目的的讨论，无闲聊。
- **核心原则（规则手册）**：per-user、版本化、不可变快照；13 套模板可**多选组合**（无冲突合并为一套，有冲突拆成 A/B/C 多系统并排优先级）；agent 依据讨论**提议补丁式修改**，用户审批后自动升版本，旧版可回滚。
- **个股分析**：代码精确算硬门槛（一票否决/质量项）→ AI 写软判断与结论 → 生成可审计报告（钉死规则版本 / 数据日期 / 模型 / 数据来源 / 校验结论）。结果在「分析历史」长期留存，**独立于会话**（清空对话不删历史）。
- **多 agent 讨论**：早会 / 晚会 / 选股都由子 agent 分工讨论后主 agent 综合——
  - 早会：数据员（盘面+板块热度+新闻）→ 分析师（按原则研判）→ 情绪面（预测今日可能走强板块）→ 来财综合（点名采纳依据）。
  - 晚会：数据员（今日实际）→ 分析师（对照早会研判/板块预测判对错）→ 复盘员（经验+原则建议）→ 来财综合。
  - 选股：确定性门槛筛选 + 数据员/分析师/来财讨论纪要。
- **多模型 + 按任务分工**：per-user 配置多个 AI 提供商（DeepSeek / Qwen / OpenAI / Claude / MiniMax / Ollama），按角色（core/data/analysis/qualitative/review/validation）路由模型，可手动钉或让主 agent 自动分配。
- **能力插件（MCP / Skill）**：per-user 启用/配置；Skill（分步推理 / 探索 / 记忆）的配置会**注入到聊天、个股分析、早晚会的 prompt**，真正改变 agent 行为。
- **数据层**：Python sidecar 封装 AkShare + BaoStock（零配置免 token 基本面源）+ pypinyin；本地全量 A 股库（代码+名称+拼音首字母，支持多音字搜索如 `clkj→长亮科技`）；行情可后台批量拉到本地（首次历史 + 每晚增量 + 手动补漏）；数据来源/时间全程溯源 + 上传/交叉/合理性校验门禁。
- **账号与安全**：邀请制注册 + 免责声明（必须勾选同意并留痕）+ 昵称；登录失败锁定（防暴力破解，429）；管理员可看**登录日志**与用户管理；数据备份 / 恢复 / 重置向导。

---

## 技术栈

- **前端**：Vue 3 + Vite + Pinia + vue-router（TypeScript）
- **后端**：Node + Express + TypeScript + better-sqlite3，JWT（Access 30min / Refresh 30d）
- **数据 sidecar**：Python + FastAPI（AkShare / BaoStock / pypinyin）
- **部署**：单容器（Express 同时服务 `/api` 与编译后的 Vue SPA）+ `akshare-mcp` 数据服务容器
- API 响应统一格式：`{ success, code, message, data, meta }`

## 仓库结构

```
backend/     Express API + SQLite + 业务逻辑（rulebook/analysis/meetings/screen/chat/ai/data/...）
frontend/    Vue 3 单页应用
sidecar/     Python FastAPI 数据服务（AkShare/BaoStock/pypinyin）
docs/        设计文档与分期计划
docker-compose.yml
```

---

## 本地开发

```bash
# 后端 (port 3000)
cd backend && npm install && npm run dev

# 前端 (port 5173, 代理 /api → :3000)
cd frontend && npm install && npm run dev

# 数据 sidecar (可选, port 8000)
cd sidecar && pip install -r requirements.txt && uvicorn main:app --port 8000
```

## Docker

```bash
docker compose up -d --build
# 访问 http://localhost:3000
```

默认管理员：**`stock-agent` / `sg123456`**（首次启动种入，请登录后改密码；可用 `DEFAULT_ADMIN_USER` / `DEFAULT_ADMIN_PASSWORD` 覆盖）。

---

## 主要环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `REGISTRATION_MODE` | `open` / `invite`（邀请制） | `invite`（容器） |
| `DEFAULT_ADMIN_USER` / `DEFAULT_ADMIN_PASSWORD` | 首次种入的管理员 | `stock-agent` / `sg123456` |
| `JWT_SECRET` | 未设则自动生成到 `data/.jwt_secret` | 自动 |
| `ENABLE_CRON` | 早会(08:00)/晚会(16:45)/盘后数据(23:00)定时任务，`false` 关闭 | 开 |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES` | 登录失败锁定阈值 / 时长 | `5` / `15` |
| `AI_MIN_INTERVAL_MS` / `AI_MAX_RETRIES` | LLM 调用最小间隔 / 429·5xx 退避重试次数 | `700` / `4` |
| `AI_ROUTE_RATE_MAX` | AI 相关接口每分钟限流 | `40` |
| `FRONTEND_URL` | 设置后启用 CORS 白名单 | — |
| `DATA_DIR` | SQLite 与密钥目录 | `backend/data` |

安全基线：helmet 安全头、CORS、auth 限流、AI 接口限流、登录失败锁定、SQL 全预编译参数化、前端无 `v-html`（默认转义）。

---

## 数据源说明

默认走内置 sidecar 的 **AkShare + BaoStock**（免费、BaoStock 免 token）。部分接口（东方财富 spot / 板块、baostock.com）在**境外网络环境可能连不上**——这不是代码问题，部署到能联通 A 股数据的（国内）服务器即可正常取数；取不到的字段会如实标为缺失并阻断不可信分析。也支持新浪 / 腾讯行情做交叉验证、通达信 CSV 上传。

## 文档

- 设计：`docs/superpowers/specs/2026-06-05-stock-agent-core-loop-design.md`
- 计划：`docs/superpowers/plans/`

## 进度

- [x] **第一期·核心闭环**：认证骨架、规则版本管理 + V3.0 基线、多模型按任务分工、MCP/Skill 插件、数据层（sidecar+缓存+CSV+cron）、分析引擎（rule-engine + orchestrator + 报告 + 教学）。
- [x] **第二期·聊天助手**：聊天式主界面、来财主 agent、核心原则对话改规则、个股聊天内嵌分析、早会/晚会、热门板块选股。
- [x] **打磨与硬化**：多模板组合、数据校验子系统、数据源管理 + 全程溯源、本地全量股票库 + 多音字搜索、本地行情库（EOD 后台拉取）、多 agent 讨论（早/晚会/选股）、Skill 接入 prompt、注册免责声明 + 昵称、登录防暴破 + 登录日志、AI 限流防 429、红色强调视觉主题、移动端适配。
- [ ] 后续：自选股 / 持仓 / 交易历史、复盘驱动的规则进化与信任度放权、通达信 .day 解析、流式聊天、Tushare 接入。
