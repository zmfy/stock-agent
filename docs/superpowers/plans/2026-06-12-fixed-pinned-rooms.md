# 固定置顶房间 + 移除操作面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「当前策略 / 早会 / 晚会 / 选股」做成左栏固定置顶、不可取消置顶/删除的 4 个聊天房间；删除右侧操作面板，把其动作内联进各自房间；A 股日历挪到顶栏。仅改普通用户聊天主页。

**Architecture:** 后端新增 `ensureFixedRooms(userId)`(幂等建齐 4 个固定 kind 会话并 `pinned=1`)，并在 `setPinned`/`deleteSession` 对固定 kind 抛 `FIXED_ROOM`(路由 409)。前端 `HomeView.vue`：进聊天主页调 `ensureFixedRooms`，按固定次序置顶渲染这 4 个房间(隐藏 📌/×)，删除右侧 `ops` 面板与 `ops-fab`，把生成早/晚会、按策略选股、换模板、提议修改等动作搬进各房间视图，A 股日历移入顶栏。

**Tech Stack:** Express/TS + jest(后端) + Vue 3(前端无单测 → `vue-tsc` + 走查)。

参照 spec：`docs/superpowers/specs/2026-06-12-fixed-pinned-rooms-design.md`。

---

## 文件结构

- Modify `backend/src/chat/service.ts` — `FIXED_ROOM_KINDS`、`ensureFixedRooms`、`setPinned`/`deleteSession` 守卫
- Modify `backend/src/routes/chat.ts` — `POST /ensure-fixed-rooms`；pin/delete 路由 catch `FIXED_ROOM`→409
- Modify `backend/src/routes/chat.test.ts` — 新增测试
- Modify `frontend/src/api/chat.ts` — `ensureFixedRooms()`
- Modify `frontend/src/views/HomeView.vue` — 房间排序/隐藏控件、删除 ops 面板、动作内联、日历入顶栏、文案

---

## Task 1: 后端 — ensureFixedRooms + 固定房间守卫（TDD）

