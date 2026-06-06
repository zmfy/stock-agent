<template>
  <div class="shell">
    <!-- 左栏 -->
    <aside class="rail">
      <div class="brand">股票小作手</div>

      <!-- 置顶 -->
      <div class="pinned">
        <!-- 早会 -->
        <button v-if="meetings.morning" class="pin-btn" :class="{ active: active?.kind === 'morning' }" @click="openMeeting('morning')">
          📈 今日操作方向（早会）
        </button>
        <button v-else class="pin-card gen" :disabled="genning === 'morning'" @click="genMeeting('morning')">
          📈 生成今日早会{{ genning === 'morning' ? '…' : '' }}
        </button>

        <button class="pin-btn" :class="{ active: active?.kind === 'core_principle' }" @click="openCorePrinciple">📜 核心原则（对话）</button>

        <div class="screen-sect">
          <button class="pin-btn" :disabled="screening" @click="runScreen">🔍 {{ screening ? '选股中…' : '按核心原则选股' }}</button>
          <button v-if="screen" class="fold" @click="screenOpen = !screenOpen">
            {{ screenOpen ? '▾' : '▸' }} 选股结果（{{ screen.results.length }}）
          </button>
          <div v-if="screen && screenOpen" class="screen-list">
            <div class="snote muted">{{ screen.note }}</div>
            <div v-for="r in screen.results" :key="r.code" class="srow" @click="openStockCode(r.code)">
              <span class="badge2" :class="r.aPass ? 'a' : r.bPass ? 'b' : 'no'">{{ r.aPass ? 'A' : r.bPass ? 'B' : '—' }}</span>
              {{ r.name || r.code }} <span class="muted">{{ r.code }} · {{ r.passed }}/{{ r.total }}</span>
            </div>
            <div v-if="!screen.results.length" class="muted">无符合条件的股票</div>
          </div>
        </div>

        <div class="freeq">
          <input v-model="queryCode" placeholder="自由查询：代码/名称" @keyup.enter="freeQuery" />
          <button @click="freeQuery">查</button>
        </div>

        <!-- 晚会 -->
        <button v-if="meetings.evening" class="pin-btn" :class="{ active: active?.kind === 'evening' }" @click="openMeeting('evening')">
          🌙 今日操作复盘（晚会）
        </button>
        <button v-else class="pin-card gen" :disabled="genning === 'evening'" @click="genMeeting('evening')">
          🌙 生成今日晚会{{ genning === 'evening' ? '…' : '' }}
        </button>
      </div>

      <!-- 会话列表 -->
      <div class="sect-head">对话 <button class="mini" @click="newGeneral">＋新对话</button></div>
      <ul class="sessions">
        <li v-for="s in sessions" :key="s.id" :class="{ active: active?.id === s.id }"
            @click="open(s)" @mouseenter="startHover(s.id)" @mouseleave="endHover">
          <span class="kind">{{ kindIcon(s.kind) }}</span>
          <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
          <button v-show="hoverDelId === s.id" class="del" title="删除（含清空该股记忆）" @click.stop="removeSession(s)">×</button>
        </li>
      </ul>

      <div class="menu">
        <button v-if="sessions.length" class="settings-entry clearall" @click="clearAllChats">🧹 清空所有对话</button>
        <button class="settings-entry" :class="{ active: settingsMode }" @click="enterSettings">⚙ 系统设置</button>
      </div>
      <div class="foot">
        <span class="muted">{{ auth.user?.username }}</span>
        <button class="mini" @click="logout">登出</button>
      </div>
    </aside>

    <!-- 右侧：系统设置 或 聊天区 -->
    <main class="chat">
      <!-- 系统设置（左栏不变，仅右侧切换） -->
      <template v-if="settingsMode">
        <div class="settings-top">
          <button class="mini" @click="exitSettings">← 返回聊天</button>
          <nav class="settings-nav">
            <button v-for="s in SETTINGS" :key="s.key" :class="{ active: settingsKey === s.key }" @click="settingsKey = s.key">{{ s.label }}</button>
          </nav>
        </div>
        <div class="settings-body">
          <div v-if="!settingsKey" class="settings-menu">
            <button v-for="s in SETTINGS" :key="s.key" class="scard" @click="settingsKey = s.key">
              <span class="sicon">{{ s.icon }}</span>{{ s.label }}
            </button>
          </div>
          <component v-else :is="currentSettingsComp" :key="settingsKey" />
        </div>
      </template>

      <!-- 聊天 -->
      <template v-else>
      <div v-if="needsInit" class="initbar">
        还没设定核心原则？<router-link to="/onboarding">去完成初始化设定 →</router-link>
      </div>

      <div v-if="!active" class="empty">
        <h2>你好，我是你的操盘助手 🤝</h2>
        <p class="muted">点左侧「核心原则」与我探讨规则，或「自由查询」一只股票，或开一个新对话。</p>
      </div>

      <template v-else>
        <div class="title">
          {{ active.title || sessionLabel(active) }}
          <span v-if="active.kind === 'stock'" class="stock-head">
            <button class="mini" :disabled="analyzing" @click="doAnalyze(active)">{{ analyzing ? '按原则分析中…' : '🔄 重新按核心原则分析' }}</button>
            <router-link class="mini" to="/analysis">完整报告</router-link>
          </span>
        </div>
        <div v-if="analyzing" class="analyzing">正在按你的核心原则分析 {{ active.ref_id }} …</div>

        <!-- 早会/晚会简报 -->
        <div v-if="briefing" class="briefing">{{ briefing }}</div>

        <div class="msgs" ref="msgsEl">
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div class="bubble">{{ m.content }}</div>
            <div v-if="m.created_at" class="mtime">{{ fmtTime(m.created_at) }}</div>
          </div>
          <div v-if="sending" class="msg assistant"><div class="bubble typing">思考中…</div></div>
        </div>
        <!-- 核心原则：让 agent 提议修改 -->
        <div v-if="active.kind === 'core_principle'" class="propose-bar">
          <button class="propose-btn" :disabled="proposing" @click="propose">
            {{ proposing ? 'agent 拟定中…' : '🛠 根据本次讨论，让 agent 提议修改规则' }}
          </button>
        </div>

        <div v-if="proposal" class="proposal">
          <h4>修改提议（{{ proposal.magnitude === 'major' ? '较大改动' : '微调' }}）：{{ proposal.currentLabel }} → <b>{{ proposal.suggestedLabel }}</b></h4>
          <p v-if="proposal.delta.personaChanged">· 人设有改动</p>
          <p v-for="c in proposal.delta.gates.changed" :key="c.gate_key">· 门槛 <b>{{ c.gate_key }}</b>：{{ c.from.threshold }} → {{ c.to.threshold }}</p>
          <p v-for="k in proposal.delta.gates.added" :key="'a'+k">· 新增门槛 {{ k }}</p>
          <p v-for="k in proposal.delta.gates.removed" :key="'r'+k">· 删除门槛 {{ k }}</p>
          <p v-if="proposal.delta.softRules.added.length || proposal.delta.softRules.removed.length">· 软判断 +{{ proposal.delta.softRules.added.length }} / -{{ proposal.delta.softRules.removed.length }}</p>
          <p v-if="proposal.delta.positionRulesChangedKeys.length">· 仓位规则改动：{{ proposal.delta.positionRulesChangedKeys.join('、') }}</p>
          <p v-if="noChange" class="muted">无实质改动</p>
          <p v-if="proposal.proposal.note" class="muted">理由：{{ proposal.proposal.note }}</p>
          <div class="ops">
            <button :disabled="applying || noChange" @click="applyProposal">采纳并升级到 {{ proposal.suggestedLabel }}</button>
            <button @click="proposal = null">放弃</button>
          </div>
          <p v-if="applyMsg" class="ok-msg">{{ applyMsg }}</p>
        </div>

        <div class="composer">
          <textarea v-model="input" rows="2" placeholder="输入消息，Enter 发送" @keydown.enter.exact.prevent="send"></textarea>
          <button :disabled="sending || !input.trim()" @click="send">发送</button>
        </div>
        <p v-if="chatErr" class="err">{{ chatErr }}</p>
      </template>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { chatApi, type ChatSession, type ChatMessage, type ChatKind } from '../api/chat';
