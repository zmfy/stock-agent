# 股票小作手 (stock-agent)

按用户的 A/B 双系统操盘规则分析 A 股、产出可审计可归因带教学的结构化报告，
并在实战中教用户操盘；规则经复盘由 agent 提议、用户审批而进化。

## 本地开发

```bash
# 后端 (port 3000)
cd backend && npm install && npm run dev

# 前端 (port 5173, 代理 /api → :3000)
cd frontend && npm install && npm run dev
```

默认注册模式为 `open`（可在 `backend/.env` 用 `REGISTRATION_MODE=invite` 切到邀请制）。

## Docker

```bash
docker compose up -d --build
# 访问 http://localhost:3000
```

## 文档

- 设计：`docs/superpowers/specs/2026-06-05-stock-agent-core-loop-design.md`
- 计划：`docs/superpowers/plans/`（第一期核心闭环分 5 个子计划，Plan 1 = Foundation）

## 进度

- [x] **Plan 1 — Foundation**：多用户 JWT 认证 + Vue3/Express/SQLite 骨架
- [ ] Plan 2 — 规则版本管理 + V3.0 基线导入
- [ ] Plan 3 — 数据层 + AkShare MCP sidecar + CSV 上传 + 定时爬取
- [ ] Plan 4 — 分析引擎（多AI + rule-engine + orchestrator + 报告 + 教学层）
- [ ] Plan 5 — 记忆技能 + 战绩/信任度档位
