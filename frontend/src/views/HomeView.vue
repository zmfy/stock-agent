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
          <StockPicker placeholder="自由查询：代码/名称/拼音" @pick="openStockCode" />
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
        <li v-for="s in sessions" :key="s.id" :class="{ active: active?.id === s.id, 'is-pinned': s.pinned === 1 }"
            @click="open(s)" @mouseenter="startHover(s.id)" @mouseleave="endHover">
          <span class="kind">{{ kindIcon(s.kind) }}</span>
          <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
          <button class="pin" :class="{ on: s.pinned === 1 }" :title="s.pinned === 1 ? '取消置顶' : '置顶'" @click.stop="togglePin(s)">📌</button>
          <button v-show="hoverDelId === s.id" class="del" title="删除（含清空该股记忆）" @click.stop="removeSession(s)">×</button>
        </li>
      </ul>

      <div class="menu">
        <button v-if="sessions.length" class="settings-entry clearall" @click="clearAllChats">🧹 清空所有对话</button>
      </div>
    </aside>

    <!-- 右侧：顶部功能栏（聊天框之外，常驻） + 聊天 或 功能面板 -->
    <main class="main">
      <nav class="topnav">
        <div class="tnav-scroll">
          <button class="tnav" :class="{ active: !settingsKey }" @click="goChat">💬 聊天</button>
          <button v-for="s in SETTINGS" :key="s.key" class="tnav" :class="{ active: settingsKey === s.key }" @click="settingsKey = s.key">
            <span class="ticon">{{ s.icon }}</span>{{ s.label }}
          </button>
        </div>
        <div class="topnav-user">
          <span class="uname">👤 {{ auth.user?.username }}</span>
          <button class="mini" @click="logout">登出</button>
        </div>
      </nav>

      <!-- 功能面板 -->
      <section v-if="settingsKey" class="panelbox">
        <component :is="currentSettingsComp" :key="settingsKey" />
      </section>

      <!-- 聊天 -->
      <section v-else class="chat">
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
            <router-link class="mini" :to="{ path: '/analysis', query: { code: active.ref_id } }">完整报告</router-link>
          </span>
        </div>
        <div v-if="analyzing" class="analyzing">正在按你的核心原则分析 {{ active.ref_id }} …</div>

        <!-- 早会/晚会简报 -->
        <div v-if="briefing" class="briefing">{{ briefing }}</div>

        <div class="convo" :class="{ 'with-side': active.kind === 'core_principle' }">
          <div class="convo-main">
            <div class="msgs" ref="msgsEl">
              <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
                <div class="bubble">{{ m.content }}</div>
                <div v-if="m.created_at" class="mtime">{{ fmtTime(m.created_at) }}</div>
              </div>
              <div v-if="sending" class="msg assistant"><div class="bubble typing">思考中…</div></div>
            </div>

            <div class="composer">
              <textarea v-model="input" rows="2" placeholder="输入消息，Enter 发送" @keydown.enter.exact.prevent="send"></textarea>
              <button :disabled="sending || !input.trim()" @click="send">发送</button>
            </div>
            <p v-if="chatErr" class="err">{{ chatErr }}</p>
          </div>

          <!-- 核心原则：规则操作面板（右侧，将来还会显示大盘/个股事实信息） -->
          <aside v-if="active.kind === 'core_principle'" class="cp-side">
            <!-- 更换/组合模板（多选） -->
            <div class="tplswitch">
              <div class="tpl-head">
                <span>更换 / 组合模板（可多选）</span>
                <button class="mini" @click="tplOpen = !tplOpen">{{ tplOpen ? '收起' : '展开' }}</button>
              </div>
              <div v-if="tplOpen">
                <div class="tplgrid">
                  <label v-for="t in templates" :key="t.key" class="tplcheck">
                    <input type="checkbox" :value="t.key" v-model="tplSelected" /> {{ t.label }}
                  </label>
                </div>
                <button :disabled="!tplSelected.length" @click="previewCompose">预览组合（{{ tplSelected.length }}）</button>

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
                  <button @click="applyCompose">换入为当前核心原则</button>
                </div>
                <span v-if="tplMsg" class="ok-msg">{{ tplMsg }}</span>
              </div>
            </div>

            <!-- 让 agent 提议修改 -->
            <div class="propose-bar">
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
          </aside>
        </div>
      </template>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { chatApi, type ChatSession, type ChatMessage, type ChatKind } from '../api/chat';
