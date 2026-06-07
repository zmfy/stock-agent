# 提议内联化 + 新闻双日志 + 实时快照 + 菜单/探测优化

日期：2026-06-07

## Context（背景）

用户在使用中提出 6 项改进 + 接入 easyquotation。核心痛点：
- 「让 agent 提议修改规则」的反馈和确认按钮显示在**侧边面板**而非对话框里，体验割裂；采纳后也没在对话里展示最新核心原则。
- 「数据采集」区只是罗列原始新闻，用户真正想要的是**来财与子 agent 讨论后的结论**（如「今日某板块热门」）+ 其**推导依据的那条新闻**，并要可追溯（标题→内容），且按"是否被来财采用"差异化保留日志。
- 顶栏菜单顺序要调整；数据源探测太慢需要进度条。
- 行情历史源在用户线路只有新浪可用且慢；easyquotation 能极快取**实时快照**（走新浪），作为实时现价来源接入。

分两期落地：Phase A（体验修复 + easyquotation，独立先上）、Phase B（新闻双日志 + 来财讨论结果，绑定早晚会）。

## Goals
- 提议→反馈→确认→新原则展示，全部在**对话框内**完成。
- 新闻**双日志**（标题日志/内容日志）+ 来财**结构化采用**标记 + 标题→内容追溯 + 差异化保留。
- 顶栏菜单按指定顺序；探测带进度条。
- easyquotation 作为**实时快照**源接入个股快照。

## Non-goals
- 不动分析引擎/规则算法；不抓新闻原文全文（用 akshare 返回内容）；不解决线路对东方财富/腾讯历史端点的 RST（已知线路问题）。

---

## Phase A：体验修复 + easyquotation

### A1. 提议反馈内联进对话框
- 现状：`HomeView.vue` 在 `core_principle` 会话下，`propose()` 把结果存 `proposal` ref，渲染在独立 `.proposal` 面板，按钮 `采纳/放弃` 在面板里。
- 改为：点击「🛠 让 agent 提议修改规则」后，把提议结果作为**消息流内的内联助手卡片**渲染（在 messages 列表中追加一个 `type:'proposal'` 的**临时**项，非持久化），内容含：magnitude、diff（gates changed/added/removed、softRules、positionRules、persona）、来财 note，以及 `[采纳并升级到 {suggestedLabel}]` `[放弃]` 两个按钮。
- 后端 `/api/rulebook/propose`、`/apply` 不变。

### A2. 采纳后在对话框展示最新核心原则
- 点「采纳」→ 调 `/apply` 成功后：① 刷新 `activeRulebook`（顶部 briefing 已自动更新）；② 向当前会话**持久化一条助手消息**：`已升级到 {label}。当前核心原则：…`，正文复用 briefing 文本（版本/persona/系统优先级/各系统门槛）。
- 「放弃」→ 移除内联提议卡片，不留痕。

### A4. 顶栏菜单顺序
- `HomeView.vue` 的 `SETTINGS` 数组重排为：核心规则 → 早晚会历史 → 分析历史 → 数据 → AI模型 → 能力插件 → 账号设置（聊天为默认首 tab，不在 SETTINGS 内，仍居首）。
- 账号设置可见性：现状已是「普通用户仅见 改密码 + 数据备份/重置，admin 才见 用户管理/登录日志」（`SettingsView.vue` 用 `auth.isAdmin` 守卫）。**无需改动**。

### A5. 探测进度条
- 现状：sidecar `/probe?kind=` 顺序探测 4 个 provider、每个 `_timed(...,8)`，一次性返回，前端干等（最坏 ~32s）。
- sidecar：`/probe` 增加可选 `provider=<key>` 参数 → 只探测该 provider 返回单条；新增 `GET /probe/list?kind=` → 立即返回该 kind 的 `[{key,label}]`（不探测）。
- 前端 `DataView.vue` runProbe：先取 list（拿到总数）→ 逐个 provider 探测（可并发或顺序），**进度条显示 已完成/总数**，每条 resolve 后即刻填入可达/延迟。Node `sidecar.ts` 加 `probeOne(base, kind, provider)` 与 `probeList(base, kind)`。

### A-easyquotation. 实时快照源
- sidecar `requirements.txt` 加 `easyquotation`（pip）。
- sidecar 新端点 `GET /realtime/{code}` → 用 `easyquotation.use('sina')`（线路通）取实时快照，返回 `{ "source":"sina-rt", "data": { price, open, high, low, prev_close, volume, bid/ask(可选), name, time } }`；异常 → `{ "source":null, "data":{} }`，`_timed` 包住。
- Node `data/sidecar.ts` 加 `fetchRealtime(base, code): Promise<{source:string|null; data:Record<string,unknown>}|null>`。
- `data/service.ts getStockSnapshot` 增字段 `realtime`（`{ price, time, source }`，best-effort，取不到为 null，不阻塞）。前端个股快照展示「实时现价 + 时间」。
- EOD 历史拉取链路（ingestEod/quote providers）**不变**。

