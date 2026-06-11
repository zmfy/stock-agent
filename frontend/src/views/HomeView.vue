<template>
  <div class="shell">
    <!-- 移动端左栏抽屉的遮罩 -->
    <div v-if="railOpen" class="drawer-backdrop" @click="railOpen = false"></div>
    <!-- 左栏 -->
    <aside class="rail" :class="{ open: railOpen }">
      <div class="brand">小作手 <span class="ver">v{{ APP_VERSION }}</span></div>

      <!-- 会话列表（admin 纯运维账号不显示聊天） -->
      <template v-if="!auth.isAdmin">
        <div class="sect-head">讨论记录</div>
        <ul class="sessions">
          <li v-for="s in sessions" :key="s.id" :class="{ active: active?.id === s.id, 'is-pinned': s.pinned === 1 }"
              @click="open(s)" @mouseenter="startHover(s.id)" @mouseleave="endHover">
            <span class="kind">{{ kindIcon(s.kind) }}</span>
            <span class="stitle">{{ s.title || sessionLabel(s) }}</span>
            <span v-if="generating.has(s.kind)" class="spinner sess-spin"></span>
            <button class="pin" :class="{ on: s.pinned === 1 }" :title="s.pinned === 1 ? '取消置顶' : '置顶'" @click.stop="togglePin(s)">📌</button>
            <button v-show="hoverDelId === s.id" class="del" title="删除会话（分析历史保留）" @click.stop="removeSession(s)">×</button>
          </li>
        </ul>

        <div class="menu">
          <button v-if="sessions.length" class="settings-entry clearall" @click="clearAllChats">🧹 清空所有对话</button>
        </div>
      </template>
      <p class="risk-note">⚠️ 仅研究辅助 · 不构成投资建议 · 盈亏自负</p>
    </aside>

    <!-- 右侧：顶部功能栏（聊天框之外，常驻） + 聊天 或 功能面板 -->
    <main class="main">
      <div
        v-if="auth.isAdmin && dataAlerts.length"
        class="alert-bar"
        :class="alertErrorCount ? 'err' : 'warn'"
        @click="settingsKey = 'alerts'"
      >
        {{ alertErrorCount ? '🔴' : '🟡' }} 数据告警 {{ dataAlerts.length }} 条（{{ alertErrorCount }} 错误 / {{ alertWarnCount }} 警告）— 点击查看
      </div>
      <nav class="topnav">
        <button class="hamburger" title="菜单" @click="railOpen = !railOpen">☰</button>
        <div class="tnav-scroll">
          <button v-if="!auth.isAdmin" class="tnav" :class="{ active: !settingsKey }" @click="goChat">💬 聊天</button>
          <button v-for="s in settingsMenu" :key="s.key" class="tnav" :class="{ active: settingsKey === s.key }" @click="settingsKey = s.key">
            <span class="ticon">{{ s.icon }}</span>{{ s.label }}
          </button>
        </div>
        <div class="topnav-user">
          <span class="uname">👤 {{ auth.user?.nickname || auth.user?.username }}</span>
          <button class="mini" @click="logout">登出</button>
        </div>
      </nav>

      <!-- 功能面板 -->
      <section v-if="settingsKey" class="panelbox">
        <component :is="currentSettingsComp" :key="settingsKey" />
      </section>

      <!-- 聊天 -->
      <section v-else class="chat">
        <div class="chat-row">
          <!-- 左：对话主体 -->
          <div class="chat-main">
            <div v-if="!active" class="empty">
              <h2>你好，我是来财。🤝</h2>

              <div v-if="needsInit" class="cp-cta">
                <div class="cp-cta-title">🎯 你还没有当前策略</div>
                <p class="cp-cta-desc">当前策略是我帮你选股、判断买卖的依据。现在还不能「按当前策略选股」，早晚会也只看大盘与板块。</p>
                <button class="cp-cta-btn" @click="startInterview">🗣 和来财聊出我的当前策略</button>
                <div class="cp-cta-alt"><router-link to="/onboarding">📋 或：选个模板快速开始 →</router-link></div>
              </div>

              <p class="muted">输入股票代码 / 名称 / 拼音，开一个该股的分析讨论；或在右侧操作框点「当前策略讨论 / 更换模板」。本系统是操盘专用工具，只做个股与当前策略的讨论。</p>
              <div class="qbox">
                <StockPicker placeholder="输入股票代码 / 名称 / 拼音，开个股讨论" @pick="onDefaultPick" />
              </div>
            </div>

            <template v-else>
              <div class="title">
                {{ active.title || sessionLabel(active) }}
                <span v-if="active.kind === 'stock'" class="stock-head">
                  <button class="mini" :disabled="analyzing" @click="doAnalyze(active)">{{ analyzing ? '按当前策略分析中…' : '🔄 重新按当前策略分析' }}</button>
                  <button class="mini" @click="openReport(active.ref_id!)">完整报告</button>
                </span>
                <button class="mini clear-cur" @click="clearCurrent" title="清空当前会话的消息">🧹 清理</button>
              </div>
              <div v-if="analyzing" class="analyzing">正在按你的当前策略分析 {{ active.ref_id }} …</div>
              <div v-if="active && generating.has(active.kind)" class="gen-banner">
                ⏳ 正在生成，可能需要一会儿。你可以先去别处，稍后回到本会话查看结果。
              </div>
              <div v-else-if="active && genErr[active.kind]" class="gen-banner err">
                生成失败：{{ genErr[active.kind] }}（可再次点击对应按钮重试）
              </div>
              <div v-if="briefing && briefingTime" class="briefing-time muted">🕐 生成于 {{ fmtCN(briefingTime) }}</div>
              <div v-if="briefing" class="briefing"><ClampText :text="briefing" @detail="openDetail" /></div>

              <template v-if="active?.kind === 'screen' && screen">
                <div class="screen-box">
                  <button class="fold" @click="screenHistOpen = !screenHistOpen">{{ screenHistOpen ? '▾' : '▸' }} 历史选股记录（{{ screenHistory.length }}）</button>
                  <div v-if="screenHistOpen" class="screen-hist">
                    <div v-for="(h, i) in screenHistory" :key="i" class="sh-row">
                      <div class="muted">{{ fmtCN(h.created_at) }} · {{ h.note }}</div>
                      <div v-for="p in h.picks" :key="p.code" class="sh-pick" @click="openStockCode(p.code)">{{ p.name || p.code }} <span class="muted">{{ p.code }} · {{ p.reason }}</span></div>
                      <div v-if="!h.picks.length" class="muted">（本次无入选）</div>
                    </div>
                  </div>
                  <div class="screen-results">
                    <div v-for="r in screenPicks" :key="r.code" class="srow" @click="openStockCode(r.code)">
                      <span class="badge2" :class="r.aPass ? 'a' : 'b'">{{ r.aPass ? 'A' : 'B' }}</span>
                      {{ r.name || r.code }} <span class="muted">{{ r.code }} · {{ r.reason }}</span>
                    </div>
                    <div v-if="!screenPicks.length" class="muted">本次无入选个股。</div>
                  </div>
                </div>
              </template>

              <div v-if="adoptedNews.length" class="adopted-news-box">
                <div class="an-head">来财采用的新闻</div>
                <ul class="an-list">
                  <li v-for="an in adoptedNews" :key="an.content_id">
                    <a href="#" @click.prevent="showMeetingNews(an.content_id)">{{ an.title }}</a>
                  </li>
                </ul>
                <div v-if="openMeetingNews" class="an-content">
                  <div class="an-content-head"><b>{{ openMeetingNews.title }}</b><button class="mini" @click="openMeetingNews = null">关闭</button></div>
                  <p>{{ openMeetingNews.content || '（无正文）' }}</p>
                </div>
              </div>

              <div class="msgs" ref="msgsEl">
                <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
                  <div class="bubble"><ClampText :text="m.content" @detail="openDetail" /></div>
                  <div v-if="m.created_at" class="mtime">{{ fmtTime(m.created_at) }}</div>
                </div>
                <div v-if="sending" class="msg assistant"><div class="bubble typing">思考中…</div></div>
        <div v-if="proposal && !synthFromScratch" class="msg assistant">
          <div class="bubble proposal-card">
            <h4>修改提议（{{ proposal.magnitude === 'major' ? '较大改动' : '微调' }}）：{{ proposal.currentLabel }} → <b>{{ proposal.suggestedLabel }}</b></h4>
            <p v-if="proposal.delta.personaChanged">· 人设有改动</p>
            <p v-for="c in proposal.delta.gates.changed" :key="c.gate_key">· 门槛 <b>{{ c.gate_key }}</b>：{{ c.from.threshold }} → {{ c.to.threshold }}</p>
            <p v-for="k in proposal.delta.gates.added" :key="'a'+k">· 新增门槛 {{ k }}</p>
            <p v-for="k in proposal.delta.gates.removed" :key="'r'+k">· 删除门槛 {{ k }}</p>
            <p v-if="proposal.delta.softRules.added.length || proposal.delta.softRules.removed.length">· 软判断 +{{ proposal.delta.softRules.added.length }} / -{{ proposal.delta.softRules.removed.length }}</p>
            <p v-if="proposal.delta.positionRulesChangedKeys.length">· 仓位规则改动：{{ proposal.delta.positionRulesChangedKeys.join('、') }}</p>
            <p v-if="noChange" class="muted">无实质改动</p>
            <p v-if="proposal.proposal.note" class="muted">理由：{{ proposal.proposal.note }}</p>
            <p v-if="proposedAt" class="muted">🕐 {{ fmtCN(proposedAt) }}</p>
            <div class="ops">
              <button :disabled="applying || noChange" @click="applyProposal">采纳并升级到 {{ proposal.suggestedLabel }}</button>
              <button @click="proposal = null; synthFromScratch = false">放弃</button>
            </div>
          </div>
        </div>
        <div v-if="proposal && synthFromScratch" class="msg assistant">
          <div class="bubble proposal-card">
            <h4>📋 来财据我们的聊天生成的当前策略：<b>{{ proposal.suggestedLabel }}</b></h4>
            <p class="synth-persona"><b>人设：</b>{{ (proposal as any).proposal.persona }}</p>
            <div v-for="sys in synthSystems" :key="sys" class="synth-sys">
              <b>{{ sys }} 系统硬门槛：</b>
              <ul>
                <li v-for="g in (proposal as any).proposal.gates.filter((x: any) => x.system === sys)" :key="g.gate_key">
                  {{ g.label }}：{{ gateCond(g) }}{{ g.veto ? '（一票否决）' : '' }}
                </li>
              </ul>
            </div>
            <div v-if="(proposal as any).proposal.softRules.length" class="synth-soft">
              <b>软判断：</b>
              <ul><li v-for="(s, i) in (proposal as any).proposal.softRules" :key="i">{{ (s as any).text }}</li></ul>
            </div>
            <p v-if="proposedAt" class="muted">🕐 {{ fmtCN(proposedAt) }}</p>
            <div class="ops">
              <button :disabled="applying" @click="applyProposal">采纳并保存为 {{ proposal.suggestedLabel }}</button>
              <button @click="proposal = null; synthFromScratch = false">放弃</button>
            </div>
          </div>
        </div>
              </div>

              <div class="composer">
                <textarea v-model="input" rows="2" placeholder="输入消息，Enter 发送" @keydown.enter.exact.prevent="send"></textarea>
                <button :disabled="sending || !input.trim()" @click="send">发送</button>
              </div>
              <p v-if="chatErr" class="err">{{ chatErr }}</p>
            </template>
          </div>

          <!-- 右：操作框（所有聊天通用，可隐藏） -->
          <aside v-if="opsOpen" class="ops-side">
            <div class="ops-head"><span>操作面板</span><button class="mini" @click="opsOpen = false">收起 ›</button></div>

            <!-- 早会 -->
            <button v-if="meetings.morning" class="ops-btn" :class="{ active: active?.kind === 'morning' }" @click="openMeeting('morning')">📈 今日操作方向（早会）</button>
            <button v-else class="ops-btn dashed" @click="genMeeting('morning')">📈 生成今日早会</button>

            <!-- 晚会 -->
            <button v-if="meetings.evening" class="ops-btn" :class="{ active: active?.kind === 'evening' }" @click="openMeeting('evening')">🌙 今日操作复盘（晚会）</button>
            <button v-else class="ops-btn dashed" @click="genMeeting('evening')">🌙 生成今日晚会</button>

            <!-- 选股 -->
            <button class="ops-btn" @click="runScreen">🔍 按当前策略选股</button>

            <!-- 当前策略讨论 / 更换模板（合并入口） -->
            <button class="ops-btn" :class="{ active: active?.kind === 'core_principle' }" @click="openPrincipleAndTemplates">📜 当前策略讨论 / 更换模板</button>

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

            <!-- 让 agent 提议修改（进入当前策略讨论后显示，在换模板按钮下边） -->
            <template v-if="active?.kind === 'core_principle'">
              <div class="propose-bar">
                <button v-if="needsInit" class="propose-btn" :disabled="synthesizing" @click="synthesizePrinciple">
                  <span v-if="synthesizing" class="spinner"></span>{{ synthesizing ? '来财生成中…' : '🛠 根据我们的聊天，帮我生成当前策略' }}
                </button>
                <button v-else class="propose-btn" :disabled="proposing" @click="propose">
                  <span v-if="proposing" class="spinner"></span>{{ proposing ? 'agent 拟定中…' : '🛠 根据本次讨论，让 agent 提议修改规则' }}
                </button>
              </div>

            </template>

            <!-- A 股日历（面板最底部，点击在按钮上方弹出当月休市日） -->
            <div class="cal-wrap">
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
                  <span v-for="d in calDays" :key="d.date"
                        class="cal-cell" :class="{ closed: !d.trading, today: d.date === calToday }">
                    {{ Number(d.date.slice(8, 10)) }}
                    <i v-if="!d.trading" class="cal-x">休</i>
                  </span>
                </div>
                <div class="cal-foot muted">灰色=休市（周末/节假日），不开早晚会；今日高亮。</div>
              </div>
              <button class="ops-btn" @click="toggleCalendar">📅 A 股日历</button>
            </div>
          </aside>
        </div>

        <!-- 操作框隐藏后，右下角悬浮重开按钮 -->
        <button v-if="!opsOpen" class="ops-fab" @click="opsOpen = true" title="显示操作框">⚙ 操作</button>
      </section>
    </main>
    <MarkdownModal :open="detailOpen" :text="detailText" @close="detailOpen = false" />
    <ReportModal :open="reportOpen" :code="reportCode" @close="reportOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { APP_VERSION } from '../version';
