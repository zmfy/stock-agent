<template>
  <div class="ai">
    <p v-if="showModels" class="hint">
      去对应 AI 公司申请 API Key，回到这里配置并<b>启用多个模型</b>，再在「任务分工」里把不同任务交给不同模型
      （数据类用快/便宜的，分析类用强的），或让 agent 自动挑。Key 加密存储、只属于你。
    </p>

    <div v-if="showModels">
    <!-- 配置提供商 -->
    <section class="card">
      <h2>配置提供商</h2>
      <label>提供商
        <select v-model="form.provider" @change="onProviderChange">
          <option v-for="p in providers" :key="p.name" :value="p.name">{{ p.label }}</option>
        </select>
      </label>

      <template v-if="currentDef">
        <label v-if="currentDef.needsApiKey">API Key
          <input v-model="form.apiKey" type="password" :placeholder="savedFor(form.provider)?.apiKeySet ? '已设置（留空则不修改）' : '粘贴你申请的 API Key'" />
        </label>
        <label>Base URL
          <input v-model="form.baseUrl" :readonly="!currentDef.baseUrlEditable" />
        </label>
        <label>模型
          <select v-model="form.model">
            <option v-for="m in currentDef.models" :key="m" :value="m">{{ m }}</option>
            <option v-if="currentDef.allowCustomModel" value="__custom__">自定义…</option>
          </select>
        </label>
        <input v-if="form.model === '__custom__'" v-model="form.customModel" placeholder="输入自定义模型 id" />

        <div class="ops">
          <button @click="doTest" :disabled="busy">测试连通</button>
          <button @click="doSave" :disabled="busy">保存并启用</button>
        </div>
        <p v-if="testMsg" :class="testOk ? 'ok-msg' : 'err'">{{ testMsg }}</p>
        <p v-if="msg" :class="msgOk ? 'ok-msg' : 'err'">{{ msg }}</p>
      </template>
    </section>

    <!-- 已配置 + 启用开关 -->
    <section class="card" v-if="configs.length">
      <h2>已配置的模型</h2>
      <table>
        <thead><tr><th>启用</th><th>提供商</th><th>模型</th><th>Key</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in configs" :key="c.provider">
            <td><input type="checkbox" :checked="c.enabled === 1" @change="toggleEnabled(c)" /></td>
            <td>{{ providerLabel(c.provider) }}</td>
            <td>{{ c.model }}</td>
            <td class="muted">{{ c.apiKeySet ? c.apiKeyMasked : '（无需）' }}</td>
            <td class="ops">
              <button @click="edit(c)">编辑</button>
              <button class="danger" @click="remove(c.provider)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted">勾选「启用」的模型才会进入分工池。停用不删除配置。</p>
    </section>

    <!-- admin：共享给所有用户 + 配额 + 用量 -->
    <section class="card" v-if="isAdmin && configs.length">
      <h2>共享给所有用户</h2>
      <p class="muted">勾选后，所有用户都能用你这个模型（走你的 Key，他们看不到 Key）。可设每窗口 token 上限与重置周期，超限对所有人暂停到下个周期。</p>
      <div v-for="c in configs" :key="c.provider" class="share-row">
        <label><input type="checkbox" :checked="(c.shared || 0) === 1" @change="toggleShare(c, ($event.target as HTMLInputElement).checked)" /> {{ providerLabel(c.provider) }} · {{ c.model }}</label>
        <template v-if="(c.shared || 0) === 1 && shareForm[c.provider]">
          <span>上限 <input type="number" v-model.number="shareForm[c.provider].maxTokens" style="width:90px" /> tokens</span>
          <span>重置 <input type="number" v-model.number="shareForm[c.provider].periodValue" style="width:60px" />
            <select v-model="shareForm[c.provider].periodUnit">
              <option value="none">不重置</option><option value="hour">小时</option><option value="day">天</option><option value="week">周</option>
            </select>
          </span>
          <button @click="saveShareQuota(c)">保存配额</button>
          <button @click="openUsage(c)">查看使用情况</button>
        </template>
      </div>
      <div v-if="usageOpen" class="usage">
        <p>本窗口合计：<b>{{ usageTotal }}</b> tokens <button @click="resetUsage">清零用量</button></p>
        <table v-if="usageRows.length"><thead><tr><th>用户</th><th>调用</th><th>tokens</th></tr></thead>
          <tbody><tr v-for="r in usageRows" :key="r.username"><td>{{ r.username }}</td><td>{{ r.calls }}</td><td>{{ r.total_tokens }}</td></tr></tbody>
        </table>
        <p v-else class="muted">本窗口暂无用量。</p>
      </div>
    </section>

    <!-- 所有用户：管理员共享的模型 -->
    <section class="card" v-if="shared.length">
      <h2>管理员共享的模型</h2>
      <p class="muted">这些是管理员共享的模型，你可直接用（看不到也改不了 Key），也可与自己的模型一起用。</p>
      <table>
        <thead><tr><th>启用</th><th>模型</th><th>本周期额度</th></tr></thead>
        <tbody>
          <tr v-for="m in shared" :key="m.configId">
            <td><input type="checkbox" :checked="m.enabledForMe" @change="toggleSharedEnabled(m)" /></td>
            <td><span class="badge">共享</span> {{ providerLabel(m.provider) }} · {{ m.model }}</td>
            <td>
              <span v-if="m.quota.cap > 0" :class="{ err: m.quota.over }">
                {{ m.quota.used }} / {{ m.quota.cap }}（剩 {{ m.quota.remaining }}）
                <em v-if="m.quota.over"> · 本周期已用完，已暂停，下个周期恢复</em>
              </span>
              <span v-else class="muted">不限</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
    </div>

    <div v-if="showTasks">
    <!-- Agent 设定：主 agent 卡片置顶 + 一键设定 + 子 agent 卡片列 -->
    <section class="agent-setup">
      <h2>Agent 设定</h2>
      <p class="as-intro">先给主 agent「来财」选模型、设好人设；再一键为各子 agent 起草人设并分配模型，之后可手动微调。「自动」= 系统按任务挑。</p>
      <p v-if="!configs.length" class="as-warn">还没有可用模型——请先在「模型配置」里添加并启用至少一个模型。</p>

      <!-- 主 agent -->
      <div v-if="coreRow" class="agent-card core">
        <div class="ac-head">
          <div class="ac-avatar core">{{ ROLE_ICON.core }}</div>
          <div class="ac-meta">
            <div class="ac-name-row"><span class="ac-name">{{ coreRow.r.label }}</span><span class="ac-badge">主脑 · 仅你可定</span></div>
            <div class="ac-sub">{{ coreRow.r.hint }}</div>
          </div>
        </div>
        <template v-if="coreRow.profile">
          <label class="ac-label">人设</label>
          <textarea class="ac-textarea" v-model="coreRow.profile.persona" rows="3"></textarea>
        </template>
        <label class="ac-label">模型</label>
        <div class="ac-assign">
          <select v-if="configs.length" :value="roleValue(coreRow.r)" @change="onRoleChange(coreRow.r, $event)">
            <option value="" disabled>选择主 agent 模型</option>
            <option v-for="o in modelOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
          <span v-else class="ac-dash">—</span>
          <button v-if="coreRow.profile" class="ac-save" @click="saveProfile(coreRow.profile)">保存</button>
        </div>
        <div class="ac-actual">
          <span class="ac-ico" :class="coreRow.r.resolvedProvider ? 'ok' : 'no'">{{ coreRow.r.resolvedProvider ? '✓' : '!' }}</span>实际生效
          <span v-if="coreRow.r.resolvedProvider" class="ac-pill">{{ providerLabel(coreRow.r.resolvedProvider) }} · {{ coreRow.r.resolvedModel }}</span>
          <span v-else class="ac-none">未设定</span>
        </div>
      </div>

      <!-- 一键设定子 agent：先人设后分配；主 agent 模型未设时禁用 -->
      <div class="as-action">
        <div class="as-btnrow">
          <button class="as-mainbtn" :disabled="!coreModelSet || working" @click="setupSubs">🪄 {{ working ? '设定中…' : '一键设定子 agent（起草人设 + 分配模型）' }}</button>
          <button class="as-savebtn" :disabled="savingAll" @click="saveAll">💾 {{ savingAll ? '保存中…' : '保存全部人设' }}</button>
        </div>
        <span v-if="!coreModelSet" class="as-hint">先为主 agent 选定 AI 模型，才能设定子 agent。</span>
      </div>

      <div class="as-subhead">子助手</div>
      <div class="as-sublist">
        <div v-for="row in subRows" :key="row.r.role" class="agent-card" :class="{ disabled: !coreModelSet }">
          <div class="ac-head">
            <div class="ac-avatar">{{ ROLE_ICON[row.r.role] || '🤖' }}</div>
            <div class="ac-meta">
              <div class="ac-name">{{ row.r.label }}</div>
              <div class="ac-sub">{{ row.r.hint }}</div>
            </div>
          </div>
          <template v-if="row.profile">
            <label class="ac-label">人设</label>
            <textarea class="ac-textarea" v-model="row.profile.persona" rows="2" :disabled="!coreModelSet"></textarea>
          </template>
          <label class="ac-label">分配模型</label>
          <div class="ac-assign">
            <select v-if="configs.length" :value="roleValue(row.r)" @change="onRoleChange(row.r, $event)" :disabled="!coreModelSet">
              <option value="__auto__">自动（由 agent 挑）</option>
              <option v-for="o in modelOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
            </select>
            <span v-else class="ac-dash">—</span>
          </div>
          <div class="ac-actual">
            <span class="ac-ico" :class="row.r.resolvedProvider ? 'ok' : 'no'">{{ row.r.resolvedProvider ? '✓' : '!' }}</span>实际生效
            <span v-if="row.r.resolvedProvider" class="ac-pill">{{ providerLabel(row.r.resolvedProvider) }} · {{ row.r.resolvedModel }}</span>
            <span v-else class="ac-none">无可用模型</span>
          </div>
        </div>
      </div>
      <p v-if="profileMsg" :class="profileOk ? 'ok-msg' : 'err'">{{ profileMsg }}</p>
      <p v-if="roleMsg" :class="roleOk ? 'ok-msg' : 'err'">{{ roleMsg }}</p>
    </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { aiApi, type ProviderDef, type AiConfig, type RoleAssignment, type SharedModel } from '../api/ai';
