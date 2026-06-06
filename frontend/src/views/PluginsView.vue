<template>
  <div class="plugins">
    <header class="bar">
      <h1>能力插件</h1>
      <router-link to="/">返回</router-link>
    </header>
    <p class="hint">
      为你的 agent 选择并配置能力：<b>MCP 工具</b>（浏览网页、取数据）和<b>技能 Skill</b>（探索、记忆等）。
      勾选启用、按需配置；也可添加自定义插件。实际连接/生效在后续计划接入，这里负责选择与配置。
    </p>

    <section class="card">
      <h2>MCP 工具</h2>
      <PluginCard v-for="p in mcps" :key="p.key" :p="p" @toggle="toggle" @save="saveConfig" @remove="remove" />
    </section>

    <section class="card">
      <h2>技能 Skill</h2>
      <PluginCard v-for="p in skills" :key="p.key" :p="p" @toggle="toggle" @save="saveConfig" @remove="remove" />
    </section>

    <section class="card">
      <h2>添加自定义插件</h2>
      <div class="form">
        <label>类型
          <select v-model="add.kind">
            <option value="mcp">MCP 工具</option>
            <option value="skill">技能 Skill</option>
          </select>
        </label>
        <label>key（唯一标识，字母数字-_）<input v-model="add.key" placeholder="如 tushare" /></label>
        <label>名称 <input v-model="add.label" placeholder="如 Tushare Pro 数据源" /></label>
        <label v-if="add.kind === 'mcp'">连接方式
          <select v-model="add.transport">
            <option value="stdio">stdio（本地命令）</option>
            <option value="http">http（远程 SSE/HTTP）</option>
          </select>
        </label>
        <label>配置（JSON）</label>
        <textarea v-model="add.configText" rows="4" :placeholder="add.kind === 'mcp' && add.transport === 'http' ? '{ &quot;url&quot;: &quot;http://...&quot; }' : '{ &quot;command&quot;: &quot;npx&quot;, &quot;args&quot;: [] }'"></textarea>
        <div class="ops"><button @click="addCustom" :disabled="busy">添加</button></div>
        <p v-if="addMsg" :class="addOk ? 'ok-msg' : 'err'">{{ addMsg }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, defineComponent, h } from 'vue';
import { pluginsApi, type PluginView } from '../api/plugins';

const PluginCard = defineComponent({
  props: { p: { type: Object as () => PluginView, required: true } },
  emits: ['toggle', 'save', 'remove'],
  setup(props, { emit }) {
    const open = ref(false);
    const text = ref(JSON.stringify(props.p.config, null, 2));
    const err = ref('');
    function save() {
      try {
        const cfg = JSON.parse(text.value);
        err.value = '';
        emit('save', props.p.key, cfg);
      } catch {
        err.value = 'JSON 格式有误';
      }
    }
    return () =>
      h('div', { class: 'pcard' }, [
        h('div', { class: 'phead' }, [
          h('label', { class: 'pname' }, [
            h('input', {
              type: 'checkbox',
              checked: props.p.enabled,
              onChange: (e: any) => emit('toggle', props.p, e.target.checked),
            }),
            ` ${props.p.label}`,
            props.p.recommended ? h('span', { class: 'tag rec' }, '推荐') : null,
            props.p.source === 'custom' ? h('span', { class: 'tag cust' }, '自定义') : null,
            props.p.transport ? h('span', { class: 'tag' }, props.p.transport) : null,
          ]),
          h('div', { class: 'pops' }, [
            h('button', { onClick: () => (open.value = !open.value) }, open.value ? '收起' : '配置'),
            props.p.source === 'custom' ? h('button', { class: 'danger', onClick: () => emit('remove', props.p) }, '删除') : null,
          ]),
        ]),
        h('div', { class: 'pdesc' }, props.p.description),
        open.value
          ? h('div', { class: 'pcfg' }, [
              h('textarea', { rows: 4, value: text.value, onInput: (e: any) => (text.value = e.target.value) }),
              err.value ? h('p', { class: 'err' }, err.value) : null,
              h('button', { onClick: save }, '保存配置'),
            ])
          : null,
      ]);
  },
});

const list = ref<PluginView[]>([]);
const busy = ref(false);
const addMsg = ref(''); const addOk = ref(false);
const add = reactive({ kind: 'mcp' as 'mcp' | 'skill', key: '', label: '', transport: 'http' as 'stdio' | 'http', configText: '{}' });

const mcps = computed(() => list.value.filter((p) => p.kind === 'mcp'));
const skills = computed(() => list.value.filter((p) => p.kind === 'skill'));

async function reload() {
  list.value = (await pluginsApi.list()).data.data;
}
async function toggle(p: PluginView, enabled: boolean) {
  await pluginsApi.setEnabled(p.key, enabled);
  await reload();
}
async function saveConfig(key: string, config: Record<string, any>) {
  await pluginsApi.updateConfig(key, config);
  await reload();
}
async function remove(p: PluginView) {
  if (!confirm(`移除 ${p.label}？`)) return;
  await pluginsApi.remove(p.key);
  await reload();
}
async function addCustom() {
  addMsg.value = '';
  let config: Record<string, any>;
  try {
    config = JSON.parse(add.configText);
  } catch {
    addOk.value = false; addMsg.value = '配置 JSON 格式有误'; return;
  }
  busy.value = true;
  try {
    await pluginsApi.addCustom({
      key: add.key.trim(),
      label: add.label.trim(),
      kind: add.kind,
      transport: add.kind === 'mcp' ? add.transport : null,
      config,
    });
    addOk.value = true; addMsg.value = '已添加';
    add.key = ''; add.label = ''; add.configText = '{}';
    await reload();
  } catch (e: any) {
    addOk.value = false; addMsg.value = e.response?.data?.message || '添加失败';
  } finally {
    busy.value = false;
  }
}

onMounted(reload);
</script>

<style scoped>
.plugins { max-width: 760px; margin: 24px auto; padding: 0 16px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.hint { color: #777; font-size: 13px; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
:deep(.pcard) { border-top: 1px solid #eee; padding: 10px 0; }
:deep(.phead) { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
:deep(.pname) { font-weight: 600; font-size: 14px; }
:deep(.pdesc) { color: #777; font-size: 12px; margin: 4px 0; }
:deep(.pops) { display: flex; gap: 6px; }
:deep(.pcfg) { margin-top: 6px; }
:deep(.pcfg textarea) { width: 100%; box-sizing: border-box; font-family: monospace; font-size: 12px; }
:deep(.tag) { font-size: 11px; background: #eef; color: #446; border-radius: 8px; padding: 1px 6px; margin-left: 6px; }
:deep(.tag.rec) { background: #fff3d6; color: #a76b00; }
:deep(.tag.cust) { background: #e9f7e9; color: #2a8a2a; }
.form { display: flex; flex-direction: column; gap: 6px; }
.form label { font-size: 13px; }
input, select, textarea { width: 100%; box-sizing: border-box; padding: 5px; }
.ops { margin-top: 8px; }
.err { color: #c00; }
.ok-msg { color: #2a8a2a; }
.danger { color: #c00; }
button:disabled { opacity: 0.5; }
</style>