import { rulebookApi, type ProposeResult, type FullRulebook, type Gate, type TemplateMeta } from '../api/rulebook';
import { meetingsApi, type Meeting } from '../api/meetings';
import { screenApi, type ScreenRun } from '../api/screen';
import AnalysisView from './AnalysisView.vue';
import RulebookView from './RulebookView.vue';
import AiSettingsView from './AiSettingsView.vue';
import PluginsView from './PluginsView.vue';
import DataView from './DataView.vue';
import SettingsView from './SettingsView.vue';
import MeetingsHistoryView from './MeetingsHistoryView.vue';
import StockPicker from '../components/StockPicker.vue';

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
const settingsKey = ref(''); // '' = 聊天；否则为某个功能面板
const currentSettingsComp = computed(() => SETTINGS.find((s) => s.key === settingsKey.value)?.comp);
function goChat() {
  settingsKey.value = '';
}
const router = useRouter();

const sessions = ref<ChatSession[]>([]);
const active = ref<ChatSession | null>(null);
const messages = ref<ChatMessage[]>([]);
const input = ref('');
const sending = ref(false);
const chatErr = ref('');
const needsInit = ref(false);
const analyzing = ref(false);
const msgsEl = ref<HTMLElement | null>(null);
const meetings = ref<{ morning: Meeting | null; evening: Meeting | null }>({ morning: null, evening: null });
const genning = ref<'' | 'morning' | 'evening'>('');
const screen = ref<ScreenRun | null>(null);
const screening = ref(false);
const screenOpen = ref(true);
const activeRulebook = ref<FullRulebook | null>(null);
const templates = ref<TemplateMeta[]>([]);
const tplOpen = ref(false);
const tplSelected = ref<string[]>([]);
const orderedKeys = ref<string[]>([]);
const composeRes = ref<{ conflict: boolean; conflictFields: string[]; systems: any[]; versionLabel: string } | null>(null);
const tplMsg = ref('');
function labelOfKey(k: string) {
  return templates.value.find((t) => t.key === k)?.label || k;
}
async function previewCompose() {
  tplMsg.value = '';
  try {
    composeRes.value = (await rulebookApi.composePreview(tplSelected.value)).data.data;
    orderedKeys.value = [...tplSelected.value];
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '预览失败';
  }
}
function moveKey(i: number, dir: number) {
  const j = i + dir;
  const arr = orderedKeys.value;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
async function applyCompose() {
  if (!orderedKeys.value.length) return;
  if (!confirm('换入为当前核心原则？会新建一个版本并设为当前使用（旧版本保留可回滚）。')) return;
  try {
    await rulebookApi.applyCompose(orderedKeys.value);
    activeRulebook.value = (await rulebookApi.getActive()).data.data;
    // 换模板后清空本会话记忆，重新开始讨论
    if (active.value) {
      await chatApi.clearMessages(active.value.id);
      messages.value = [];
    }
    tplMsg.value = '已换入组合模板，已清空本次讨论记忆，重新开始';
    composeRes.value = null;
    tplSelected.value = [];
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '换入失败';
  }
}
function gateCond(g: Gate) {
  if (g.op === 'gt_field') return `${g.field} > ${g.ref_field}`;
  if (g.op === 'between') return `${g.threshold} < 值 < ${g.threshold2} ${g.unit}`;
  return `${g.op} ${g.threshold}${g.unit}`;
}
function buildCpBriefing(rb: FullRulebook | null): string {
  if (!rb) return '你还没有核心原则。请到「系统设置 → 核心规则」导入一个模板后，再来这里和我探讨优化。';
  const systems = [...new Set(rb.gates.map((g) => g.system))].sort();
  const blocks = systems
    .map((sys) => {
      const lines = rb.gates.filter((g) => g.system === sys).map((g) => `· ${g.label}：${gateCond(g)}${g.veto ? '（一票否决）' : ''}`).join('\n');
      return `${sys} 系统硬门槛：\n${lines || '（无）'}`;
    })
    .join('\n\n');
  const prio = (rb.positionRules as any)?.system_priority;
  const prioLine = Array.isArray(prio) && prio.length > 1 ? `\n系统优先级：${prio.join(' > ')}\n` : '';
  return (
    `【当前使用的核心原则 ${rb.version.version_label}】\n` +
    `人设：${rb.version.persona}\n${prioLine}\n` +
    `${blocks}\n\n` +
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
  settingsKey.value = ''; // 打开会话即回到聊天视图
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

async function togglePin(s: ChatSession) {
  await chatApi.setPinned(s.id, s.pinned !== 1);
  await loadSessions();
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
    templates.value = (await rulebookApi.getTemplates()).data.data;
  } catch {
    /* ignore */
  }
});
</script>

<style scoped>
.shell { display: flex; height: 100vh; background: var(--bg); }
.rail { width: 264px; flex: none; background: var(--rail-bg); color: var(--rail-fg); display: flex; flex-direction: column; padding: 14px 12px; overflow-y: auto; gap: 2px; }
.brand { font-weight: 700; font-size: 17px; color: #fff; padding: 4px 6px 14px; letter-spacing: 0.3px; }
.pinned { display: flex; flex-direction: column; gap: 6px; }
.pin-card { background: var(--rail-active); color: var(--rail-fg); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; }
.pin-card.soon { color: var(--rail-fg-dim); }
.soon-tag { font-size: 10px; background: rgba(255, 255, 255, 0.12); color: var(--rail-fg-dim); border-radius: 6px; padding: 0 4px; margin-left: 4px; }
.pin-btn { text-align: left; background: var(--rail-active); color: var(--rail-fg); border: none; border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; cursor: pointer; transition: background 0.15s, color 0.15s; }
.pin-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
.pin-btn.active { background: var(--accent); color: #fff; }
.freeq { display: flex; gap: 4px; }
.freeq input { flex: 1; padding: 7px 9px; background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.14); color: #fff; border-radius: var(--radius-sm); }
.freeq input::placeholder { color: var(--rail-fg-dim); }
.suggest { list-style: none; margin: 2px 0; padding: 0; max-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.suggest li { padding: 6px 9px; cursor: pointer; font-size: 13px; }
.suggest li:hover { background: var(--accent-soft); }
.sect-head { display: flex; justify-content: space-between; align-items: center; margin: 14px 0 4px; font-size: 11px; letter-spacing: 0.4px; text-transform: uppercase; color: var(--rail-fg-dim); }
.sessions { list-style: none; padding: 0; margin: 0; flex: 1; }
.sessions li { display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; gap: 4px; padding: 7px 9px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; color: var(--rail-fg); transition: background 0.12s; }
.sessions .kind { flex: none; }
.sessions li:hover { background: rgba(255, 255, 255, 0.07); }
.sessions li.active { background: var(--rail-active); color: #fff; }
.kind { flex: none; }
.stitle { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.del { flex: none; border: none; background: none; color: rgba(255, 255, 255, 0.35); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
.del:hover { color: #ff8a8d; }
.pin { flex: none; border: none; background: none; cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px; opacity: 0.3; filter: grayscale(1); }
.pin.on { opacity: 1; filter: none; }
.sessions li:hover .pin { opacity: 0.6; }
.sessions li:hover .pin.on { opacity: 1; }
.sessions li.is-pinned { background: rgba(255, 255, 255, 0.05); }
.sessions li.is-pinned.active { background: var(--rail-active); color: #fff; }
.clearall { background: rgba(229, 72, 77, 0.16) !important; border-color: rgba(229, 72, 77, 0.32) !important; color: #ffb3b5 !important; margin-bottom: 6px; }
.menu { padding: 10px 0 2px; border-top: 1px solid rgba(255, 255, 255, 0.1); margin-top: 4px; }
.settings-entry { width: 100%; text-align: left; background: rgba(255, 255, 255, 0.07); color: var(--rail-fg); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; cursor: pointer; transition: background 0.15s, color 0.15s; }
.settings-entry:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.settings-entry.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.settings-top { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #eee; padding-bottom: 8px; flex-wrap: wrap; }
.settings-nav { display: flex; gap: 6px; flex-wrap: wrap; }
.settings-nav button { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 4px 12px; font-size: 12px; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.settings-nav button:hover { border-color: var(--accent); color: var(--accent-600); }
.settings-nav button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.settings-body { flex: 1; overflow-y: auto; }
.settings-menu { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; padding: 20px; }
.scard { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; font-size: 14px; background: var(--surface); transition: all 0.15s; }
.scard:hover { border-color: var(--accent); box-shadow: var(--shadow-md); transform: translateY(-1px); }
.sicon { font-size: 24px; }
/* 功能面板隐藏其自身的顶部标题/返回，避免与上方功能栏重复 */
.panelbox :deep(.bar) { display: none; }
.menu-old { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 4px; border-top: 1px solid #eee; font-size: 12px; }
.mini { font-size: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 3px 9px; cursor: pointer; color: var(--text-soft); transition: all 0.15s; }
.mini:hover { border-color: var(--accent); color: var(--accent-600); }
.muted { color: var(--muted); font-size: 12px; }
/* 右侧主区：顶部功能栏 + 内容卡片 */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topnav { display: flex; align-items: center; gap: 10px; padding: 12px 14px 0; }
.tnav-scroll { flex: 1; min-width: 0; display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.tnav-scroll::-webkit-scrollbar { height: 6px; }
.topnav-user { flex: none; display: flex; align-items: center; gap: 8px; }
.uname { font-size: 12px; color: var(--text-soft); white-space: nowrap; }
.tnav { flex: none; white-space: nowrap; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 6px 13px; font-size: 13px; cursor: pointer; color: var(--text-soft); display: inline-flex; align-items: center; gap: 5px; transition: all 0.15s; }
.tnav:hover { border-color: var(--accent); color: var(--accent-600); }
.tnav.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.ticon { font-size: 14px; }
.panelbox { flex: 1; overflow-y: auto; margin: 14px; padding: 16px 20px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow); min-height: 0; }
.chat { flex: 1; display: flex; flex-direction: column; padding: 16px 20px; margin: 14px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow); min-width: 0; min-height: 0; }
/* 对话区：默认单栏；核心原则时右侧加规则操作面板 */
.convo { flex: 1; display: flex; min-height: 0; gap: 16px; }
.convo-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.cp-side { width: 300px; flex: none; overflow-y: auto; border-left: 1px solid #eee; padding-left: 14px; }
.cp-side .tplswitch, .cp-side .propose-bar, .cp-side .proposal { margin: 0 0 12px; }
.initbar { background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 8px; }
.empty { margin: auto; text-align: center; color: #666; }
.title { font-weight: 600; font-size: 15px; padding-bottom: 10px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
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
.bubble { max-width: 75%; padding: 9px 13px; border-radius: 12px; white-space: pre-wrap; line-height: 1.55; font-size: 14px; box-shadow: var(--shadow-sm); }
.msg.user .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.assistant .bubble { background: var(--surface-2); border: 1px solid var(--border-soft); color: var(--text); border-bottom-left-radius: 4px; }
.mtime { font-size: 10px; color: var(--muted); margin-top: 3px; }
.msg.user .mtime { text-align: right; }
.typing { color: #999; }
.tplswitch { font-size: 13px; background: #f7f9fc; border: 1px solid #dfe7f2; border-radius: 6px; padding: 6px 10px; margin: 6px 0; }
.tpl-head { display: flex; justify-content: space-between; align-items: center; }
.tplgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 12px; margin: 6px 0; }
.tplcheck { font-size: 12px; }
.composeprev { margin-top: 8px; border-top: 1px dashed #cdd; padding-top: 6px; }
.composeprev .warn { color: #a76b00; }
.sysrow { display: flex; justify-content: space-between; align-items: center; padding: 2px 0; }
.sysrow .ord { display: flex; gap: 4px; }
.propose-bar { margin: 6px 0; }
.propose-btn { width: 100%; background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 6px; padding: 8px; cursor: pointer; font-size: 13px; }
.proposal { background: #f3faf3; border: 1px solid #cce8cc; border-radius: 8px; padding: 10px 12px; margin: 6px 0; font-size: 13px; }
.proposal h4 { margin: 0 0 6px; }
.proposal p { margin: 2px 0; }
.proposal .ops { display: flex; gap: 8px; margin-top: 8px; }
.ok-msg { color: #2a8a2a; }
.composer { display: flex; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }
.composer textarea { flex: 1; padding: 9px 11px; resize: none; border-radius: var(--radius-sm); }
.composer button { background: var(--accent); color: #fff; border: none; border-radius: var(--radius-sm); padding: 0 20px; font-weight: 600; font-size: 14px; transition: background 0.15s; }
.composer button:hover:not(:disabled) { background: var(--accent-600); }
.composer button:disabled { opacity: 0.5; cursor: not-allowed; }
.err { color: var(--danger); }
</style>
