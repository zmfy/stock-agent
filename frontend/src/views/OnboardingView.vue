<template>
  <div class="onb">
    <h1>初始化设定</h1>
    <div class="steps">
      <span :class="{ on: step >= 1 }">① 选当前策略</span>
      <span :class="{ on: step >= 2 }">② 配 AI + 主 agent</span>
      <span :class="{ on: step >= 3 }">③ 生成子 agent</span>
    </div>

    <!-- Step 1: template -->
    <section v-if="step === 1" class="card">
      <h2>选一个当前策略模板</h2>
      <p class="hint">不确定就先选「A/B 双系统」，之后可在「当前策略」里随时优化。</p>
      <div class="tpl interview" :class="{ sel: chosen === '__interview__' }" @click="chosen = '__interview__'">
        <b>🗣 我还没有当前策略，帮我聊出来</b>
        <div class="muted">先不选模板，进入后来财会通过聊天了解你平时怎么选股、怎么买卖，帮你总结出一套当前策略。</div>
      </div>
      <div class="tpl" v-for="t in templates" :key="t.key" :class="{ sel: chosen === t.key }" @click="chosen = t.key">
        <b>{{ t.label }}</b> <span class="muted">（{{ t.gateCount }} 条硬门槛）</span>
        <div class="muted">{{ t.description }}</div>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
      <button :disabled="!chosen || busy" @click="doTemplate">下一步</button>
    </section>

    <!-- Step 2: AI key + main persona -->
    <section v-if="step === 2" class="card">
      <h2>配置 AI 模型 + 主 agent 人设</h2>
      <p class="hint">去 AI 公司申请 Key 填这里（更多模型可稍后在「AI 模型」配置）。</p>
      <label>提供商
        <select v-model="prov.name" @change="onProv">
          <option v-for="p in providers" :key="p.name" :value="p.name">{{ p.label }}</option>
        </select>
      </label>
      <label v-if="provDef?.needsApiKey">API Key <input v-model="prov.apiKey" type="password" placeholder="粘贴你的 API Key" /></label>
      <label>模型
        <select v-model="prov.model">
          <option v-for="m in provDef?.models || []" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label>主 agent 人设
        <textarea v-model="mainPersona" rows="4"></textarea>
      </label>
      <p v-if="err" class="err">{{ err }}</p>
      <div class="ops">
        <button :disabled="busy" @click="doAi">下一步</button>
        <a href="#" @click.prevent="step = 3">跳过（稍后配）</a>
      </div>
    </section>

    <!-- Step 3: generate sub-agents -->
    <section v-if="step === 3" class="card">
      <h2>生成子 agent 人设</h2>
      <p class="hint">主 agent 会为「数据取得 / 数据分析 / 软料归纳 / 复盘」四个子助手起草人设，你可以改。</p>
      <button :disabled="busy" @click="doGenerate">{{ busy ? '生成中…' : '让主 agent 生成' }}</button>
      <div v-for="s in subs" :key="s.role" class="sub">
        <b>{{ s.role }}</b>
        <textarea v-model="s.persona" rows="2"></textarea>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
      <div class="ops">
        <button v-if="subs.length" @click="saveSubs" :disabled="busy">保存并完成</button>
        <a href="#" @click.prevent="finish">直接完成</a>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { rulebookApi, type TemplateMeta } from '../api/rulebook';
import { aiApi, type ProviderDef } from '../api/ai';
import { agentApi } from '../api/agent';

const router = useRouter();
const step = ref(1);
const busy = ref(false);
const err = ref('');

const templates = ref<TemplateMeta[]>([]);
const chosen = ref('');
const interview = ref(false);

const providers = ref<ProviderDef[]>([]);
const prov = reactive({ name: '', apiKey: '', model: '' });
const provDef = computed(() => providers.value.find((p) => p.name === prov.name));
const mainPersona = ref(
  '你是一位经验丰富的 A 股操盘手，严格执行用户设定的当前策略，只判断今天有没有资格、用哪套规则做，不预测涨跌、不情绪化。'
);

const subs = ref<Array<{ role: string; persona: string }>>([]);

function onProv() {
  if (provDef.value) {
    prov.model = provDef.value.models[0];
  }
}

async function doTemplate() {
  err.value = ''; busy.value = true;
  try {
    if (chosen.value === '__interview__') {
      interview.value = true;
      step.value = 2;
      return;
    }
    await rulebookApi.init(chosen.value);
    step.value = 2;
  } catch (e: any) {
    // already 有 rulebook -> just move on
    if (e.response?.status === 409) step.value = 2;
    else err.value = e.response?.data?.message || '导入失败';
  } finally {
    busy.value = false;
  }
}

async function doAi() {
  err.value = '';
  if (provDef.value?.needsApiKey && !prov.apiKey) { err.value = '请填写 API Key'; return; }
  busy.value = true;
  try {
    await aiApi.saveConfig(prov.name, { apiKey: prov.apiKey || undefined, baseUrl: provDef.value!.defaultBaseUrl, model: prov.model });
    await agentApi.setProfile('core', mainPersona.value);
    step.value = 3;
  } catch (e: any) {
    err.value = e.response?.data?.message || '保存失败';
  } finally {
    busy.value = false;
  }
}

async function doGenerate() {
  err.value = ''; busy.value = true;
  try {
    subs.value = (await agentApi.generateSubs()).data.data;
  } catch (e: any) {
    err.value = e.response?.data?.message || '生成失败（可直接完成，稍后再生成）';
  } finally {
    busy.value = false;
  }
}

async function saveSubs() {
  busy.value = true;
  try {
    for (const s of subs.value) await agentApi.setProfile(s.role, s.persona);
    finish();
  } finally {
    busy.value = false;
  }
}

function finish() {
  // kick off the background stock-universe sync so search is ready (fire-and-forget)
  import('../api/data').then((m) => m.dataApi.runJob('stock_universe').catch(() => {}));
  router.push(interview.value ? '/?interview=1' : '/');
}

onMounted(async () => {
  templates.value = (await rulebookApi.getTemplates()).data.data;
  chosen.value = templates.value[0]?.key || '';
  providers.value = (await aiApi.getProviders()).data.data;
  prov.name = providers.value[0]?.name || '';
  onProv();
});
</script>

<style scoped>
.onb { max-width: 600px; margin: 32px auto; padding: 0 16px; }
.steps { display: flex; gap: 12px; margin: 12px 0; font-size: 13px; color: #aaa; }
.steps .on { color: #2a8a2a; font-weight: 600; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; }
.hint { color: #888; font-size: 13px; }
.tpl { border: 1px solid #eee; border-radius: 6px; padding: 10px; margin: 8px 0; cursor: pointer; }
.tpl.sel { border-color: #2a8a2a; background: #f3faf3; }
.muted { color: #999; font-size: 12px; }
label { display: block; margin-top: 10px; font-size: 13px; }
input, select, textarea { width: 100%; box-sizing: border-box; padding: 6px; }
.sub { margin-top: 8px; }
.ops { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
.err { color: #c00; }
.tpl.interview { border-color: var(--accent, #2a8a2a); background: #f3faf3; }
.tpl.interview.sel { box-shadow: 0 0 0 2px rgba(42,138,42,0.25); }
</style>