import { rulebookApi, type ProposeResult, type FullRulebook, type Gate } from '../api/rulebook';
import { meetingsApi, type Meeting } from '../api/meetings';
import { screenApi, type ScreenRun } from '../api/screen';
import AnalysisView from './AnalysisView.vue';
import RulebookView from './RulebookView.vue';
import AiSettingsView from './AiSettingsView.vue';
import PluginsView from './PluginsView.vue';
import DataView from './DataView.vue';
import SettingsView from './SettingsView.vue';
import MeetingsHistoryView from './MeetingsHistoryView.vue';

const auth = useAuthStore();

// 系统设置：右侧内嵌这些页面，左栏不变
const SETTINGS = [
  { key: 'analysis', label: '选股分析', icon: '📊', comp: AnalysisView },
  { key: 'rulebook', label: '核心规则', icon: '📜', comp: RulebookView },
  { key: 'ai', label: 'AI 模型', icon: '🤖', comp: AiSettingsView },
  { key: 'plugins', label: '能力插件', icon: '🧩', comp: PluginsView },
  { key: 'data', label: '数据', icon: '📈', comp: DataView },
  { key: 'meetings', label: '早晚会历史', icon: '🗓', comp: MeetingsHistoryView },
  { key: 'account', label: '账号设置', icon: '👤', comp: SettingsView },
];
const settingsMode = ref(false);
const settingsKey = ref('');
const currentSettingsComp = computed(() => SETTINGS.find((s) => s.key === settingsKey.value)?.comp);
function enterSettings() {
  settingsMode.value = true;
  settingsKey.value = '';
}
function exitSettings() {
  settingsMode.value = false;
}
const router = useRouter();

