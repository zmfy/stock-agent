<template>
  <div class="rulebook">
    <!-- 尚未导入 -->
    <section v-if="!loading && !active" class="card empty">
      <p>你还没有当前策略。导入 V3.0 双系统基线作为起点，之后可以不断优化、形成版本。</p>
      <button @click="doInit" :disabled="busy">导入 V3.0 基线</button>
      <p v-if="error" class="err">{{ error }}</p>
    </section>

    <template v-if="active">
      <!-- 当前版本概览 -->
      <section class="card">
        <div class="card-head">
          <h2>当前使用：{{ shown.version.version_label }}
            <span class="badge">当前</span>
            <span class="muted">{{ shown.version.author === 'agent' ? 'agent 提议' : '手动' }} · {{ fmtCN(shown.version.created_at) }}</span>
          </h2>
          <div>
            <button class="edit-new-btn" @click="startEdit" :disabled="editing" title="编辑并另存为新版本">✏️ 编辑新版</button>
          </div>
        </div>
        <p class="persona">{{ shown.version.persona }}</p>
        <p v-if="shown.version.note" class="muted">说明：{{ shown.version.note }}</p>

        <template v-for="sys in systemsOf" :key="sys">
          <div class="sys-head">
            <span class="sys-badge">{{ sys }}</span>
            <span class="sys-name">{{ sys }} 系统</span>
            <span v-if="!gatesOf(sys).length" class="sys-tag muted">零仓位 / 复盘</span>
          </div>
          <template v-if="gatesOf(sys).length">
            <div class="sub-label">🛡 硬门槛</div>
            <div class="gate-card">
              <div v-for="g in gatesOf(sys)" :key="g.id" class="gate-row">
                <div class="gate-main">
                  <div class="gate-top">
                    <span class="gate-label">{{ g.label }}</span>
                    <span class="cond-pill">{{ condText(g) }}</span>
                  </div>
                  <div v-if="g.teach" class="gate-teach">{{ g.teach }}</div>
                </div>
                <span class="veto-pill" :class="g.veto ? 'is-veto' : 'is-quality'">{{ g.veto ? '一票否决' : '质量项' }}</span>
              </div>
            </div>
          </template>
          <template v-if="softOf(sys).length">
            <div class="sub-label">⚙ 软判断 <span class="muted">· 需人工核对，不一票否决</span></div>
            <ul class="soft-list">
              <li v-for="r in softOf(sys)" :key="r.id"><span class="dot">·</span><span>{{ r.text }}<span v-if="r.teach" class="muted"> — {{ r.teach }}</span></span></li>
            </ul>
          </template>
        </template>

        <h3>仓位 / 出场 / 熔断</h3>
        <pre class="pr">{{ prettyPR(shown.positionRules) }}</pre>
      </section>

      <!-- 版本历史 -->
      <section class="card">
        <h2>版本历史</h2>
        <p class="vh-sub muted">共 {{ versions.length }} 个版本 · 可查看、与当前对比或采纳为当前</p>
        <div class="ver-list">
          <div v-for="v in versions" :key="v.id" class="ver-card" :class="{ 'is-active': v.is_active === 1 }">
            <div class="ver-main">
              <div class="ver-top">
                <span class="ver-name">{{ v.version_label }}</span>
                <span v-if="v.is_active === 1" class="badge">当前</span>
              </div>
              <div class="ver-meta muted">
                <span>🤖 来源 {{ v.author === 'agent' ? 'agent' : '手动' }}</span>
                <span>🕐 {{ fmtCN(v.created_at) }}</span>
                <span v-if="v.note">· {{ v.note }}</span>
              </div>
            </div>
            <div class="ver-ops">
              <button @click="view(v.id)">查看</button>
              <button v-if="v.is_active !== 1" @click="showDiff(v.id)">对比当前</button>
              <button v-if="v.is_active !== 1" class="adopt-btn" @click="adopt(v.id)">采纳</button>
            </div>
          </div>
        </div>
        <p v-if="error" class="err">{{ error }}</p>
      </section>

      <!-- diff -->
      <section v-if="diff" class="card">
        <h2>与当前版对比</h2>
        <p v-if="diff.personaChanged">· 人设有改动</p>
        <p v-for="c in diff.gates.changed" :key="c.gate_key">· 门槛 <b>{{ c.gate_key }}</b>：阈值 {{ c.from.threshold }} → {{ c.to.threshold }}（{{ c.from.op }} → {{ c.to.op }}）</p>
        <p v-for="k in diff.gates.added" :key="'a'+k">· 新增门槛 {{ k }}</p>
        <p v-for="k in diff.gates.removed" :key="'r'+k">· 删除门槛 {{ k }}</p>
        <p v-if="diff.softRules.added.length">· 新增软判断 {{ diff.softRules.added.length }} 条</p>
        <p v-if="diff.softRules.removed.length">· 删除软判断 {{ diff.softRules.removed.length }} 条</p>
        <p v-if="diff.positionRulesChangedKeys.length">· 仓位规则改动：{{ diff.positionRulesChangedKeys.join('、') }}</p>
        <p v-if="noChange" class="muted">无差异</p>
        <button @click="diff = null">关闭</button>
      </section>

      <!-- 编辑 -> 另存为新版本 -->
      <section v-if="editing" class="card edit">
        <h2>另存为新版本</h2>
        <label>版本号 <input v-model="edit.versionLabel" placeholder="如 V3.1" /></label>
        <label>说明 <input v-model="edit.note" placeholder="本版改了什么 / 为什么" /></label>
        <label>人设</label>
        <textarea v-model="edit.persona" rows="3"></textarea>
        <h4>门槛阈值（仅可调数值）</h4>
        <table class="versions">
          <thead><tr><th>系统</th><th>门槛</th><th>运算</th><th>阈值</th><th>否决</th></tr></thead>
          <tbody>
            <tr v-for="(g, i) in edit.gates" :key="i">
              <td>{{ g.system }}</td><td>{{ g.label }}</td><td>{{ g.op }}</td>
              <td><input class="num" type="number" v-model.number="g.threshold" :disabled="g.op === 'gt_field'" /></td>
              <td>{{ g.veto ? '是' : '否' }}</td>
            </tr>
          </tbody>
        </table>
        <label>仓位规则（JSON）</label>
        <textarea v-model="edit.positionRulesText" rows="8"></textarea>
        <p v-if="edit.err" class="err">{{ edit.err }}</p>
        <div class="ops">
          <button :disabled="busy" @click="saveNewVersion">保存为新版本（未激活）</button>
          <button @click="editing = false">取消</button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { rulebookApi, type FullRulebook, type RulebookVersion, type RulebookDiff, type Gate } from '../api/rulebook';
