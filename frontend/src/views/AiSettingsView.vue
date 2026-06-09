<template>
  <div class="ai">
    <header class="bar">
      <h1>AI 模型</h1>
      <router-link to="/">返回</router-link>
    </header>

    <nav class="subtabs">
      <button :class="{ active: tab === 'models' }" @click="tab = 'models'">模型配置</button>
      <button :class="{ active: tab === 'tasks' }" @click="tab = 'tasks'">任务分工</button>
    </nav>

    <p class="hint">
      去对应 AI 公司申请 API Key，回到这里配置并<b>启用多个模型</b>，再在「任务分工」里把不同任务交给不同模型
      （数据类用快/便宜的，分析类用强的），或让 agent 自动挑。Key 加密存储、只属于你。
    </p>

    <div v-show="tab === 'models'">
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

    <div v-show="tab === 'tasks'">
    <!-- 任务分工 -->
    <section class="card" v-if="configs.length">
      <div class="card-head">
        <h2>任务分工</h2>
        <button @click="autoAssign" :disabled="assigning">🤖 {{ assigning ? '主 agent 分配中…' : '让主 agent 分配' }}</button>
      </div>
      <p class="hint"><b>主 agent</b> 的模型由你指定（默认是初始化向导里配的那个，不参与「让主 agent 分配」）。「让主 agent 分配」只为<b>子 agent</b> 指派；子 agent 也可每行手动改（选「自动」=系统按任务自动挑）。</p>
      <table>
        <thead><tr><th>任务</th><th>分配（可手动改）</th><th>实际使用</th></tr></thead>
        <tbody>
          <tr v-for="r in roles" :key="r.role">
            <td>{{ r.label }}<div class="muted">{{ r.hint }}</div></td>
            <td>
              <select :value="roleValue(r)" @change="onRoleChange(r, $event)">
                <option v-if="r.role === 'core'" value="" disabled>选择主 agent 模型</option>
                <option v-else value="__auto__">自动（由 agent 挑）</option>
                <option v-for="o in modelOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
              </select>
              <span v-if="r.role === 'core'" class="coretag">主 agent · 仅你可定</span>
            </td>
            <td :class="r.resolvedProvider ? 'ok-msg' : 'err'">
              {{ r.resolvedProvider ? `${providerLabel(r.resolvedProvider)} · ${r.resolvedModel}` : '无可用模型' }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="roleMsg" :class="roleOk ? 'ok-msg' : 'err'">{{ roleMsg }}</p>
    </section>
    <section v-else class="card">
      <p class="hint">请先在「模型配置」里添加并启用至少一个模型，再来这里把任务分配给不同模型。</p>
    </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { aiApi, type ProviderDef, type AiConfig, type RoleAssignment, type SharedModel } from '../api/ai';
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

const tab = ref<'models' | 'tasks'>('models');
const assigning = ref(false);
async function autoAssign() {
  assigning.value = true;
  roleMsg.value = '';
  try {
    roles.value = (await aiApi.autoAssignRoles()).data.data;
    roleOk.value = true; roleMsg.value = '主 agent 已完成分配（可再手动微调）';
  } catch (e: any) {
    roleOk.value = false; roleMsg.value = e.response?.data?.message || '分配失败';
  } finally {
    assigning.value = false;
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
</style>