const sessions = ref<ChatSession[]>([]);
const active = ref<ChatSession | null>(null);
const messages = ref<ChatMessage[]>([]);
const input = ref('');
const sending = ref(false);
const chatErr = ref('');
const queryCode = ref('');
const needsInit = ref(false);
const analyzing = ref(false);
const msgsEl = ref<HTMLElement | null>(null);
const meetings = ref<{ morning: Meeting | null; evening: Meeting | null }>({ morning: null, evening: null });
const genning = ref<'' | 'morning' | 'evening'>('');
const screen = ref<ScreenRun | null>(null);
const screening = ref(false);
const screenOpen = ref(true);
const activeRulebook = ref<FullRulebook | null>(null);
function gateCond(g: Gate) {
  if (g.op === 'gt_field') return `${g.field} > ${g.ref_field}`;
  if (g.op === 'between') return `${g.threshold} < 值 < ${g.threshold2} ${g.unit}`;
  return `${g.op} ${g.threshold}${g.unit}`;
}
function buildCpBriefing(rb: FullRulebook | null): string {
  if (!rb) return '你还没有核心原则。请到「系统设置 → 核心规则」导入一个模板后，再来这里和我探讨优化。';
  const list = (sys: 'A' | 'B') =>
    rb.gates.filter((g) => g.system === sys).map((g) => `· ${g.label}：${gateCond(g)}${g.veto ? '（一票否决）' : ''}`).join('\n') || '（无）';
  return (
    `【当前使用的核心原则 ${rb.version.version_label}】\n` +
    `人设：${rb.version.persona}\n\n` +
    `A 系统硬门槛：\n${list('A')}\n\n` +
    `B 系统硬门槛：\n${list('B')}\n\n` +
    `———\n你想优化哪一方面？例如：放宽/收紧某条门槛、增删条件、调整仓位或止损、修改人设。\n` +
    `说出你的想法，我们讨论后，点下方「🛠 让 agent 提议修改规则」，我会给出带版本号的修改方案供你确认。`
  );
}
const briefing = computed(() => {
  if (active.value?.kind === 'morning') return meetings.value.morning?.content || '';
  if (active.value?.kind === 'evening') return meetings.value.evening?.content || '';
  if (active.value?.kind === 'core_principle') return buildCpBriefing(activeRulebook.value);
  return '';
});

