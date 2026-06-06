<template>
  <div class="ai">
    <header class="bar">
      <h1>AI 模型</h1>
      <router-link to="/">返回</router-link>
    </header>

    <p class="hint">
      去对应 AI 公司申请 API Key，回到这里配置并<b>启用多个模型</b>，再在「任务分工」里把不同任务交给不同模型
      （数据类用快/便宜的，分析类用强的），或让 agent 自动挑。Key 加密存储、只属于你。
    </p>

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

    <!-- 任务分工 -->
    <section class="card" v-if="configs.length">
      <h2>任务分工</h2>
      <p class="hint">每个任务可「自动（由 agent 在已启用模型里挑）」或手动指定一个模型。</p>
      <table>
        <thead><tr><th>任务</th><th>分配</th><th>实际使用</th></tr></thead>
        <tbody>
          <tr v-for="r in roles" :key="r.role">
            <td>{{ r.label }}<div class="muted">{{ r.hint }}</div></td>
            <td>
              <select :value="r.mode === 'manual' ? r.pinnedProvider : '__auto__'" @change="onRoleChange(r, $event)">
                <option value="__auto__">自动（由 agent 挑）</option>
                <option v-for="c in enabledConfigs" :key="c.provider" :value="c.provider">
                  {{ providerLabel(c.provider) }} · {{ c.model }}
                </option>
              </select>
            </td>
            <td :class="r.resolvedProvider ? 'ok-msg' : 'err'">
              {{ r.resolvedProvider ? `${providerLabel(r.resolvedProvider)} · ${r.resolvedModel}` : '无可用模型' }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="roleMsg" :class="roleOk ? 'ok-msg' : 'err'">{{ roleMsg }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { aiApi, type ProviderDef, type AiConfig, type RoleAssignment } from '../api/ai';

const providers = ref<ProviderDef[]>([]);
const configs = ref<AiConfig[]>([]);
const roles = ref<RoleAssignment[]>([]);
const busy = ref(false);
const msg = ref(''); const msgOk = ref(false);
const testMsg = ref(''); const testOk = ref(false);
const roleMsg = ref(''); const roleOk = ref(false);

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

async function onRoleChange(r: RoleAssignment, ev: Event) {
  const val = (ev.target as HTMLSelectElement).value;
  roleMsg.value = '';
  try {
    if (val === '__auto__') await aiApi.setRole(r.role, { mode: 'auto' });
    else await aiApi.setRole(r.role, { mode: 'manual', provider: val });
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
.ai { max-width: 760px; margin: 24px auto; padding: 0 16px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.hint { color: #777; font-size: 13px; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
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
