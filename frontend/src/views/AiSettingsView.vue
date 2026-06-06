<template>
  <div class="ai">
    <header class="bar">
      <h1>AI 模型</h1>
      <router-link to="/">返回</router-link>
    </header>

    <p class="hint">
      去对应 AI 公司申请 API Key（如 DeepSeek、通义千问、OpenAI 等），回到这里选提供商、填 Key、选模型，
      测试连通后保存并设为「当前使用」。Key 加密存储、只属于你。
    </p>

    <section v-if="active" class="active-banner">
      当前使用：<b>{{ providerLabel(active.provider) }}</b> · {{ active.model }}
    </section>
    <section v-else class="active-banner warn">尚未设定当前使用的 AI 模型。</section>

    <!-- 配置表单 -->
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
          <button @click="doSave" :disabled="busy">保存</button>
          <button @click="doSaveActivate" :disabled="busy">保存并设为当前使用</button>
        </div>
        <p v-if="testMsg" :class="testOk ? 'ok-msg' : 'err'">{{ testMsg }}</p>
        <p v-if="msg" :class="msgOk ? 'ok-msg' : 'err'">{{ msg }}</p>
      </template>
    </section>

    <!-- 已配置列表 -->
    <section class="card" v-if="configs.length">
      <h2>已配置</h2>
      <table>
        <thead><tr><th>提供商</th><th>模型</th><th>Key</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="c in configs" :key="c.provider">
            <td>{{ providerLabel(c.provider) }}</td>
            <td>{{ c.model }}</td>
            <td class="muted">{{ c.apiKeySet ? c.apiKeyMasked : '（无需）' }}</td>
            <td><span v-if="c.is_active" class="badge">当前</span></td>
            <td class="ops">
              <button v-if="!c.is_active" @click="activate(c.provider)">设为当前</button>
              <button @click="edit(c)">编辑</button>
              <button class="danger" @click="remove(c.provider)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { aiApi, type ProviderDef, type AiConfig } from '../api/ai';

const providers = ref<ProviderDef[]>([]);
const configs = ref<AiConfig[]>([]);
const active = ref<{ provider: string; model: string } | null>(null);
const busy = ref(false);
const msg = ref('');
const msgOk = ref(false);
const testMsg = ref('');
const testOk = ref(false);

const form = reactive({ provider: '', apiKey: '', baseUrl: '', model: '', customModel: '' });

const currentDef = computed(() => providers.value.find((p) => p.name === form.provider));
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
  form.model = saved?.model && def.models.includes(saved.model) ? saved.model : def.models[0];
  form.customModel = saved && !def.models.includes(saved.model) ? saved.model : '';
  if (saved && !def.models.includes(saved.model)) form.model = '__custom__';
  msg.value = testMsg.value = '';
}

function edit(c: AiConfig) {
  form.provider = c.provider;
  onProviderChange();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function reload() {
  configs.value = (await aiApi.getConfigs()).data.data;
  active.value = (await aiApi.getActive()).data.data;
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

async function doSave(): Promise<boolean> {
  msg.value = '';
  if (!resolvedModel()) {
    msgOk.value = false;
    msg.value = '请填写模型';
    return false;
  }
  busy.value = true;
  try {
    await aiApi.saveConfig(form.provider, { apiKey: form.apiKey || undefined, baseUrl: form.baseUrl, model: resolvedModel() });
    msgOk.value = true;
    msg.value = '已保存';
    form.apiKey = '';
    await reload();
    return true;
  } catch (e: any) {
    msgOk.value = false;
    msg.value = e.response?.data?.message || '保存失败';
    return false;
  } finally {
    busy.value = false;
  }
}

async function doSaveActivate() {
  if (await doSave()) await activate(form.provider);
}

async function activate(provider: string) {
  msg.value = '';
  try {
    await aiApi.activate(provider);
    msgOk.value = true;
    msg.value = '已设为当前使用';
    await reload();
  } catch (e: any) {
    msgOk.value = false;
    msg.value = e.response?.data?.message || '操作失败';
  }
}

async function remove(provider: string) {
  if (!confirm(`删除 ${providerLabel(provider)} 的配置？`)) return;
  await aiApi.remove(provider);
  await reload();
}

onMounted(async () => {
  providers.value = (await aiApi.getProviders()).data.data;
  await reload();
  form.provider = active.value?.provider || providers.value[0]?.name || '';
  onProviderChange();
});
</script>

<style scoped>
.ai { max-width: 720px; margin: 24px auto; padding: 0 16px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.hint { color: #777; font-size: 13px; }
.active-banner { background: #f3faf3; border: 1px solid #cce8cc; padding: 8px 12px; border-radius: 6px; }
.active-banner.warn { background: #fff7e6; border-color: #ffe0a3; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
label { display: block; margin-top: 10px; font-size: 13px; }
input, select { width: 100%; box-sizing: border-box; padding: 5px; }
.ops { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.badge { background: #2a8a2a; color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.muted { color: #999; }
.err { color: #c00; }
.ok-msg { color: #2a8a2a; }
.danger { color: #c00; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
