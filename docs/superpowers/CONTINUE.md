# 续作说明（换机器 / 新会话接续）

> 给在**另一台机器或新 Claude Code 会话**里接着干的人/agent。CLI 会话本身不能跨机器恢复（本地、按目录哈希存、无云同步），但项目状态全在 git 里。读完本文 + 相关 spec/plan 即可接续。

最后更新：2026-06-08（晚，收尾）。仓库：`github.com/zmfy/stock-agent`（本地 master 是主线）。**当前 `master == origin/master == 185cb88`，全部已推 origin，无未推/未提交改动，工作树干净。**

## 今日收尾状态（2026-06-08）
- **基础框架 + 数据源已搭好并验证**：通达信(mootdx) 主力源 + HTTP 备选 + CSV 兜底；认证/规则版本/AI 多模型分工/MCP-Skill 插件/数据层/分析引擎/聊天基座/早晚会/选股/核心原则访谈合成 全部交付。
- **测试全绿**：后端 `cd backend && npm test` → 35 套件 236 测试通过；前端 `cd frontend && npx vue-tsc --noEmit` → 0 错。
- **下面「4 个功能」全部 ✅ 完成**（含原 ❌ 的第 4 项核心原则访谈合成，merge `813ebce` + fix `8f1a393`）。
- **明天继续方向（未开工，由用户定）**：第三期(自选股/持仓/交易历史/复盘驱动进化/信任度放权) ／ 流式聊天(SSE) ／ 数据源补强(Tushare 需 token / 通达信 .day 解析 / MCP 真实连接)。接续时对新功能从 superpowers:brainstorming 开始。

## 怎么接续
1. `git clone` / `git pull` 本仓库，`cd` 进去。
2. 设计/计划都在 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`（按日期命名），每个功能一套 spec→plan。git log 是完整历史。
3. 在仓库里开新 `claude` 会话，让它读本文 + 对应 spec/plan 接着做。做新功能照旧走 superpowers：brainstorming → writing-plans → subagent-driven-development。
4. 提交信息结尾用：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## 项目一句话
「股票小作手·来财」：AI 炒股助手。后端 Express+SQLite(better-sqlite3) 提供 API 并托管前端；前端 Vue3；`sidecar/`(FastAPI) 包装行情/基本面数据源。`docker compose` 起 app + akshare-mcp(sidecar) 两个服务。

## 数据源（最重要的根治成果）
- **通达信(mootdx) 是主力源**（行情前复权/实时/股票列表/基本面），绕开了用户联通线路对 HTTP 金融 CDN 的 RST。详见 git 里 `docs/superpowers/specs/2026-06-07-tdx-mootdx-datasource-design.md` 及对应 plan，关键实现在 `sidecar/tdx.py`。
- **坑（务必记住）**：mootdx 0.11.7 底层是 `tdxpy`（非 pytdx）；其**内置 qfq 复权坏了**（新 pandas 报错）→ 我们用 `xdxr` **自算前复权**（已对新浪校验 ≤0.005%）；**基本面 PE/PB/PS/ROE 不能用 `finance()`**（字段口径乱）→ 用 **F10「财务分析」表** 解析（`parse_f10_indicators`）。
- **sidecar 新增 .py 模块必须进 `sidecar/Dockerfile` 的 `COPY *.py ./`**，否则 `docker compose up --build` 后 `ModuleNotFoundError`。
- 通达信有 142 个服务器，数据页可「测速」(真实 TDX 查询校验，非仅 TCP) + 选用；选择存 `settings.tdx_server`，启动重推 sidecar。

## 测试 / 部署
- 后端：`cd backend && npm test`（当前 204 绿）。前端：`cd frontend && npx vue-tsc --noEmit`。
- sidecar 单测在容器内跑：`docker exec -w /app stock-agent-akshare-mcp-1 python tdx_test.py`；实连自检 `selfcheck_tdx.py`。
- 部署/生效：`docker compose up -d --build`（重建 app+sidecar）+ 浏览器硬刷新。bestip 首次选服务器 ~7s 后复用。

## 用户提的 4 个功能（2026-06-08 批次）
1. ✅ **Admin 强制中止数据任务**（生产进度条卡死→`data/service.forceStopJob` + `POST /:job/force-stop` + DataView「⛔强制中止」按钮）。spec/plan `2026-06-08-admin-force-stop-job*`。
2. ✅ **通达信服务器进数据源管理 + 测速选用**（数据页通达信卡片置顶=主力源；HTTP 数据源=交叉验证/备选；CSV=极端兜底）。spec/plan `2026-06-08-tdx-server-selection*`。
3. ✅ **对话气泡显示日期+时间**（HomeView：纪要块 briefingTime「生成于…」+ 提议卡 proposedAt + 乐观消息即时时间；聊天气泡本就有 fmtTime）。spec `2026-06-08-chat-message-timestamps-design.md`。
4. ✅ **核心原则访谈合成 + 无原则降级模式**（2026-06-08，merge `813ebce` + fix `8f1a393`）。spec/plan `2026-06-08-core-principle-interview*`。后端 `rulebook/synthesize-service.ts`（访谈对话→整套 rulebook，字段白名单 `SYNTH_FIELDS`/`VALID_OPS`，`parseSynth`/`validateSynth`/`synthesizeRulebook`）+ `POST /api/rulebook/synthesize`；`chat/service` 的 `core_principle` 按有无 rulebook 分叉（无→`CORE_PRINCIPLE_INTERVIEW_FRAMING` 引导式访谈，有→修改）；`orchestrator` 无 rulebook 走 `buildGeneralAnalysisPrompt` 通用分析（不评门槛、`rulebook_version_id=null`，不再抛 `NO_RULEBOOK`）；`meetings` 4 个 builder 加 `hasRulebook`（无原则只研判大盘板块、不点个股）；前端 `OnboardingView`「🗣帮我聊出来」选项（`__interview__`→`/?interview=1`）、`HomeView` 居中引导卡 `cp-cta` + `startInterview` + 访谈合成按钮/完整预览/选股守卫。fix：访谈记录被清空、开场白、首版采纳不调 AI。

## 更早的累计进展
见 git 历史与 `docs/superpowers/specs|plans/2026-06-07-*`：数据源探测/溯源、共享数据 cron、选股聊天化、核心原则变更记忆、新闻双日志、A股交易日历(休市日不开会+夜间攒新闻)、中国时区、功能页靠左卡片化等。