import { useAuthStore } from '../stores/auth';
import { chatApi, type ChatSession, type ChatMessage, type ChatKind } from '../api/chat';
import { rulebookApi, type ProposeResult, type FullRulebook, type Gate, type TemplateMeta } from '../api/rulebook';
import { meetingsApi, type Meeting } from '../api/meetings';
import { screenApi, type ScreenRun } from '../api/screen';
import { dataApi, type DataAlert } from '../api/data';
import { fmtCN, fmtCNDate } from '../utils/time';
import AnalysisView from './AnalysisView.vue';
import RulebookView from './RulebookView.vue';
import AiSettingsView from './AiSettingsView.vue';
import PluginsView from './PluginsView.vue';
import DataView from './DataView.vue';
import DataAlertsView from './DataAlertsView.vue';
import SettingsView from './SettingsView.vue';
import MeetingsHistoryView from './MeetingsHistoryView.vue';
import CronsView from './CronsView.vue';
import StockPicker from '../components/StockPicker.vue';
import ClampText from '../components/ClampText.vue';
import MarkdownModal from '../components/MarkdownModal.vue';
import ReportModal from '../components/ReportModal.vue';

const auth = useAuthStore();

// 系统设置：右侧内嵌这些页面，左栏不变
// roles: 'user' = 仅普通用户(交易功能)；'admin' = 仅 admin(运维)；'both' = 两者都有。
const SETTINGS = [
  { key: 'rulebook', label: '当前策略', icon: '📜', comp: RulebookView, roles: 'user' },
  { key: 'meetings', label: '早晚会历史', icon: '🗓', comp: MeetingsHistoryView, roles: 'user' },
  { key: 'analysis', label: '分析历史', icon: '📊', comp: AnalysisView, roles: 'user' },
  { key: 'data', label: '数据管理', icon: '📈', comp: DataView, roles: 'admin' },
  { key: 'alerts', label: '数据告警', icon: '🚨', comp: DataAlertsView, roles: 'admin' },
  { key: 'ai', label: 'AI 模型', icon: '🤖', comp: AiSettingsView, roles: 'both' },
  { key: 'plugins', label: '能力插件', icon: '🧩', comp: PluginsView, roles: 'both' },
  { key: 'crons', label: '定时任务', icon: '⏰', comp: CronsView, roles: 'admin' },
  { key: 'account', label: '账号设置', icon: '👤', comp: SettingsView, roles: 'both' },
];
// '' = 聊天；否则为某个功能面板。admin 无聊天:此处覆盖 user 已水合的热路径;冷启动(user 尚未 fetchMe)时由 onMounted 兜底设为 'data'。
const settingsKey = ref(auth.isAdmin ? 'data' : '');
const settingsMenu = computed(() =>
  SETTINGS.filter((s: any) => s.roles === 'both' || s.roles === (auth.isAdmin ? 'admin' : 'user')),
);
const currentSettingsComp = computed(() => SETTINGS.find((s) => s.key === settingsKey.value)?.comp);
function goChat() {
  if (auth.isAdmin) return; // admin 纯运维账号无聊天视图，防止被程序化调用落入聊天壳
  settingsKey.value = '';
}
const router = useRouter();
const route = useRoute();

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
// 正在后台生成的会话种类（morning/evening/screen）——SPA 内切换不丢
const generating = reactive(new Set<string>());
// 后台生成失败信息，按 kind 记录
const genErr = reactive<Record<string, string>>({});
const screen = ref<ScreenRun | null>(null);
// 选股讨论只展示入选（A/B 通过）个股，未入选不显示
const screenPicks = computed(() => (screen.value?.results || []).filter((r) => r.aPass || r.bPass));
const screenHistory = ref<Array<{ created_at: string; note: string; picks: Array<{ code: string; name: string | null; reason: string }> }>>([]);
const screenHistOpen = ref(false);