// 核心原则修改提议
const proposal = ref<ProposeResult | null>(null);
const proposing = ref(false);
const applying = ref(false);
const applyMsg = ref('');
const noChange = computed(() => {
  const d = proposal.value?.delta;
  return !!d && !d.personaChanged && !d.gates.changed.length && !d.gates.added.length && !d.gates.removed.length && !d.softRules.added.length && !d.softRules.removed.length && !d.positionRulesChangedKeys.length;
});

async function propose() {
  if (!active.value) return;
  proposing.value = true;
  applyMsg.value = '';
  chatErr.value = '';
  try {
    proposal.value = (await rulebookApi.propose({ sessionId: active.value.id })).data.data;
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '提议失败';
  } finally {
    proposing.value = false;
  }
}

async function applyProposal() {
  if (!proposal.value) return;
  applying.value = true;
  try {
    await rulebookApi.apply(proposal.value.suggestedLabel, proposal.value.proposal);
    applyMsg.value = `已采纳，规则升级到 ${proposal.value.suggestedLabel}`;
    proposal.value = null;
    // refresh the in-pane current-rulebook banner
    activeRulebook.value = (await rulebookApi.getActive()).data.data;
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '采纳失败';
  } finally {
    applying.value = false;
  }
}

function fmtTime(ts: string) {
  // sqlite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS"; show local time.
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? ts : d.toLocaleString('zh-CN', { hour12: false });
}
function kindIcon(k: ChatKind) {
  return { general: '💬', core_principle: '📜', stock: '📊', morning: '📈', evening: '🌙' }[k] || '💬';
}
function sessionLabel(s: ChatSession) {
  if (s.kind === 'core_principle') return '核心原则探讨';
  if (s.kind === 'stock') return `个股 ${s.ref_id || ''}`;
  return '新对话';
}

async function loadSessions() {
  sessions.value = (await chatApi.listSessions()).data.data;
}
async function open(s: ChatSession) {
  settingsMode.value = false;
  active.value = s;
  chatErr.value = '';
  proposal.value = null;
  applyMsg.value = '';
  messages.value = (await chatApi.getMessages(s.id)).data.data;
  scrollDown();
  // A freshly opened stock session auto-runs the rule-based analysis as its opener.
  if (s.kind === 'stock' && messages.value.length === 0) {
    await doAnalyze(s);
  }
}

async function doAnalyze(s: ChatSession) {
  if (analyzing.value) return;
  analyzing.value = true;
  chatErr.value = '';
  try {
    await chatApi.analyze(s.id);
    messages.value = (await chatApi.getMessages(s.id)).data.data;
    scrollDown();
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '分析失败';
  } finally {
    analyzing.value = false;
    // refresh the rail title even on block — the name is resolved independently of analysis
    await loadSessions();
    active.value = sessions.value.find((x) => x.id === s.id) || active.value;
  }
}
// delete button appears after hovering ~3s, hides on leave
const hoverDelId = ref<string | null>(null);
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function startHover(id: string) {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverDelId.value = id;
  }, 3000);
}
function endHover() {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverDelId.value = null;
}

async function removeSession(s: ChatSession) {
  if (!confirm(`删除「${s.title || sessionLabel(s)}」？${s.kind === 'stock' ? '（同时清空 agent 对该股的记忆/分析）' : ''}`)) return;
  await chatApi.deleteSession(s.id);
  if (active.value?.id === s.id) {
    active.value = null;
    messages.value = [];
  }
  hoverDelId.value = null;
  await loadSessions();
}

async function clearAllChats() {
  if (!confirm('清空所有对话？同时会清空 agent 对这些股票的记忆（分析报告）。')) return;
  await chatApi.clearAll();
  active.value = null;
  messages.value = [];
  await loadSessions();
}