import { fmtCN } from '../utils/time';

function condText(g: Gate): string {
  if (g.op === 'gt_field') return `${g.field} > ${g.ref_field}`;
  if (g.op === 'between') return `${g.threshold} < 值 < ${g.threshold2} ${g.unit}`;
  return `${g.op} ${g.threshold}${g.unit}`;
}

const loading = ref(true);
const busy = ref(false);
const error = ref('');
const active = ref<FullRulebook | null>(null);
const selected = ref<FullRulebook | null>(null);
const versions = ref<RulebookVersion[]>([]);
const diff = ref<RulebookDiff | null>(null);

const shown = computed(() => selected.value || active.value!);
const noChange = computed(
  () =>
    diff.value &&
    !diff.value.personaChanged &&
    !diff.value.gates.changed.length &&
    !diff.value.gates.added.length &&
    !diff.value.gates.removed.length &&
    !diff.value.softRules.added.length &&
    !diff.value.softRules.removed.length &&
    !diff.value.positionRulesChangedKeys.length
);

// 系统 = 门槛与软判断里出现过的所有系统并集（零仓位/复盘系统 如 C 可能只有软判断、没有硬门槛）。
const systemsOf = computed(() => [...new Set([...shown.value.gates.map((g) => g.system), ...shown.value.softRules.map((r) => r.system)])].sort());
function gatesOf(sys: string) {
  return shown.value.gates.filter((g) => g.system === sys);
}
function softOf(sys: string) {
  return shown.value.softRules.filter((r) => r.system === sys);
}
function prettyPR(pr: Record<string, any>) {
  return JSON.stringify(pr, null, 2);
}

async function load() {
  loading.value = true;
  try {
    const res = await rulebookApi.getActive();
    active.value = res.data.data;
    if (active.value) versions.value = (await rulebookApi.listVersions()).data.data;
  } finally {
    loading.value = false;
  }
}

async function doInit() {
  busy.value = true;
  error.value = '';
  try {
    await rulebookApi.init();
    selected.value = null;
    await load();
  } catch (e: any) {
    error.value = e.response?.data?.message || '导入失败';
  } finally {
    busy.value = false;
  }
}