const dataAlerts = ref<DataAlert[]>([]);
const alertErrorCount = computed(() => dataAlerts.value.filter((a) => a.level === 'error').length);
const alertWarnCount = computed(() => dataAlerts.value.filter((a) => a.level === 'warn').length);
let alertsTimer: number | undefined;
async function loadDataAlerts() {
  try {
    dataAlerts.value = (await dataApi.getAlerts()).alerts;
  } catch {
    /* ignore */
  }
}

// A 股日历弹窗
const calToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD（北京）
const calOpen = ref(false);
const calYear = ref(Number(calToday.slice(0, 4)));
const calMonth = ref(Number(calToday.slice(5, 7)));
const calDays = ref<Array<{ date: string; trading: boolean }>>([]);
// 当月 1 号是周几（周一=0 … 周日=6），用于网格前置空格
const calLead = computed(() => {
  const first = `${calYear.value}-${String(calMonth.value).padStart(2, '0')}-01`;
  return (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
});
// 日历封顶：只显示到当年 12 月；每年 11/30 之后才放开到明年 12 月。
const calMax = (() => {
  const y = Number(calToday.slice(0, 4));
  const m = Number(calToday.slice(5, 7));
  const d = Number(calToday.slice(8, 10));
  const afterNov30 = m > 11 || (m === 11 && d >= 30);
  return { year: afterNov30 ? y + 1 : y, month: 12 };
})();
const atCalMax = computed(() => calYear.value > calMax.year || (calYear.value === calMax.year && calMonth.value >= calMax.month));
async function loadCalendar() {
  try {
    calDays.value = (await dataApi.tradeCalendar(calYear.value, calMonth.value)).days;
  } catch {
    calDays.value = [];
  }
}
function toggleCalendar() {
  calOpen.value = !calOpen.value;
  // 每次打开都回到当前月份（不记忆上次翻到哪），并重新加载。
  if (calOpen.value) {
    calYear.value = Number(calToday.slice(0, 4));
    calMonth.value = Number(calToday.slice(5, 7));
    loadCalendar();
  }
}
function prevMonth() {
  if (calMonth.value === 1) { calMonth.value = 12; calYear.value--; } else calMonth.value--;
  loadCalendar();
}
function nextMonth() {
  if (atCalMax.value) return; // 封顶：不允许翻到当年(或明年)12 月之后
  if (calMonth.value === 12) { calMonth.value = 1; calYear.value++; } else calMonth.value++;
  loadCalendar();
}
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;
const opsOpen = ref(!isMobile); // 右侧操作框是否展开（手机默认收起，避免遮挡）
const railOpen = ref(false); // 移动端左栏抽屉
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
// 合并入口：进入当前策略讨论 + 展开模板区
async function openPrincipleAndTemplates() {
  tplOpen.value = true;
  await openCorePrinciple();
}
async function previewCompose() {
  tplMsg.value = '';
  try {
    composeRes.value = (await rulebookApi.composePreview(tplSelected.value)).data.data;
    orderedKeys.value = [...tplSelected.value];
    // 预览组合后直接进入当前策略讨论（随后右侧会显示「让 agent 提议修改规则」）
    await openCorePrinciple();
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
  if (!confirm('换入为当前策略？会新建一个版本并设为当前使用（旧版本保留可回滚）。')) return;
  try {
    await rulebookApi.applyCompose(orderedKeys.value, active.value?.id);
    activeRulebook.value = (await rulebookApi.getActive()).data.data;
    tplMsg.value = '已换入组合模板。下次进入当前策略讨论将重新开始';
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
  if (!rb)
    return (
      '你好，我是来财。你还没有当前策略，我们用聊天的方式一起把它定出来。\n' +
      '我会问你几个问题，了解你平时怎么选股、怎么买卖；你照实说就行，没想清楚的也没关系。\n\n' +
      '先聊第一个：你平时主要看公司基本面（业绩、估值），还是看走势（均线、突破），还是两者都看？\n\n' +
      '（聊得差不多了，点下方「🛠 根据我们的聊天，帮我生成当前策略」，我就帮你总结成一套规则。）'
    );
  const systems = [...new Set(rb.gates.map((g) => g.system))].sort();
  const blocks = systems
    .map((sys) => {
      const lines = rb.gates.filter((g) => g.system === sys).map((g) => `· ${g.label}：${gateCond(g)}${g.veto ? '（一票否决）' : ''}`).join('\n');
      return `${sys} 系统硬门槛：\n${lines || '（无）'}`;
    })
    .join('\n\n');
  const prio = (rb.positionRules as any)?.system_priority;
  const prioLine = Array.isArray(prio) && prio.length > 1 ? `\n系统优先级：${prio.join(' > ')}\n` : '';
  const changed = rb.version.created_at ? `（最后更换：${fmtCNDate(rb.version.created_at)}）` : '';
  return (
    `【当前策略 ${rb.version.version_label}${changed}】\n` +
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
  if (active.value?.kind === 'screen') return screen.value ? (screen.value.note + (screen.value.discussion ? '\n\n' + screen.value.discussion : '')) : '点右侧「按当前策略选股」开始';
  return '';
});

// 纪要(早会/晚会/选股)的生成时间，供展示「生成于…」判断是否过时
const briefingTime = computed<string | null>(() => {
  if (active.value?.kind === 'morning') return meetings.value.morning?.created_at ?? null;
  if (active.value?.kind === 'evening') return meetings.value.evening?.created_at ?? null;
  if (active.value?.kind === 'screen') return screen.value?.created_at ?? null;
  return null;
});

// 当前策略修改提议
const proposal = ref<ProposeResult | null>(null);
const proposedAt = ref<string>('');
const proposing = ref(false);
const applying = ref(false);
const synthesizing = ref(false);
const synthFromScratch = ref(false);
const noChange = computed(() => {
  const d = proposal.value?.delta;
  return !!d && !d.personaChanged && !d.gates.changed.length && !d.gates.added.length && !d.gates.removed.length && !d.softRules.added.length && !d.softRules.removed.length && !d.positionRulesChangedKeys.length;
});
const synthSystems = computed<string[]>(() => {
  const gs = ((proposal.value as any)?.proposal?.gates || []) as Array<{ system: string }>;
  return [...new Set(gs.map((g) => g.system))].sort();
});

const adoptedNews = computed<Array<{ content_id: string; title: string }>>(() => {
  const mt = active.value?.kind === 'morning' ? meetings.value.morning : active.value?.kind === 'evening' ? meetings.value.evening : null;
  if (!mt || !mt.data) return [];
  try { return (JSON.parse(mt.data).adopted_news) || []; } catch { return []; }
});
const openMeetingNews = ref<{ title: string; content: string } | null>(null);
async function showMeetingNews(id: string) { openMeetingNews.value = await dataApi.newsContent(id); }

async function propose() {
  if (!active.value) return;
  proposing.value = true;
  chatErr.value = '';
  try {
    proposal.value = (await rulebookApi.propose({ sessionId: active.value.id })).data.data;
    proposedAt.value = new Date().toISOString();
  } catch (e: any) {
    const msg = e.response?.data?.message || '提议失败';
    chatErr.value = msg;
    await noteErrorToSession(active.value?.id, `提议修改失败：${msg}`);
  } finally {
    proposing.value = false;
  }
}

async function synthesizePrinciple() {
  if (!active.value) return;
  synthesizing.value = true;
  chatErr.value = '';
  try {
    const r = (await rulebookApi.synthesize(active.value.id)).data.data;
    // 复用 proposal 展示通道：合成结果只有 proposal + suggestedLabel（无 delta），标记 fromScratch 走完整预览
    proposal.value = { proposal: r.proposal, suggestedLabel: r.suggestedLabel } as any;
    synthFromScratch.value = true;
    proposedAt.value = new Date().toISOString();
  } catch (e: any) {
    const msg = e.response?.data?.message || '生成失败';
    chatErr.value = msg;
    await noteErrorToSession(active.value?.id, `生成当前策略失败：${msg}`);
  } finally {
    synthesizing.value = false;
  }
}

async function applyProposal() {
  if (!proposal.value) return;
  applying.value = true;
  try {
    const label = proposal.value.suggestedLabel;
    await rulebookApi.apply(label, proposal.value.proposal, active.value?.id);
    proposal.value = null;
    activeRulebook.value = (await rulebookApi.getActive()).data.data;
    needsInit.value = false;
    synthFromScratch.value = false;
    messages.value.push({
      id: 'local-applied-' + Date.now(),
      session_id: active.value?.id || '',
      role: 'assistant',
      content: `✅ 已采纳，规则升级到 ${label}。\n\n` + buildCpBriefing(activeRulebook.value),
      created_at: new Date().toISOString(),
    } as ChatMessage);
    await nextTick();
    if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '采纳失败';
  } finally {
    applying.value = false;
  }
}

function fmtTime(ts: string) {
  // DB 时间为 UTC，统一显示北京时间（见 utils/time）
  return fmtCN(ts);
}
function kindIcon(k: ChatKind) {
  const icons: Record<ChatKind, string> = { general: '💬', core_principle: '📜', stock: '📊', morning: '📈', evening: '🌙', screen: '🔍' };
  return icons[k] || '💬';
}
function sessionLabel(s: ChatSession) {
  if (s.kind === 'core_principle') return '当前策略探讨';
  if (s.kind === 'stock') return `个股 ${s.ref_id || ''}`;
  if (s.kind === 'screen') return '选股讨论';
  return '新对话';
}

async function loadSessions() {
  sessions.value = (await chatApi.listSessions()).data.data;
}
async function open(s: ChatSession) {
  settingsKey.value = ''; // 打开会话即回到聊天视图
  railOpen.value = false; // 手机端选中会话后收起抽屉
  active.value = s;
  chatErr.value = '';
  proposal.value = null;
  messages.value = (await chatApi.getMessages(s.id)).data.data;
  scrollDown();
  // A freshly opened stock session auto-runs the rule-based analysis as its opener.
  if (s.kind === 'stock' && messages.value.length === 0) {
    await doAnalyze(s);
  }
  // When opening a screen session, ensure screen data is loaded.
  if (s.kind === 'screen') {
    if (!screen.value) {
      try {
        screen.value = (await screenApi.latest()).data.data;
      } catch {
        /* ignore */
      }
    }
    await loadScreenHistory();
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
    const msg = e.response?.data?.message || '分析失败';
    chatErr.value = msg;
    await noteErrorToSession(s.id, `分析失败：${msg}`);
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
  if (!confirm(`删除会话「${s.title || sessionLabel(s)}」？（分析历史保留，可在「分析历史」查看）`)) return;
  await chatApi.deleteSession(s.id);
  if (active.value?.id === s.id) {
    active.value = null;
    messages.value = [];
  }
  hoverDelId.value = null;
  await loadSessions();
}

async function clearAllChats() {
  if (!confirm('清空所有对话？只清左侧会话列表，分析历史保留（可在「分析历史」查看）。')) return;
  await chatApi.clearAll();
  active.value = null;
  messages.value = [];
  await loadSessions();
}

// 清空「当前」会话的消息（持久化），会话本身保留。
async function clearCurrent() {
  if (!active.value) return;
  if (!confirm('清空当前会话的消息？（会话保留，消息不可恢复）')) return;
  try {
    await chatApi.clearMessages(active.value.id);
    messages.value = [];
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '清理失败';
  }
}

// 详情弹层（3 行折叠 → 点「详细」看全文 markdown）
const detailOpen = ref(false);
const detailText = ref('');
function openDetail(text: string) {
  detailText.value = text;
  detailOpen.value = true;
}

// 个股完整报告弹层（替代跳转 /analysis）
const reportOpen = ref(false);
const reportCode = ref('');
function openReport(code: string) {
  reportCode.value = code;
  reportOpen.value = true;
}

// 把后台流程错误以「来财发言」写入会话并即时显示。
async function noteErrorToSession(sessionId: string | undefined | null, msg: string) {
  if (!sessionId) return;
  try {
    const m = (await chatApi.postNote(sessionId, `⚠️ ${msg}`)).data.data;
    if (active.value?.id === sessionId) {
      messages.value.push(m);
      await nextTick();
      if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
    }
  } catch {
    /* 兜底：postNote 失败就不阻塞 */
  }
}

async function openCorePrinciple() {
  let s = sessions.value.find((x) => x.kind === 'core_principle');
  if (!s) {
    const id = (await chatApi.createSession('core_principle', null, '当前策略探讨')).data.data.id;
    await loadSessions();
    s = sessions.value.find((x) => x.id === id);
  }
  if (s) {
    if (needsInit.value) {
      // 访谈模式（无当前策略）：保留已有对话，重开不清空，否则会丢失正在进行的访谈记录
      await open(s);
    } else {
      // 修改讨论模式（已有当前策略）：每次重开都重置，基于当前规则重新讨论
      await chatApi.clearMessages(s.id);
      await open(s);
      messages.value = [];
    }
  }
}
async function startInterview() {
  chatErr.value = '';
  try {
    await openCorePrinciple();
  } catch (e: any) {
    chatErr.value = e.response?.data?.message || '进入访谈失败';
  }
}
async function loadMeetings() {
  try {
    meetings.value = (await meetingsApi.today()).data.data;
  } catch {
    /* ignore */
  }
}
async function genMeeting(kind: 'morning' | 'evening') {
  // 已在后台生成中：只切回该会话，不重复触发
  if (generating.has(kind)) {
    await openMeeting(kind);
    return;
  }
  delete genErr[kind];
  generating.add(kind); // 同步置位，早于任何 await，关闭重复触发窗口
  try {
    await openMeeting(kind); // 立即打开会话窗口（不等生成）
  } catch (e: any) {
    genErr[kind] = e.response?.data?.message || '打开会话失败';
    generating.delete(kind);
    return;
  }
  // 不 await：后台生成，完成后刷新 meetings.value，briefing 靠响应式自动更新
  meetingsApi
    .generate(kind)
    .then(() => loadMeetings())
    .catch((e: any) => {
      const msg = e.response?.data?.message || '生成失败';
      genErr[kind] = msg;
      noteErrorToSession(sessions.value.find((x) => x.kind === kind)?.id, `${kind === 'morning' ? '早会' : '晚会'}生成失败：${msg}`);
    })
    .finally(() => {
      generating.delete(kind);
    });
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

const AGENT_NAME = '来财'; // 主 agent 的名字

// 默认页查询框：输入「来财」与主 agent 讨论当前策略，否则按股票开个股讨论
function onDefaultPick(val: string) {
  if (val.trim() === AGENT_NAME) return summonMainAgent();
  return openStockCode(val);
}
// 呼叫主 agent 来财 = 进入当前策略讨论（本系统是操盘工具，不做无目的闲聊）
async function summonMainAgent() {
  await openCorePrinciple();
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
async function loadScreenHistory() {
  try {
    screenHistory.value = await screenApi.history(20);
  } catch {
    /* ignore */
  }
}
async function openScreen() {
  let s = sessions.value.find((x) => x.kind === 'screen');
  if (!s) {
    const id = (await chatApi.createSession('screen', null, '选股讨论')).data.data.id;
    await loadSessions();
    s = sessions.value.find((x) => x.id === id);
  }
  if (s) await open(s);
}
async function runScreen() {
  if (needsInit.value) {
    chatErr.value = '你还没有当前策略，无法按当前策略选股。先点上方/中间的「🗣 和来财聊出我的当前策略」定一套吧。';
    return;
  }
  // 已在后台选股中：只切回选股会话，不重复触发
  if (generating.has('screen')) {
    await openScreen();
    return;
  }
  delete genErr['screen'];
  generating.add('screen'); // 同步置位，早于任何 await，关闭重复触发窗口
  try {
    await openScreen(); // 立即打开选股会话窗口（不等选股结果）
  } catch (e: any) {
    genErr['screen'] = e.response?.data?.message || '打开会话失败';
    generating.delete('screen');
    return;
  }
  // 不 await：后台选股，完成后刷新 screen.value + 历史，briefing 靠响应式自动更新
  screenApi
    .run({})
    .then((r) => {
      screen.value = r.data.data;
      return loadScreenHistory();
    })
    .catch((e: any) => {
      const msg = e.response?.data?.message || '选股失败';
      genErr['screen'] = msg;
      noteErrorToSession(sessions.value.find((x) => x.kind === 'screen')?.id, `选股失败：${msg}`);
    })
    .finally(() => {
      generating.delete('screen');
    });
}

async function send() {
  if (!active.value || !input.value.trim() || sending.value) return;
  const text = input.value.trim();
  // 全局召唤词「来财」：在任意会话里输入「来财」或「来财 …」即切到主 agent 对话，
  // 「来财」后面的内容作为消息发给主 agent。
  if (/^来财(\s|[，,：:！!。.]|$)/.test(text)) {
    const rest = text.replace(/^来财[\s，,：:！!。.]*/, '').trim();
    input.value = '';
    await summonMainAgent();
    if (rest) {
      input.value = rest;
      await send();
    }
    return;
  }
  input.value = '';
  chatErr.value = '';
  // optimistic
  messages.value.push({ id: 'tmp', session_id: active.value.id, role: 'user', content: text, created_at: new Date().toISOString() });
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
  // admin 是纯运维账号：不加载聊天/早晚会/当前策略，默认停在运维面板。
  if (auth.isAdmin) {
    if (!settingsKey.value) settingsKey.value = 'data';
    await loadDataAlerts();
    alertsTimer = window.setInterval(loadDataAlerts, 30000);
    return;
  }
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
  // 向导选了「帮我聊出来」→ 落地自动进入当前策略访谈
  if (route.query.interview === '1' && needsInit.value) {
    await startInterview();
  }
});
onUnmounted(() => {
  if (alertsTimer) clearInterval(alertsTimer);
});
</script>

<style scoped>
.shell { display: flex; height: 100vh; background: var(--bg); }
.rail { width: 264px; flex: none; background: var(--rail-bg); color: var(--rail-fg); display: flex; flex-direction: column; padding: 14px 12px; overflow-y: auto; gap: 2px; }
.brand { font-weight: 700; font-size: 17px; color: #fff; padding: 4px 6px 14px; letter-spacing: 0.3px; }
.brand .ver { font-size: 11px; font-weight: 600; opacity: 0.6; }
.pinned { display: flex; flex-direction: column; gap: 6px; }
.pin-card { background: var(--rail-active); color: var(--rail-fg); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; }
.pin-card.soon { color: var(--rail-fg-dim); }
.soon-tag { font-size: 10px; background: rgba(255, 255, 255, 0.12); color: var(--rail-fg-dim); border-radius: 6px; padding: 0 4px; margin-left: 4px; }
.pin-btn { text-align: left; background: var(--rail-active); color: var(--rail-fg); border: none; border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; cursor: pointer; transition: background 0.15s, color 0.15s; }
.pin-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
.pin-btn.active { background: var(--accent); color: #fff; }
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
.risk-note { font-size: 11px; color: var(--rail-fg-dim); line-height: 1.5; margin: 6px 2px 2px; }
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
.hamburger { display: none; flex: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 16px; line-height: 1; padding: 6px 10px; cursor: pointer; color: var(--text); }
.drawer-backdrop { display: none; }
.tnav-scroll { flex: 1; min-width: 0; display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.tnav-scroll::-webkit-scrollbar { height: 6px; }
.topnav-user { flex: none; display: flex; align-items: center; gap: 8px; }
.uname { font-size: 12px; color: var(--text-soft); white-space: nowrap; }
.tnav { flex: none; white-space: nowrap; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 6px 13px; font-size: 13px; cursor: pointer; color: var(--text-soft); display: inline-flex; align-items: center; gap: 5px; transition: all 0.15s; }
.tnav:hover { border-color: var(--accent); color: var(--accent-600); }
.tnav.active { background: #e5484d; color: #fff; border-color: #e5484d; }
.ticon { font-size: 14px; }
.panelbox { flex: 1; overflow-y: auto; margin: 14px; padding: 16px 20px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow); min-height: 0; }
.chat { flex: 1; display: flex; flex-direction: column; padding: 16px 20px; margin: 14px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow); min-width: 0; min-height: 0; }
/* 对话区：默认单栏；当前策略时右侧加规则操作面板 */
/* 聊天区：左对话主体 + 右操作框 */
.chat-row { flex: 1; display: flex; min-height: 0; gap: 16px; }
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ops-side { width: 286px; flex: none; overflow-y: auto; border-left: 1px solid var(--border); padding-left: 14px; display: flex; flex-direction: column; gap: 8px; }
.ops-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted); padding-bottom: 2px; }
.ops-btn { width: 100%; text-align: left; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; cursor: pointer; color: var(--text); transition: all 0.15s; }
.ops-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-600); }
.ops-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.ops-btn.dashed { border-style: dashed; background: #f0f7f2; }
.ops-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.cal-wrap { position: relative; margin-top: auto; }
.cal-pop { position: absolute; bottom: 100%; right: 0; left: 0; margin-bottom: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-md); padding: 10px; z-index: 50; }
.cal-nav { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.cal-head span { text-align: center; font-size: 11px; color: var(--muted); padding: 2px 0; }
.cal-cell { position: relative; text-align: center; font-size: 12px; padding: 5px 0; border-radius: 6px; cursor: default; }
.cal-cell.blank { visibility: hidden; }
.cal-cell.closed { background: #f0f0f0; color: #aaa; }
.cal-cell.today { outline: 2px solid var(--accent); font-weight: 700; }
.cal-x { position: absolute; top: 0; right: 2px; font-size: 8px; color: #c98; font-style: normal; }
.cal-foot { margin-top: 6px; font-size: 11px; }
.ops-side .tplswitch, .ops-side .propose-bar, .ops-side .proposal { margin: 0; }
.ops-fab { position: fixed; right: 22px; bottom: 104px; z-index: 50; background: #e5484d; color: #fff; border: none; border-radius: 22px; padding: 10px 16px; box-shadow: var(--shadow-md); cursor: pointer; font-size: 13px; font-weight: 600; }
.ops-fab:hover { background: #d23b40; }

/* ============ 移动端适配（<=768px）============ */
@media (max-width: 768px) {
  .hamburger { display: inline-flex; align-items: center; }
  /* 左栏变为抽屉 */
  .rail { position: fixed; z-index: 60; top: 0; bottom: 0; left: 0; width: 80%; max-width: 300px; transform: translateX(-100%); transition: transform 0.22s ease; }
  .rail.open { transform: translateX(0); box-shadow: 4px 0 22px rgba(0, 0, 0, 0.35); }
  .drawer-backdrop { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); z-index: 55; }
  /* 内容区占满 */
  .main { width: 100%; }
  .chat, .panelbox { margin: 8px; padding: 12px 12px; border-radius: 12px; }
  .topnav { padding: 10px 10px 0; }
  .topnav-user .uname { display: none; }
  /* 右操作框变为右侧抽屉 */
  .chat-row { flex-direction: column; }
  .ops-side { position: fixed; z-index: 60; top: 0; right: 0; bottom: 0; width: 86%; max-width: 340px; background: var(--surface); border-left: 1px solid var(--border); padding: 14px; box-shadow: -4px 0 22px rgba(0, 0, 0, 0.3); }
  .cp-side, .convo { width: auto; }
  .bubble { max-width: 88%; }
  .ops-fab { bottom: 84px; right: 14px; }
}
.empty { margin: auto; text-align: center; color: var(--text-soft); max-width: 460px; }
.empty h2 { font-size: 22px; margin-bottom: 8px; }
.qbox { margin-top: 18px; text-align: left; }
.title { font-weight: 600; font-size: 15px; padding-bottom: 10px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.stock-head { display: flex; gap: 8px; }
.analyzing { color: #a76b00; font-size: 13px; padding: 8px 0; }
.briefing-time { font-size: 11px; margin: 2px 0 0; flex: 0 0 auto; }
.briefing { background: #f7faff; border: 1px solid #d6e4ff; border-radius: 8px; padding: 10px 12px; margin: 8px 0; white-space: pre-wrap; font-size: 13px; line-height: 1.6; flex: 0 0 auto; max-height: 40vh; overflow-y: auto; }
.gen-banner { background: #fffbe6; border: 1px solid #ffe58f; border-radius: 8px; padding: 8px 12px; margin: 8px 0; font-size: 13px; line-height: 1.6; flex: 0 0 auto; }
.gen-banner.err { background: #fff1f0; border-color: #ffccc7; color: #cf1322; }
.sess-spin { margin-left: 4px; }
.pin-card.gen { background: #eef7ee; cursor: pointer; border: 1px dashed #b7d7b7; text-align: left; }
.fold { text-align: left; background: none; border: none; color: #666; font-size: 12px; cursor: pointer; padding: 2px 4px; }
.srow { padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow:hover { background: #f3f3f3; }
.badge2 { display: inline-block; width: 16px; text-align: center; border-radius: 4px; font-size: 11px; margin-right: 4px; }
.badge2.a { background: #d8e6ff; color: #34699a; }
.badge2.b { background: #fde2e2; color: #c0392b; }
.badge2.no { background: #eee; color: #aaa; }
.msgs { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 0; display: flex; flex-direction: column; gap: 10px; }
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
.proposal-card h4 { margin: 0 0 6px; font-size: 14px; }
.proposal-card p { margin: 2px 0; font-size: 13px; }
.proposal-card .ops { margin-top: 8px; display: flex; gap: 8px; }
.composer { display: flex; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }
.composer textarea { flex: 1; padding: 9px 11px; resize: none; border-radius: var(--radius-sm); }
.composer button { background: var(--accent); color: #fff; border: none; border-radius: var(--radius-sm); padding: 0 20px; font-weight: 600; font-size: 14px; transition: background 0.15s; }
.composer button:hover:not(:disabled) { background: var(--accent-600); }
.composer button:disabled { opacity: 0.5; cursor: not-allowed; }
.err { color: var(--danger); }
.adopted-news-box { background: #f3faf3; border: 1px solid #cce8cc; border-radius: 8px; padding: 8px 12px; margin: 6px 0; flex: 0 0 auto; max-height: 30vh; overflow-y: auto; }
.an-head { font-size: 12px; font-weight: 600; color: #2a8a2a; margin-bottom: 4px; }
.an-list { list-style: none; padding: 0; margin: 0; }
.an-list li { padding: 3px 0; font-size: 13px; }
.an-list a { color: #34699a; text-decoration: none; }
.an-list a:hover { text-decoration: underline; }
.an-content { margin-top: 8px; border-top: 1px dashed #b7d7b7; padding-top: 8px; }
.an-content-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 13px; margin-bottom: 4px; }
.an-content p { font-size: 12px; line-height: 1.65; white-space: pre-wrap; margin: 0; color: #444; }
.screen-box { background: #f7faff; border: 1px solid #d6e4ff; border-radius: 8px; padding: 8px 12px; margin: 6px 0; flex: 0 0 auto; max-height: 40vh; overflow-y: auto; }
.screen-results { margin-top: 6px; }
.screen-hist { margin: 6px 0; border-top: 1px dashed #d6e4ff; padding-top: 6px; max-height: 260px; overflow-y: auto; }
.sh-row { margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #eef2fa; }
.sh-row:last-child { border-bottom: none; margin-bottom: 0; }
.sh-pick { padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.sh-pick:hover { background: #e8f0fe; }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: -1px; margin-right: 4px; }
@keyframes spin { to { transform: rotate(360deg); } }
.cp-cta { max-width: 460px; margin: 18px auto 22px; padding: 18px 20px; background: var(--accent-soft, #f3faf3); border: 1px solid var(--accent, #2a8a2a); border-radius: 12px; text-align: center; }
.cp-cta-title { font-size: 17px; font-weight: 700; color: var(--accent, #2a8a2a); margin-bottom: 6px; }
.cp-cta-desc { font-size: 13px; color: #666; margin: 0 0 14px; }
.cp-cta-btn { font-size: 15px; font-weight: 600; color: #fff; background: var(--accent, #2a8a2a); border: none; border-radius: 8px; padding: 11px 22px; cursor: pointer; }
.cp-cta-btn:hover { filter: brightness(1.05); }
.cp-cta-alt { margin-top: 10px; font-size: 12px; }
.cp-cta-alt a { color: #888; }
.synth-persona { margin: 4px 0; }
.synth-sys { margin: 6px 0; }
.synth-sys ul, .synth-soft ul { margin: 2px 0 2px 16px; padding: 0; }
.synth-sys li, .synth-soft li { font-size: 13px; }
.tpl-interview-entry { margin: 6px 0; font-size: 12px; }
.tpl-interview-entry a { color: var(--accent, #2a8a2a); }
.alert-bar { cursor: pointer; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #fff; }
.alert-bar.err { background: #d33; }
.alert-bar.warn { background: #d9a300; }
</style>