import { agentApi, type AgentProfile } from '../api/agent';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);
const providers = ref<ProviderDef[]>([]);
const configs = ref<AiConfig[]>([]);
const roles = ref<RoleAssignment[]>([]);
const busy = ref(false);
const msg = ref(''); const msgOk = ref(false);
const testMsg = ref(''); const testOk = ref(false);
const roleMsg = ref(''); const roleOk = ref(false);

// 共享模型
const shared = ref<SharedModel[]>([]);
const shareForm = reactive<Record<string, { maxTokens: number; periodValue: number; periodUnit: 'none' | 'hour' | 'day' | 'week' }>>({});
const usageOpen = ref<string | null>(null);
const usageRows = ref<Array<{ username: string; calls: number; total_tokens: number }>>([]);
const usageTotal = ref(0);
function periodToSeconds(v: number, unit: string): number {
  if (unit === 'none' || !v) return 0;
  const mult: Record<string, number> = { hour: 3600, day: 86400, week: 604800 };
  return Math.floor(v * (mult[unit] || 0));
}
function secondsToForm(sec: number): { periodValue: number; periodUnit: 'none' | 'hour' | 'day' | 'week' } {
  if (!sec) return { periodValue: 0, periodUnit: 'none' };
  if (sec % 604800 === 0) return { periodValue: sec / 604800, periodUnit: 'week' };
  if (sec % 86400 === 0) return { periodValue: sec / 86400, periodUnit: 'day' };
  return { periodValue: Math.round(sec / 3600), periodUnit: 'hour' };
}