async function view(id: string) {
  diff.value = null;
  const res = await rulebookApi.getVersion(id);
  selected.value = res.data.data;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function showDiff(id: string) {
  const res = await rulebookApi.diff(id);
  diff.value = res.data.data;
}

async function adopt(id: string) {
  error.value = '';
  try {
    await rulebookApi.activate(id);
    selected.value = null;
    diff.value = null;
    await load();
  } catch (e: any) {
    error.value = e.response?.data?.message || '采纳失败';
  }
}

// ---- edit -> new version ----
const editing = ref(false);
const edit = reactive({
  versionLabel: '',
  note: '',
  persona: '',
  gates: [] as Gate[],
  positionRulesText: '',
  err: '',
});
function startEdit() {
  const base = active.value!;
  editing.value = true;
  edit.versionLabel = '';
  edit.note = '';
  edit.persona = base.version.persona;
  edit.gates = base.gates.map((g) => ({ ...g }));
  edit.positionRulesText = JSON.stringify(base.positionRules, null, 2);
  edit.err = '';
}
async function saveNewVersion() {
  edit.err = '';
  if (!edit.versionLabel.trim()) {
    edit.err = '请填写版本号';
    return;
  }
  let positionRules: Record<string, any>;
  try {
    positionRules = JSON.parse(edit.positionRulesText);
  } catch {
    edit.err = '仓位规则 JSON 格式有误';
    return;
  }
  busy.value = true;
  try {
    await rulebookApi.createVersion({
      versionLabel: edit.versionLabel.trim(),
      persona: edit.persona,
      note: edit.note,
      parentVersionId: active.value!.version.id,
      gates: edit.gates.map((g) => ({
        system: g.system,
        gate_key: g.gate_key,
        label: g.label,
        field: g.field,
        op: g.op,
        threshold: g.threshold,
        threshold2: g.threshold2,
        ref_field: g.ref_field,
        unit: g.unit,
        veto: g.veto,
        teach: g.teach,
      })),
      softRules: active.value!.softRules.map((r) => ({ system: r.system, text: r.text, teach: r.teach })),
      positionRules,
    });
    editing.value = false;
    await load();
  } catch (e: any) {
    edit.err = e.response?.data?.message || '保存失败';
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.rulebook { max-width: 960px; margin: 0; padding: 0 16px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.empty { text-align: center; }
.persona { background: #f7f7f7; padding: 10px; border-radius: 6px; }
.badge { background: #2a8a2a; color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; }
.muted { color: #999; font-size: 12px; }
.err { color: #c00; }
.sys-head { display: flex; align-items: center; gap: 10px; margin: 18px 0 12px; }
.sys-badge { width: 24px; height: 24px; border-radius: var(--radius-sm, 7px); background: var(--info-soft, #e8f0fe); color: var(--info, #3b82f6); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; flex: none; }
.sys-name { font-size: 16px; font-weight: 600; }
.sub-label { font-size: 13px; color: var(--text-soft, #666); margin: 0 0 8px 2px; }
.gate-card { background: var(--surface-2, #f7f7f8); border-radius: var(--radius, 10px); padding: 2px 14px; margin-bottom: 18px; }
.gate-row { display: flex; align-items: flex-start; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--border, #eee); }
.gate-row:last-child { border-bottom: none; }
.gate-main { flex: 1; min-width: 0; }
.gate-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gate-label { font-size: 14px; font-weight: 600; }
.cond-pill { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); padding: 1px 7px; border-radius: 6px; }
.gate-teach { font-size: 13px; color: var(--text-soft, #666); margin-top: 4px; }
.veto-pill { flex: none; font-size: 11px; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
.veto-pill.is-veto { background: var(--danger-soft, #fdecec); color: var(--danger, #e5484d); }
.veto-pill.is-quality { background: var(--surface, #fff); color: var(--muted, #999); border: 1px solid var(--border, #e5e5e5); }
.soft-list { list-style: none; padding: 0 0 0 2px; margin: 0 0 20px; display: flex; flex-direction: column; gap: 10px; }
.soft-list li { display: flex; gap: 9px; font-size: 13px; line-height: 1.6; color: var(--text, #2a3342); }
.soft-list .dot { color: var(--muted, #999); flex: none; }
.pr { background: #f7f7f7; padding: 10px; border-radius: 6px; overflow: auto; font-size: 12px; }
:deep(table.gates), table.versions { width: 100%; border-collapse: collapse; margin: 6px 0 14px; }
:deep(table.gates th), :deep(table.gates td), table.versions th, table.versions td {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 13px; vertical-align: top;
}
.activeRow { background: #f3faf3; }
.edit-new-btn { white-space: nowrap; flex-shrink: 0; }
.card-head > div { flex-shrink: 0; }
.vh-sub { font-size: 13px; margin: 0 0 14px; }
.ver-list { display: flex; flex-direction: column; gap: 10px; }
.ver-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: var(--radius, 10px); padding: 14px 16px; }
.ver-card.is-active { border: 1.5px solid var(--ok, #1f9d57); }
.ver-main { min-width: 0; }
.ver-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ver-name { font-size: 15px; font-weight: 600; }
.ver-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 5px; font-size: 12px; }
.ver-ops { display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
.ver-ops button { font-size: 13px; padding: 0 12px; min-height: 32px; }
.ver-ops .adopt-btn { color: var(--info, #3b82f6); border-color: var(--info, #3b82f6); }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
.edit label { display: block; margin-top: 8px; font-size: 13px; }
.edit input, .edit textarea { width: 100%; box-sizing: border-box; }
.edit input.num { width: 90px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