async function newGeneral() {
  const id = (await chatApi.createSession('general')).data.data.id;
  await loadSessions();
  const s = sessions.value.find((x) => x.id === id);
  if (s) await open(s);
}
async function openCorePrinciple() {
  let s = sessions.value.find((x) => x.kind === 'core_principle');
  if (!s) {
    const id = (await chatApi.createSession('core_principle', null, '核心原则探讨')).data.data.id;
    await loadSessions();
    s = sessions.value.find((x) => x.id === id);
  }
  if (s) await open(s);
}
async function loadMeetings() {
  try {
    meetings.value = (await meetingsApi.today()).data.data;
  } catch {
    /* ignore */
  }
}
async function genMeeting(kind: 'morning' | 'evening') {
  genning.value = kind;
  chatErr.value = '';
  try {
    await meetingsApi.generate(kind);
    await loadMeetings();
    await openMeeting(kind);
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '生成失败';
  } finally {
    genning.value = '';
  }
}
async function openMeeting(kind: 'morning' | 'evening') {
  let s = sessions.value.find((x) => x.kind === kind);
  if (!s) {
    const id = (await chatApi.createSession(kind, null, kind === 'morning' ? '早会讨论' : '晚会讨论')).data.data.id;
    await loadSessions();
    s = sessions.value.find((x) => x.id === id);
  }
  if (s) await open(s);
}

async function openStockCode(code: string) {
  const c = code.trim();
  if (!c) return;
  // One window per stock: reuse an existing stock session for this code.
  let s = sessions.value.find((x) => x.kind === 'stock' && x.ref_id === c);
  if (!s) {
    const id = (await chatApi.createSession('stock', c, `个股 ${c}`)).data.data.id;
    await loadSessions();
    s = sessions.value.find((x) => x.id === id);
  }
  if (s) await open(s);
}
async function freeQuery() {
  const code = queryCode.value.trim();
  if (!code) return;
  queryCode.value = '';
  await openStockCode(code);
}
async function runScreen() {
  screening.value = true;
  chatErr.value = '';
  try {
    screen.value = (await screenApi.run({})).data.data;
    screenOpen.value = true;
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '选股失败';
  } finally {
    screening.value = false;
  }
}

async function send() {
  if (!active.value || !input.value.trim() || sending.value) return;
  const text = input.value.trim();
  input.value = '';
  chatErr.value = '';
  // optimistic
  messages.value.push({ id: 'tmp', session_id: active.value.id, role: 'user', content: text, created_at: '' });
  scrollDown();
  sending.value = true;
  try {
    const reply = (await chatApi.postMessage(active.value.id, text)).data.data;
    messages.value = (await chatApi.getMessages(active.value.id)).data.data;
    void reply;
    scrollDown();
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '发送失败';
  } finally {
    sending.value = false;
  }
}

function scrollDown() {
  nextTick(() => {
    if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
  });
}

function logout() {
  auth.logout();
  router.push('/login');
}

onMounted(async () => {
  if (!auth.user) await auth.fetchMe().catch(() => {});
  await loadSessions();
  await loadMeetings();
  try {
    screen.value = (await screenApi.latest()).data.data;
  } catch {
    /* ignore */
  }
  try {
    const rb = (await rulebookApi.getActive()).data.data;
    activeRulebook.value = rb;
    needsInit.value = !rb;
  } catch {
    /* ignore */
  }
});
</script>