---

## Phase B：新闻双日志 + 来财讨论结果（绑定早晚会）

### 数据模型（db.ts 新表 + migrate）
```sql
CREATE TABLE IF NOT EXISTS news_title_log (   -- 标题日志，>1年清理
  id TEXT PRIMARY KEY,
  content_id TEXT,             -- 指向 news_content_log.id
  title TEXT NOT NULL,
  source TEXT,
  published_at TEXT,
  collected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS news_content_log ( -- 内容日志，采用>3月/未采用>1周清理
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT,                -- akshare 完整内容（不再截断）
  source TEXT,
  published_at TEXT,
  collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  adopted INTEGER DEFAULT 0,
  adopted_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_news_title_collected ON news_title_log (collected_at);
CREATE INDEX IF NOT EXISTS idx_news_content_adopted ON news_content_log (adopted, collected_at);
```

### sidecar 新闻内容
- `/news` 不再把内容截断到 200 字：返回 `{title, summary(短,≤200), content(完整), published_at}`。`summary` 供列表展示，`content` 存内容日志。

### 采集与采用（meetings/service.ts）
- 早/晚会生成时，数据员取到的每条新闻：写一条 `news_content_log`（content=完整）+ 一条 `news_title_log`（content_id 指向之）。去重按 (title, published_at)。
- 给数据员/来财的新闻文本带**稳定 id**：`[N1] 标题 …`（N1 映射到 content_id）。
- `buildMorning/EveningSynthPrompt`（来财 core）追加指令：结论末尾输出一行结构化采用清单，如 `__ADOPT__ N1,N3`。解析后把对应 `news_content_log.adopted=1, adopted_at=now`。解析容错：无该行则视为未采用任何。
- meetings 记录里保存「来财采用的新闻」结构（meetings.data JSON 增 `adopted_news: [{content_id,title}]`），供前端展示。

### 展示
- 早/晚会视图：来财结论下方列出**采用的新闻：标题（可点）**；点击 → 调 `GET /api/data/news/content/:id` 取 `news_content_log.content` 弹出/展开。
- DataView「数据采集」区改造：展示 `news_title_log`（标题 · 采集时间 · 采用徽标 · 点标题看内容）+ 保留「立即采集」触发（手动采集也写日志）。

### 路由（routes/data.ts）
- `GET /api/data/news/log?limit=` → 标题日志列表（title, source, collected_at, adopted, content_id）。
- `GET /api/data/news/content/:id` → 单条内容（content_id 查 news_content_log）。
- 现有 `GET /news`、`POST /news/refresh` 保留（refresh 也写双日志）。

### 保留清理（cron 夜间，并入 nightly 或 shared-data）
- `DELETE FROM news_title_log WHERE collected_at < now-1year`
- `DELETE FROM news_content_log WHERE adopted=1 AND collected_at < now-3month`
- `DELETE FROM news_content_log WHERE adopted=0 AND collected_at < now-1week`
- 每日跑一次；用 SQLite `datetime('now','-1 year')` 等。

## Testing
- A1/A2：前端无单测（vue-tsc + 冒烟）；后端 propose/apply 已有测试不回归。
- A5：sidecar `/probe?provider=`、`/probe/list` 一次性脚本验证；Node `probeOne/probeList` 单测（fetch mock）。
- easyquotation：sidecar `/realtime/{code}` 验证返回 shape；Node `fetchRealtime` 单测（mock）；getStockSnapshot 含 realtime 字段单测。
- Phase B：news 双日志写入/去重/采用标记/清理 SQL 单测（service + db）；来财采用解析（`__ADOPT__` 解析）纯函数单测；路由 log/content 单测；保留清理纯函数/SQL 单测。
- 全套测试保持绿。

## 默认决定（已确认 / 可改）
- 内容来源 = akshare 返回内容（不抓全文）；采用判定 = 来财结构化输出；采集日志绑定早晚会；实时快照接个股快照、默认新浪源；提议卡片临时内联（采纳后才持久化新原则消息）。
- 菜单：聊天 · 核心规则 · 早晚会历史 · 分析历史 · 数据 · AI模型 · 能力插件 · 账号设置。

## 落地顺序
Phase A（A1/A2/A4/A5 + easyquotation）先做、独立可上；Phase B（新闻双日志 + 来财采用 + 展示 + 清理）随后。