const form = reactive({ provider: '', apiKey: '', baseUrl: '', model: '', customModel: '' });

const currentDef = computed(() => providers.value.find((p) => p.name === form.provider));
const enabledConfigs = computed(() => configs.value.filter((c) => c.enabled === 1));
function providerLabel(name: string) {
  return providers.value.find((p) => p.name === name)?.label || name;
}
function savedFor(name: string) {
  return configs.value.find((c) => c.provider === name);
}
function resolvedModel() {
  return form.model === '__custom__' ? form.customModel.trim() : form.model;
}

function onProviderChange() {
  const def = currentDef.value;
  if (!def) return;
  const saved = savedFor(def.name);
  form.apiKey = '';
  form.baseUrl = saved?.base_url || def.defaultBaseUrl;
  form.customModel = '';
  if (saved && !def.models.includes(saved.model)) {
    form.model = '__custom__';
    form.customModel = saved.model;
  } else {
    form.model = saved?.model && def.models.includes(saved.model) ? saved.model : def.models[0];
  }
  msg.value = testMsg.value = '';
}

function edit(c: AiConfig) {
  form.provider = c.provider;
  onProviderChange();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function reload() {
  configs.value = (await aiApi.getConfigs()).data.data;
  roles.value = (await aiApi.getRoles()).data.data;
  shared.value = (await aiApi.getShared()).data.data;
  profiles.value = (await agentApi.getProfiles()).data.data;
  for (const c of configs.value) {
    if (!shareForm[c.provider]) {
      const p = secondsToForm(c.sharePeriodSeconds || 0);
      shareForm[c.provider] = { maxTokens: c.shareMaxTokens || 0, periodValue: p.periodValue, periodUnit: p.periodUnit };
    }
  }
}

async function toggleShare(c: AiConfig, on: boolean) {
  const f = shareForm[c.provider] || { maxTokens: 0, periodValue: 0, periodUnit: 'none' as const };
  await aiApi.setShared(c.provider, { shared: on, maxTokens: f.maxTokens, periodSeconds: periodToSeconds(f.periodValue, f.periodUnit) });
  await reload();
}
async function saveShareQuota(c: AiConfig) {
  const f = shareForm[c.provider];
  await aiApi.setShared(c.provider, { shared: true, maxTokens: f.maxTokens, periodSeconds: periodToSeconds(f.periodValue, f.periodUnit) });
  await reload();
}
async function openUsage(c: AiConfig) {
  const cfgId = shared.value.find((s) => s.provider === c.provider)?.configId;
  if (!cfgId) return;
  usageOpen.value = cfgId;
  await loadUsage(cfgId);
}
async function loadUsage(cfgId: string) {
  const d = (await aiApi.getSharedUsage(cfgId)).data.data;
  usageRows.value = d.rows; usageTotal.value = d.total;
}
async function resetUsage() {
  if (!usageOpen.value) return;
  await aiApi.resetSharedUsage(usageOpen.value);
  await loadUsage(usageOpen.value);
}
async function toggleSharedEnabled(m: SharedModel) {
  await aiApi.setSharedEnabled(m.configId, !m.enabledForMe);
  await reload();
}

async function doTest() {
  testMsg.value = '';
  busy.value = true;
  try {
    const res = await aiApi.test(form.provider, { apiKey: form.apiKey || undefined, baseUrl: form.baseUrl, model: resolvedModel() });
    testOk.value = res.data.data.ok;
    testMsg.value = res.data.data.ok ? `连通成功，模型回复：${res.data.data.reply}` : `连接失败：${res.data.data.error}`;
  } catch (e: any) {
    testOk.value = false;
    testMsg.value = e.response?.data?.message || '测试失败';
  } finally {
    busy.value = false;
  }
}

async function doSave() {
  msg.value = '';
  if (!resolvedModel()) { msgOk.value = false; msg.value = '请填写模型'; return; }
  busy.value = true;
  try {
    await aiApi.saveConfig(form.provider, { apiKey: form.apiKey || undefined, baseUrl: form.baseUrl, model: resolvedModel() });
    msgOk.value = true; msg.value = '已保存并启用';
    form.apiKey = '';
    await reload();
  } catch (e: any) {
    msgOk.value = false; msg.value = e.response?.data?.message || '保存失败';
  } finally {
    busy.value = false;
  }
}

async function toggleEnabled(c: AiConfig) {
  await aiApi.setEnabled(c.provider, c.enabled !== 1);
  await reload();
}

async function remove(provider: string) {
  if (!confirm(`删除 ${providerLabel(provider)} 的配置？`)) return;
  await aiApi.remove(provider);
  await reload();
}

// section 未传(admin 面板)→ 只显示模型配置(Agent 设定/任务分工 不在 admin 出现)；
// section='models'/'tasks'(房间 Modal)→ 只显示该段。Agent 设定仅经「任务分工」Modal进入。
const props = defineProps<{ section?: 'models' | 'tasks' }>();
const showModels = computed(() => !props.section || props.section === 'models');
const showTasks = computed(() => props.section === 'tasks');

// 各角色头像图标（与全站 emoji 风格一致，不引外部图标字体）。
const ROLE_ICON: Record<string, string> = {
  core: '🧠', data: '🗄️', analysis: '⚖️', qualitative: '📰', review: '🕘', validation: '🔎', ai_helper: '🤖',
};

// Agent 人设（主 + 各子 agent）：默认系统设定，可改后保存；可让来财起草子 agent。
const profiles = ref<AgentProfile[]>([]);
// 人设 + 任务分配合并展示：每个角色配对其 profile（profile 为 profiles 内同一引用，v-model 直接可改）。
const roleRows = computed(() => roles.value.map((r) => ({ r, profile: profiles.value.find((p) => p.role === r.role) })));
const coreRow = computed(() => roleRows.value.find((x) => x.r.role === 'core'));
const subRows = computed(() => roleRows.value.filter((x) => x.r.role !== 'core'));
// 主 agent 是否已有可用 AI 模型——未设定则禁用「一键设定子 agent」与所有子 agent 设定。
const coreModelSet = computed(() => !!coreRow.value?.r.resolvedProvider);
const profileMsg = ref(''); const profileOk = ref(false);
const working = ref(false);
const savingAll = ref(false);
// 保存全部人设：一次性把所有角色（主 + 各子 agent）的 persona 落库（子 agent 不再单独保存）。
async function saveAll() {
  savingAll.value = true; profileMsg.value = '';
  try {
    for (const p of profiles.value) await agentApi.setProfile(p.role, p.persona);
    profileOk.value = true; profileMsg.value = '已保存全部人设';
  } catch (e: any) {
    profileOk.value = false; profileMsg.value = e.response?.data?.message || '保存失败';
  } finally {
    savingAll.value = false;
  }
}
async function saveProfile(p: AgentProfile) {
  try {
    await agentApi.setProfile(p.role, p.persona);
    profileMsg.value = `已保存：${p.label}`; profileOk.value = true;
  } catch (e: any) {
    profileMsg.value = e.response?.data?.message || '保存失败'; profileOk.value = false;
  }
}
// 一键：先让来财起草子 agent 人设，再为子 agent 自动分配模型。主 agent 模型未设时不可用。
async function setupSubs() {
  if (!coreModelSet.value) return;
  working.value = true; profileMsg.value = ''; roleMsg.value = '';
  try {
    await agentApi.generateSubs();      // 1) 起草子 agent 人设
    await aiApi.autoAssignRoles();       // 2) 给子 agent 分配模型
    await reload();                      // 刷新人设 + 分配
    profileOk.value = true; profileMsg.value = '已为子 agent 起草人设并分配模型';
  } catch (e: any) {
    profileOk.value = false; profileMsg.value = e.response?.data?.message || '设定失败';
  } finally {
    working.value = false;
  }
}

// Every (enabled provider × each of its models) is a selectable option, so e.g.
// deepseek-chat and deepseek-reasoner are two distinct choices.
const modelOptions = computed(() => {
  const out: Array<{ key: string; provider: string; model: string; label: string }> = [];
  for (const c of enabledConfigs.value) {
    const def = providers.value.find((p) => p.name === c.provider);
    const models = Array.from(new Set([c.model, ...(def?.models || [])])).filter(Boolean);
    for (const m of models) out.push({ key: `${c.provider}|${m}`, provider: c.provider, model: m, label: `${providerLabel(c.provider)} · ${m}` });
  }
  for (const m of shared.value.filter((s) => s.enabledForMe)) {
    out.push({ key: `shared:${m.configId}`, provider: m.provider, model: m.model, label: m.label });
  }
  return out;
});
function roleValue(r: RoleAssignment) {
  if (r.mode !== 'manual') return '__auto__';
  if (r.pinnedSharedConfigId) return `shared:${r.pinnedSharedConfigId}`; // 共享(admin)模型的回显
  return `${r.pinnedProvider}|${r.pinnedModel || r.resolvedModel || ''}`;
}

async function onRoleChange(r: RoleAssignment, ev: Event) {
  const val = (ev.target as HTMLSelectElement).value;
  roleMsg.value = '';
  try {
    if (val === '__auto__') {
      await aiApi.setRole(r.role, { mode: 'auto' });
    } else if (val.startsWith('shared:')) {
      await aiApi.setRole(r.role, { mode: 'manual', sharedConfigId: val.slice(7) });
    } else {
      const [provider, model] = val.split('|');
      await aiApi.setRole(r.role, { mode: 'manual', provider, model });
    }
    roleOk.value = true; roleMsg.value = '分工已更新';
    await reload();
  } catch (e: any) {
    roleOk.value = false; roleMsg.value = e.response?.data?.message || '更新失败';
    await reload();
  }
}

onMounted(async () => {
  providers.value = (await aiApi.getProviders()).data.data;
  await reload();
  form.provider = providers.value[0]?.name || '';
  onProviderChange();
});
</script>

<style scoped>
.ai { max-width: 960px; margin: 0; padding: 0 16px; }
.badge { background: var(--accent, #e5484d); color: #fff; border-radius: 4px; padding: 0 6px; font-size: 12px; }
.share-row { padding: 6px 0; border-bottom: 1px solid #eee; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.usage { margin-top: 12px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.hint { color: #777; font-size: 13px; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.coretag { font-size: 11px; color: #a76b00; margin-left: 6px; }
label { display: block; margin-top: 10px; font-size: 13px; }
input, select { width: 100%; box-sizing: border-box; padding: 5px; }
td input[type="checkbox"] { width: auto; }
.ops { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 13px; vertical-align: top; }
.muted { color: #999; font-size: 12px; }
.err { color: #c00; }
.ok-msg { color: #2a8a2a; }
.danger { color: #c00; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
/* Agent 设定 */
.agent-setup h2 { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
.as-intro { font-size: 13px; color: var(--text-soft); margin: 0 0 16px; line-height: 1.7; }
.as-warn { font-size: 13px; color: var(--accent-ink); background: var(--accent-soft); border-radius: var(--radius-sm); padding: 8px 10px; margin: 0 0 14px; }

.agent-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.agent-card.core { border: 2px solid var(--info); }
.agent-card.disabled { opacity: 0.5; }

.ac-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.ac-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--surface-2); display: flex; align-items: center; justify-content: center; font-size: 18px; flex: none; }
.ac-avatar.core { width: 40px; height: 40px; background: var(--info-soft); font-size: 20px; }
.ac-meta { flex: 1; min-width: 0; }
.ac-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ac-name { font-size: 15px; font-weight: 600; }
.agent-card.core .ac-name { font-size: 16px; }
.ac-badge { font-size: 12px; background: var(--info-soft); color: var(--info); padding: 2px 8px; border-radius: var(--radius-sm); }
.ac-sub { font-size: 13px; color: var(--text-soft); margin-top: 2px; }

.ac-label { display: block; font-size: 13px; color: var(--text-soft); margin: 0 0 6px; }
.agent-setup .ac-textarea { width: 100%; resize: vertical; margin-bottom: 14px; }
.ac-assign { display: flex; align-items: center; gap: 10px; }
.agent-setup .ac-assign select { flex: 1; min-width: 0; }
.ac-save { flex: none; padding: 0 16px; }
.ac-dash { color: var(--muted); }

.ac-actual { font-size: 12px; color: var(--text-soft); margin-top: 10px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ac-ico { font-weight: 700; }
.ac-ico.ok { color: var(--ok); }
.ac-ico.no { color: var(--accent); }
.ac-pill { background: var(--surface-2); color: var(--text); padding: 2px 8px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
.ac-none { color: var(--muted); }

.as-action { margin: 16px 0; display: flex; flex-direction: column; gap: 6px; }
.as-btnrow { display: flex; gap: 10px; align-items: stretch; }
.as-mainbtn { flex: 1; padding: 12px; font-size: 14px; font-weight: 600; }
.as-savebtn { flex: none; padding: 0 18px; font-size: 14px; font-weight: 600; }
.as-hint { font-size: 12px; color: var(--muted); }
.as-subhead { font-size: 13px; color: var(--muted); margin-bottom: 10px; padding-left: 2px; }
.as-sublist { display: flex; flex-direction: column; gap: 12px; }
</style>