<style scoped>
.shell { display: flex; height: 100vh; }
.rail { width: 260px; border-right: 1px solid #e5e5e5; display: flex; flex-direction: column; padding: 10px; overflow-y: auto; }
.brand { font-weight: 700; font-size: 16px; padding: 4px 6px 10px; }
.pinned { display: flex; flex-direction: column; gap: 6px; }
.pin-card { background: #f7f7f7; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.pin-card.soon { color: #888; }
.soon-tag { font-size: 10px; background: #eee; border-radius: 6px; padding: 0 4px; margin-left: 4px; }
.pin-btn { text-align: left; background: #eef3ff; border: none; border-radius: 6px; padding: 8px 10px; font-size: 13px; cursor: pointer; }
.pin-btn.active { background: #d8e6ff; }
.freeq { display: flex; gap: 4px; }
.freeq input { flex: 1; padding: 6px; }
.sect-head { display: flex; justify-content: space-between; align-items: center; margin: 12px 0 4px; font-size: 12px; color: #999; }
.sessions { list-style: none; padding: 0; margin: 0; flex: 1; }
.sessions li { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.sessions li.active { background: #eef; }
.kind { flex: none; }
.stitle { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.del { flex: none; border: none; background: none; color: #bbb; cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
.del:hover { color: #c00; }
.clearall { background: #fff3f3; border-color: #f3d0d0; margin-bottom: 6px; }
.menu { padding: 8px 4px; border-top: 1px solid #eee; }
.settings-entry { width: 100%; text-align: left; background: #f2f2f2; border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px 10px; font-size: 13px; cursor: pointer; }
.settings-entry.active { background: #e6e6ff; border-color: #c9c9f0; }
.settings-top { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #eee; padding-bottom: 8px; flex-wrap: wrap; }
.settings-nav { display: flex; gap: 6px; flex-wrap: wrap; }
.settings-nav button { background: none; border: 1px solid #ddd; border-radius: 14px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.settings-nav button.active { background: #333; color: #fff; border-color: #333; }
.settings-body { flex: 1; overflow-y: auto; }
.settings-menu { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 20px; }
.scard { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 20px; border: 1px solid #e5e5e5; border-radius: 10px; cursor: pointer; font-size: 14px; background: #fafafa; }
.scard:hover { background: #f0f0ff; }
.sicon { font-size: 24px; }
/* 内嵌设置页隐藏其自身的顶部标题/返回，避免与上方导航重复 */
.settings-body :deep(.bar) { display: none; }
.menu-old { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 4px; border-top: 1px solid #eee; font-size: 12px; }
.foot { display: flex; justify-content: space-between; align-items: center; padding-top: 6px; border-top: 1px solid #eee; }
.mini { font-size: 12px; background: none; border: 1px solid #ddd; border-radius: 6px; padding: 2px 6px; cursor: pointer; }
.muted { color: #999; font-size: 12px; }
.chat { flex: 1; display: flex; flex-direction: column; padding: 12px 16px; }
.initbar { background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 8px; }
.empty { margin: auto; text-align: center; color: #666; }
.title { font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
.stock-head { display: flex; gap: 8px; }
.analyzing { color: #a76b00; font-size: 13px; padding: 8px 0; }
.briefing { background: #f7faff; border: 1px solid #d6e4ff; border-radius: 8px; padding: 10px 12px; margin: 8px 0; white-space: pre-wrap; font-size: 13px; line-height: 1.6; }
.pin-card.gen { background: #eef7ee; cursor: pointer; border: 1px dashed #b7d7b7; text-align: left; }
.screen-sect { display: flex; flex-direction: column; gap: 4px; }
.fold { text-align: left; background: none; border: none; color: #666; font-size: 12px; cursor: pointer; padding: 2px 4px; }
.screen-list { max-height: 220px; overflow-y: auto; border: 1px solid #eee; border-radius: 6px; padding: 4px; }
.snote { padding: 2px 4px; }
.srow { padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow:hover { background: #f3f3f3; }
.badge2 { display: inline-block; width: 16px; text-align: center; border-radius: 4px; font-size: 11px; margin-right: 4px; }
.badge2.a { background: #d8e6ff; color: #34699a; }
.badge2.b { background: #fde2e2; color: #c0392b; }
.badge2.no { background: #eee; color: #aaa; }
.msgs { flex: 1; overflow-y: auto; padding: 12px 0; display: flex; flex-direction: column; gap: 10px; }
.msg { display: flex; flex-direction: column; align-items: flex-start; }
.msg.user { align-items: flex-end; }
.bubble { max-width: 75%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; line-height: 1.5; font-size: 14px; }
.msg.user .bubble { background: #d8e6ff; }
.msg.assistant .bubble { background: #f2f2f2; }
.mtime { font-size: 10px; color: #bbb; margin-top: 2px; }
.msg.user .mtime { text-align: right; }
.typing { color: #999; }
.propose-bar { margin: 6px 0; }
.propose-btn { width: 100%; background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 6px; padding: 8px; cursor: pointer; font-size: 13px; }
.proposal { background: #f3faf3; border: 1px solid #cce8cc; border-radius: 8px; padding: 10px 12px; margin: 6px 0; font-size: 13px; }
.proposal h4 { margin: 0 0 6px; }
.proposal p { margin: 2px 0; }
.proposal .ops { display: flex; gap: 8px; margin-top: 8px; }
.ok-msg { color: #2a8a2a; }
.composer { display: flex; gap: 8px; border-top: 1px solid #eee; padding-top: 8px; }
.composer textarea { flex: 1; padding: 8px; resize: none; }
.err { color: #c00; }
</style>
