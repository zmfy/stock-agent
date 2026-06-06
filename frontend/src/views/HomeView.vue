<template>
  <div class="shell">
    <!-- 左栏 -->
    <aside class="rail">
      <div class="brand">股票小作手</div>

      <!-- 置顶：早会 -->
      <div class="pinned">
        <div class="pin-card soon">📈 今日操作方向（早会）<span class="soon-tag">即将开放</span>
          <div class="muted">每天 8:00 由 agent 整合大盘/板块给出今日思路</div>
        </div>

        <button class="pin-btn" :class="{ active: active?.kind === 'core_principle' }" @click="openCorePrinciple">📜 核心原则（对话）</button>

        <div class="pin-card soon">🔍 按核心原则选股 <span class="soon-tag">即将开放</span></div>

        <div class="freeq">
          <input v-model="queryCode" placeholder="自由查询：代码/名称" @keyup.enter="freeQuery" />
          <button @click="freeQuery">查</button>
        </div>

        <div class="pin-card soon">🌙 今日操作复盘（晚会）<span class="soon-tag">即将开放</span></div>
      </div>

      <!-- 会话列表 -->
      <div class="sect-head">对话 <button class="mini" @click="newGeneral">＋新对话</button></div>
      <ul class="sessions">
        <li v-for="s in sessions" :key="s.id" :class="{ active: active?.id === s.id }" @click="open(s)">
          <span class="kind">{{ kindIcon(s.kind) }}</span>
          {{ s.title || sessionLabel(s) }}
        </li>
      </ul>

      <div class="menu">
        <router-link to="/analysis">选股分析</router-link>
        <router-link to="/rulebook">核心规则</router-link>
        <router-link to="/ai">AI 模型</router-link>
        <router-link to="/plugins">能力插件</router-link>
        <router-link to="/data">数据</router-link>
        <router-link to="/settings">设置</router-link>
      </div>
      <div class="foot">
        <span class="muted">{{ auth.user?.username }}</span>
        <button class="mini" @click="logout">登出</button>
      </div>
    </aside>

    <!-- 右侧聊天区 -->
    <main class="chat">
      <div v-if="needsInit" class="initbar">
        还没设定核心原则？<router-link to="/onboarding">去完成初始化设定 →</router-link>
      </div>

      <div v-if="!active" class="empty">
        <h2>你好，我是你的操盘助手 🤝</h2>
        <p class="muted">点左侧「核心原则」与我探讨规则，或「自由查询」一只股票，或开一个新对话。</p>
      </div>

      <template v-else>
        <div class="title">{{ active.title || sessionLabel(active) }}</div>
        <div class="msgs" ref="msgsEl">
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div class="bubble">{{ m.content }}</div>
          </div>
          <div v-if="sending" class="msg assistant"><div class="bubble typing">思考中…</div></div>
        </div>
        <div class="composer">
          <textarea v-model="input" rows="2" placeholder="输入消息，Enter 发送" @keydown.enter.exact.prevent="send"></textarea>
          <button :disabled="sending || !input.trim()" @click="send">发送</button>
        </div>
        <p v-if="chatErr" class="err">{{ chatErr }}</p>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { chatApi, type ChatSession, type ChatMessage, type ChatKind } from '../api/chat';
import { rulebookApi } from '../api/rulebook';

const auth = useAuthStore();
const router = useRouter();

const sessions = ref<ChatSession[]>([]);
const active = ref<ChatSession | null>(null);
const messages = ref<ChatMessage[]>([]);
const input = ref('');
const sending = ref(false);
const chatErr = ref('');
const queryCode = ref('');
const needsInit = ref(false);
const msgsEl = ref<HTMLElement | null>(null);

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
  active.value = s;
  chatErr.value = '';
  messages.value = (await chatApi.getMessages(s.id)).data.data;
  scrollDown();
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
async function freeQuery() {
  const code = queryCode.value.trim();
  if (!code) return;
  const id = (await chatApi.createSession('stock', code, `个股 ${code}`)).data.data.id;
  queryCode.value = '';
  await loadSessions();
  const s = sessions.value.find((x) => x.id === id);
  if (s) await open(s);
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
  try {
    const rb = (await rulebookApi.getActive()).data.data;
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
.sessions li { padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sessions li.active { background: #eef; }
.kind { margin-right: 4px; }
.menu { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 4px; border-top: 1px solid #eee; font-size: 12px; }
.foot { display: flex; justify-content: space-between; align-items: center; padding-top: 6px; border-top: 1px solid #eee; }
.mini { font-size: 12px; background: none; border: 1px solid #ddd; border-radius: 6px; padding: 2px 6px; cursor: pointer; }
.muted { color: #999; font-size: 12px; }
.chat { flex: 1; display: flex; flex-direction: column; padding: 12px 16px; }
.initbar { background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 8px; }
.empty { margin: auto; text-align: center; color: #666; }
.title { font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid #eee; }
.msgs { flex: 1; overflow-y: auto; padding: 12px 0; display: flex; flex-direction: column; gap: 10px; }
.msg { display: flex; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 75%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; line-height: 1.5; font-size: 14px; }
.msg.user .bubble { background: #d8e6ff; }
.msg.assistant .bubble { background: #f2f2f2; }
.typing { color: #999; }
.composer { display: flex; gap: 8px; border-top: 1px solid #eee; padding-top: 8px; }
.composer textarea { flex: 1; padding: 8px; resize: none; }
.err { color: #c00; }
</style>