**Files:**
- Modify: `backend/src/chat/service.ts`
- Modify: `backend/src/routes/chat.ts`
- Modify: `backend/src/routes/chat.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `backend/src/routes/chat.test.ts` 末尾；该文件已有 `tok`(admin)、`userTok`、`h(token)` 辅助）

```ts
describe('fixed rooms', () => {
  it('ensure-fixed-rooms 幂等建齐 4 个固定房间且都置顶', async () => {
    await request(app).post('/api/chat/ensure-fixed-rooms').set(h(userTok));
    const again = await request(app).post('/api/chat/ensure-fixed-rooms').set(h(userTok));
    expect(again.status).toBe(200);
    const list = (await request(app).get('/api/chat/sessions').set(h(userTok))).body.data as any[];
    for (const k of ['core_principle', 'morning', 'evening', 'screen']) {
      const rooms = list.filter((s) => s.kind === k);
      expect(rooms).toHaveLength(1);        // 幂等：每 kind 恰好一个
      expect(rooms[0].pinned).toBe(1);      // 固定置顶
    }
  });

  it('固定房间不可取消置顶 / 删除（409）', async () => {
    await request(app).post('/api/chat/ensure-fixed-rooms').set(h(userTok));
    const list = (await request(app).get('/api/chat/sessions').set(h(userTok))).body.data as any[];
    const screen = list.find((s) => s.kind === 'screen');
    const unpin = await request(app).put(`/api/chat/sessions/${screen.id}/pin`).set(h(userTok)).send({ pinned: false });
    expect(unpin.status).toBe(409);
    const del = await request(app).delete(`/api/chat/sessions/${screen.id}`).set(h(userTok));
    expect(del.status).toBe(409);
  });

  it('普通(stock)会话仍可置顶/删除', async () => {
    const s = await request(app).post('/api/chat/sessions').set(h(userTok)).send({ kind: 'stock', refId: '600000' });
    const id = s.body.data.id;
    expect((await request(app).put(`/api/chat/sessions/${id}/pin`).set(h(userTok)).send({ pinned: true })).status).toBe(200);
    expect((await request(app).delete(`/api/chat/sessions/${id}`).set(h(userTok))).status).toBe(200);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd ~/projects/stock-agent/backend && npx jest routes/chat -i -t "fixed rooms"`
Expected: FAIL（`ensure-fixed-rooms` 404；pin/delete 返回 200 而非 409）。

- [ ] **Step 3: 实现 service**（`backend/src/chat/service.ts`）

3a. 在 `ChatKind` 定义之后(约 line 17)加常量：
```ts
export const FIXED_ROOM_KINDS: ChatKind[] = ['core_principle', 'morning', 'evening', 'screen'];
const FIXED_ROOM_TITLES: Record<string, string> = {
  core_principle: '当前策略探讨',
  morning: '早会讨论',
  evening: '晚会讨论',
  screen: '选股讨论',
};
```

3b. 新增 `ensureFixedRooms`(放在 `listSessions` 之后)：
```ts
// 幂等确保 4 个固定房间存在且置顶；返回该用户全部会话(含这 4 个)。
export function ensureFixedRooms(userId: string): any[] {
  const db = getDb();
  for (const kind of FIXED_ROOM_KINDS) {
    const existing = db.prepare('SELECT id FROM chat_sessions WHERE user_id = ? AND kind = ?').get(userId, kind) as { id: string } | undefined;
    if (!existing) {
      db.prepare('INSERT INTO chat_sessions (id, user_id, kind, ref_id, title, pinned) VALUES (?, ?, ?, NULL, ?, 1)')
        .run(uuidv4(), userId, kind, FIXED_ROOM_TITLES[kind]);
    } else {
      db.prepare('UPDATE chat_sessions SET pinned = 1 WHERE id = ?').run(existing.id);
    }
  }
  return listSessions(userId);
}
```
> 确认 `uuidv4` 已在文件顶部 import(createSession 已用)。

3c. 改 `setPinned`(line 71)加守卫：
```ts
export function setPinned(userId: string, sessionId: string, pinned: boolean): void {
  const s = ownSession(userId, sessionId);
  if (s && FIXED_ROOM_KINDS.includes(s.kind)) throw new Error('FIXED_ROOM');
  getDb().prepare('UPDATE chat_sessions SET pinned = ? WHERE id = ? AND user_id = ?').run(pinned ? 1 : 0, sessionId, userId);
}
```

3d. 改 `deleteSession`(line 86)加守卫：
```ts
export function deleteSession(userId: string, sessionId: string): void {
  const s = ownSession(userId, sessionId);
  if (!s) return;
  if (FIXED_ROOM_KINDS.includes(s.kind)) throw new Error('FIXED_ROOM');
  const db = getDb();
  db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
}
```
> `ownSession` 在 `setPinned` 上方已定义(line 75)，但 `setPinned` 在 `ownSession` 之前——确认顺序：`ownSession`(75) 在 `setPinned`(71) 之后。函数声明提升使运行期可用，但为稳妥可把 `ownSession` 上移到 `setPinned` 之前；TS 函数声明会提升，运行无碍，可不动。

- [ ] **Step 4: 实现路由**（`backend/src/routes/chat.ts`）

4a. `POST /ensure-fixed-rooms`(加在 `GET /sessions` 路由附近)：
```ts
// POST /api/chat/ensure-fixed-rooms — 幂等建齐 4 个固定房间并置顶
router.post('/ensure-fixed-rooms', (req: Request, res: Response) => {
  successResponse(res, chat.ensureFixedRooms(req.user!.userId));
});
```

4b. pin 路由(line 87)改为捕获 `FIXED_ROOM`：
```ts
router.put('/sessions/:id/pin', (req: Request, res: Response) => {
  const parsed = z.object({ pinned: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    chat.setPinned(req.user!.userId, req.params.id, parsed.data.pinned);
    successResponse(res, null, parsed.data.pinned ? '已置顶' : '已取消置顶');
  } catch (e: any) {
    if (e.message === 'FIXED_ROOM') return errorResponse(res, 409, 'BUSINESS_CONFLICT', '固定房间不可更改置顶');
    throw e;
  }
});
```

4c. delete 路由(line 101)改为捕获 `FIXED_ROOM`：
```ts
router.delete('/sessions/:id', (req: Request, res: Response) => {
  try {
    chat.deleteSession(req.user!.userId, req.params.id);
    successResponse(res, null, '已删除');
  } catch (e: any) {
    if (e.message === 'FIXED_ROOM') return errorResponse(res, 409, 'BUSINESS_CONFLICT', '固定房间不可删除');
    throw e;
  }
});
```
> 确认 `errorResponse` 已在 chat.ts import(pin 路由已用 `errorResponse`)。

- [ ] **Step 5: 运行确认通过 + 全量回归**

Run: `cd ~/projects/stock-agent/backend && npx jest routes/chat -i`
Expected: 全绿(含新 3 例)。

Run: `cd ~/projects/stock-agent/backend && npm test`
Expected: 本批相关套件绿(注：`chat/service.test.ts` 与 `meetings/service.test.ts` 有既有 live-sidecar 超时 flaky，与本改无关；`routes/chat` 应稳定绿)。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add backend/src/chat/service.ts backend/src/routes/chat.ts backend/src/routes/chat.test.ts
git commit -m "feat(chat): ensureFixedRooms 幂等建齐4固定房间+置顶；固定房间禁改置顶/删除(409)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 前端 — 固定房间排序 + 隐藏置顶/删除入口 + 进入即建齐

**Files:**
- Modify: `frontend/src/api/chat.ts`
- Modify: `frontend/src/views/HomeView.vue`

- [ ] **Step 1: api 加 `ensureFixedRooms`**（`frontend/src/api/chat.ts` 的 `chatApi` 对象内）

```ts
  ensureFixedRooms: () => api.post<{ data: ChatSession[] }>('/chat/ensure-fixed-rooms'),
```

- [ ] **Step 2: HomeView 加固定 kind 常量 + 排序 computed + 判定函数**（`<script setup>`，与其它 const 同区）

```ts
const FIXED_ORDER: ChatKind[] = ['core_principle', 'morning', 'evening', 'screen'];
function isFixedRoom(kind: ChatKind): boolean {
  return FIXED_ORDER.includes(kind);
}
const orderedSessions = computed(() => {
  const fixed = FIXED_ORDER
    .map((k) => sessions.value.find((s) => s.kind === k))
    .filter((s): s is ChatSession => !!s);
  const rest = sessions.value.filter((s) => !isFixedRoom(s.kind));
  return [...fixed, ...rest];
});
```
> `ChatSession`/`ChatKind` 已从 `../api/chat` import(文件已用)。确认 `computed` 已 import(已用)。

- [ ] **Step 3: 列表改用 orderedSessions + 固定房间隐藏 📌/×**（模板 line 13–19）

把：
```vue
          <li v-for="s in sessions" :key="s.id" :class="{ active: active?.id === s.id, 'is-pinned': s.pinned === 1 }"
              @click="open(s)" @mouseenter="startHover(s.id)" @mouseleave="endHover">
            <span class="kind">{{ kindIcon(s.kind) }}</span>
            <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
            <span v-if="generating.has(s.kind)" class="spinner sess-spin"></span>
            <button class="pin" :class="{ on: s.pinned === 1 }" :title="s.pinned === 1 ? '取消置顶' : '置顶'" @click.stop="togglePin(s)">📌</button>
            <button v-show="hoverDelId === s.id" class="del" title="删除会话（分析历史保留）" @click.stop="removeSession(s)">×</button>
          </li>
```
改为：
```vue
          <li v-for="s in orderedSessions" :key="s.id" :class="{ active: active?.id === s.id, 'is-pinned': s.pinned === 1, 'is-fixed': isFixedRoom(s.kind) }"
              @click="open(s)" @mouseenter="startHover(s.id)" @mouseleave="endHover">
            <span class="kind">{{ kindIcon(s.kind) }}</span>
            <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
            <span v-if="generating.has(s.kind)" class="spinner sess-spin"></span>
            <button v-if="!isFixedRoom(s.kind)" class="pin" :class="{ on: s.pinned === 1 }" :title="s.pinned === 1 ? '取消置顶' : '置顶'" @click.stop="togglePin(s)">📌</button>
            <button v-if="!isFixedRoom(s.kind)" v-show="hoverDelId === s.id" class="del" title="删除会话（分析历史保留）" @click.stop="removeSession(s)">×</button>
          </li>
```

- [ ] **Step 4: 进入聊天主页即建齐固定房间**（`onMounted` 普通用户分支，`await loadSessions();` 之前）

把(普通用户分支起始)：
```ts
  await loadSessions();
  await loadMeetings();
```
改为：
```ts
  await chatApi.ensureFixedRooms().catch(() => {});
  await loadSessions();
  await loadMeetings();
```
> 该分支在 `if (auth.isAdmin) { ...; return; }` 之后(admin 不建房间)。

- [ ] **Step 5: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/api/chat.ts frontend/src/views/HomeView.vue
git commit -m "feat(home): 4固定房间置顶排序+进入即建齐+隐藏其置顶/删除入口

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 前端 — 动作内联进各房间 + 删除操作面板

**Files:**
- Modify: `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 在 active 会话视图标题块后插入「房间动作」块**

在 `<div class="title"> … </div>`(约 line 71–78，含 stock 的「重新按当前策略分析」那块)的**紧后面**、`<div v-if="analyzing" …>` 之前，插入：
```vue
              <!-- 房间专属动作（取代原右侧操作面板） -->
              <div v-if="active.kind === 'morning' && !meetings.morning" class="room-actions">
                <button class="ops-btn dashed" @click="genMeeting('morning')">📈 生成今日早会</button>
              </div>
              <div v-else-if="active.kind === 'evening' && !meetings.evening" class="room-actions">
                <button class="ops-btn dashed" @click="genMeeting('evening')">🌙 生成今日晚会</button>
              </div>
              <div v-else-if="active.kind === 'screen'" class="room-actions">
                <template v-if="activeRulebook">
                  <button class="ops-btn" @click="runScreen">🔍 按当前策略选股</button>
                </template>
                <template v-else>
                  <span class="muted">还没有当前策略，无法选股。</span>
                  <button class="ops-btn" @click="openCorePrinciple">去「当前策略」房间定一套 →</button>
                </template>
              </div>
              <div v-else-if="active.kind === 'core_principle'" class="room-actions">
                <button class="ops-btn" @click="tplOpen = !tplOpen">📜 更换 / 组合模板</button>
                <button v-if="needsInit" class="propose-btn" :disabled="synthesizing" @click="synthesizePrinciple">
                  <span v-if="synthesizing" class="spinner"></span>{{ synthesizing ? '来财生成中…' : '🛠 根据我们的聊天，帮我生成当前策略' }}
                </button>
                <button v-else class="propose-btn" :disabled="proposing" @click="propose">
                  <span v-if="proposing" class="spinner"></span>{{ proposing ? 'agent 拟定中…' : '🛠 根据本次讨论，让 agent 提议修改规则' }}
                </button>
                <div v-if="tplOpen" class="tplswitch">
                  <div class="tpl-head">
                    <span>更换 / 组合模板（可多选）</span>
                    <button class="mini" @click="tplOpen = false">收起</button>
                  </div>
                  <div class="tplgrid">
                    <label v-for="t in templates" :key="t.key" class="tplcheck">
                      <input type="checkbox" :value="t.key" v-model="tplSelected" /> {{ t.label }}
                    </label>
                  </div>
                  <button :disabled="!tplSelected.length" @click="previewCompose">预览组合（{{ tplSelected.length }}）</button>
                  <div class="tpl-interview-entry">
                    <a href="#" @click.prevent="startInterview">或：我还没想好，帮我从聊天聊出一套 →</a>
                  </div>
                  <div v-if="composeRes" class="composeprev">
                    <p v-if="!composeRes.conflict" class="ok-msg">✅ 无冲突，将合并为一套：{{ composeRes.versionLabel }}</p>
                    <template v-else>
                      <p class="warn">⚠️ 存在冲突（字段：{{ composeRes.conflictFields.join('、') }}），将拆为多套系统，请排优先级（上=优先）：</p>
                      <div v-for="(k, i) in orderedKeys" :key="k" class="sysrow">
                        <span><b>{{ String.fromCharCode(65 + i) }}</b>：{{ labelOfKey(k) }}</span>
                        <span class="ord">
                          <button class="mini" :disabled="i === 0" @click="moveKey(i, -1)">↑</button>
                          <button class="mini" :disabled="i === orderedKeys.length - 1" @click="moveKey(i, 1)">↓</button>
                        </span>
                      </div>
                    </template>
                    <button @click="applyCompose">换入为当前策略</button>
                  </div>
                  <span v-if="tplMsg" class="ok-msg">{{ tplMsg }}</span>
                </div>
              </div>
```
> 这是把原 ops 面板的模板切换块 + propose/synthesize 块整体迁入 core_principle 房间；morning/evening/screen 的动作按钮也迁入各自房间。所有 handler/ref(`genMeeting`、`runScreen`、`openCorePrinciple`、`synthesizePrinciple`、`propose`、`tplOpen`、`tplSelected`、`templates`、`previewCompose`、`composeRes`、`orderedKeys`、`labelOfKey`、`moveKey`、`applyCompose`、`tplMsg`、`startInterview`、`needsInit`、`synthesizing`、`proposing`、`activeRulebook`)均已在文件中存在，仅触发位置变化。

- [ ] **Step 2: 删除右侧操作面板整段 + 悬浮按钮**

删除模板 line 189–279 整段(从 `<!-- 右：操作框（所有聊天通用，可隐藏） -->` 的 `<aside v-if="opsOpen" class="ops-side">` 到 `</aside>`，以及其后的 `<!-- 操作框隐藏后… -->` + `<button v-if="!opsOpen" class="ops-fab" …>⚙ 操作</button>`)。保留外层 `</div>`(`.chat-row` 闭合)与 `</section>`。
> 注意：A 股日历(`cal-wrap`)在 Task 4 迁入顶栏，本步先连同 ops 面板删除其在此处的副本。

- [ ] **Step 3: 清理无用脚本**（`<script setup>`）

- 删除 `const opsOpen = ref(...)`(约 line 418)。
- 删除 `openPrincipleAndTemplates` 函数(line 430–434，已无引用——其能力由「房间点击 + 更换模板按钮 toggle tplOpen」取代)。
- 若 grep 确认 `opsOpen`/`openPrincipleAndTemplates` 再无其它引用，方可删。

Run: `cd ~/projects/stock-agent && grep -n "opsOpen\|openPrincipleAndTemplates\|ops-fab\|ops-side" frontend/src/views/HomeView.vue`
Expected: 仅可能剩 `<style>` 里 `.ops-side`/`.ops-fab` 的样式规则(下一步处理)；脚本与模板无残留引用。

- [ ] **Step 4: 加 `.room-actions` 样式 + 清理废弃样式**（`<style scoped>`）

加：
```css
.room-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0 10px; }
```
删除仅供已移除元素使用的样式(若存在且不再被引用)：`.ops-side`、`.ops-head`、`.ops-fab`。`.ops-btn`/`.propose-btn`/`.propose-bar`/`.tplswitch` 等仍被房间动作复用，**保留**。

- [ ] **Step 5: 类型检查**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): 动作内联进各房间(生成早晚会/选股/换模板/提议) + 删除右侧操作面板

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前端 — A 股日历入顶栏 + 文案微调

**Files:**
- Modify: `frontend/src/views/HomeView.vue`

- [ ] **Step 1: 顶栏(普通用户)加 A 股日历按钮 + 弹层**

在顶栏 `<nav class="topnav"> … </nav>` 内、`<div class="topnav-user">`(约 line 38)之前插入(仅普通用户)：
```vue
        <div v-if="!auth.isAdmin" class="cal-wrap">
          <button class="mini" @click="toggleCalendar">📅 A 股日历</button>
          <div v-if="calOpen" class="cal-pop">
            <div class="cal-nav">
              <button class="mini" @click="prevMonth">‹</button>
              <span>{{ calYear }} 年 {{ calMonth }} 月</span>
              <button class="mini" @click="nextMonth" :disabled="atCalMax">›</button>
            </div>
            <div class="cal-grid cal-head">
              <span v-for="w in ['一','二','三','四','五','六','日']" :key="w">{{ w }}</span>
            </div>
            <div class="cal-grid">
              <span v-for="n in calLead" :key="'b'+n" class="cal-cell blank"></span>
              <span v-for="d in calDays" :key="d.date" class="cal-cell" :class="{ closed: !d.trading, today: d.date === calToday }">
                {{ Number(d.date.slice(8, 10)) }}
                <i v-if="!d.trading" class="cal-x">休</i>
              </span>
            </div>
            <div class="cal-foot muted">灰色=休市（周末/节假日），不开早晚会；今日高亮。</div>
          </div>
        </div>
```
> `toggleCalendar`/`calOpen`/`calYear`/`calMonth`/`prevMonth`/`nextMonth`/`atCalMax`/`calLead`/`calDays`/`calToday` 均已存在，仅 DOM 位置变化。

- [ ] **Step 2: 日历弹层定位样式**（`<style scoped>`，确保在顶栏里以绝对定位下拉而非撑开布局）

加(或调整现有 `.cal-pop`)：
```css
.topnav .cal-wrap { position: relative; }
.topnav .cal-pop { position: absolute; top: 110%; right: 0; z-index: 50; background: var(--card, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 8px; padding: 10px; box-shadow: 0 6px 24px rgba(0,0,0,0.12); }
```
> 若 `.cal-pop`/`.cal-grid`/`.cal-cell` 等既有样式仍在 `<style>`(原本服务 ops 面板里的日历)，保留它们；本步只补顶栏定位。

- [ ] **Step 3: 文案微调（去掉「右侧操作框」指引）**

把空态文案(约 line 74)：
```
；或在右侧操作框点「当前策略讨论 / 更换模板」。
```
改为：
```
；或点左侧「当前策略」房间，与来财探讨、更换模板。
```
Run 确认无其它「操作框/操作面板」指引残留：`cd ~/projects/stock-agent && grep -n "操作框\|操作面板" frontend/src/views/HomeView.vue`
Expected: 无命中(admin 运维主页的「操作」无关；本文件 admin 分支无此词)。

- [ ] **Step 4: 类型检查 + 残留扫描**

Run: `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit`
Expected: exit 0。

Run: `cd ~/projects/stock-agent && grep -n "opsOpen\|ops-fab\|ops-side\|openPrincipleAndTemplates" frontend/src/views/HomeView.vue`
Expected: 无命中。

- [ ] **Step 5: 提交**

```bash
cd ~/projects/stock-agent
git add frontend/src/views/HomeView.vue
git commit -m "feat(home): A股日历移入顶栏 + 去掉「右侧操作框」指引文案

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 阶段验收(全部 Task 完成后)

1. `cd ~/projects/stock-agent/backend && npx jest routes/chat -i` → 全绿。
2. `cd ~/projects/stock-agent/frontend && npx vue-tsc --noEmit` → exit 0。
3. 容器验证(可选)：`docker compose up -d --build` 后普通用户登录——
   - 左栏顶部固定 📜当前策略 / 📈早会 / 🌙晚会 / 🔍选股 四个房间(无 📌/×，不可取消置顶/删除)，其下是个股会话(仍可置顶/删除)。
   - 右侧操作面板与「⚙ 操作」悬浮按钮消失。
   - 进早会/晚会房间：当日未生成→房间内「生成今日早会/晚会」；选股房间→「按当前策略选股」(无策略时提示去定策略);当前策略房间→「更换模板」+「生成/提议修改」就位。
   - 顶栏出现「📅 A 股日历」，点击下拉当月。
   - admin 运维主页不受影响(无聊天、无这些房间)。
