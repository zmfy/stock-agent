<template>
  <div class="analysis">
    <header class="bar">
      <h1>选股分析</h1>
      <router-link to="/">返回</router-link>
    </header>

    <section class="card run">
      <StockPicker placeholder="代码 / 名称 / 拼音，选中即分析" @pick="onPick" />
      <button @click="run" :disabled="busy || !code">{{ busy ? '分析中…' : '分析' }}</button>
      <p v-if="err" class="err">{{ err }}</p>
      <p class="hint">分析会：代码算硬门槛 → AI 写软判断与结论 → 生成报告并存档（可在下方历史里回看）。</p>
    </section>

    <section v-if="report" class="card report">
      <div class="rhead">
        <h2>{{ report.stock_code }} {{ report.stock_name || '' }}</h2>
        <div class="meta">
          规则版本 {{ report.rulebook_version_id?.slice(0, 8) }} · 数据 {{ report.data_date }} ·
          模型 {{ report.ai_provider }}/{{ report.ai_model }} · {{ report.created_at }}
        </div>
      </div>

      <div class="prov">
        <span v-if="report.validation" :class="report.validation.trusted ? 'ok' : 'warn'">
          数据校验：{{ report.validation.trusted ? '✅ 通过' : '⚠️ 存疑' }}（{{ authorityCn(report.validation.authority) }}）
        </span>
        <span v-if="report.sources?.quote">· 行情 {{ report.sources.quote.source }}@{{ report.sources.quote.date }}</span>
        <span v-if="report.sources?.fundamentals">· 基本面 {{ report.sources.fundamentals.source }}@{{ report.sources.fundamentals.date }}</span>
        <span v-if="report.sources?.sidecarBase">· 源 {{ report.sources.sidecarBase }}</span>
      </div>

      <p class="oneliner">👉 {{ report.one_liner }}</p>

      <template v-for="sys in systemsOf" :key="sys">
        <h3>{{ sys }} 系统</h3>
        <GateTable :rows="gatesOf(sys)" />
        <p v-if="sys === 'A' && report.a_conclusion" class="concl"><b>A 结论：</b>{{ report.a_conclusion }}</p>
        <p v-if="sys === 'B' && report.b_conclusion" class="concl"><b>B 结论：</b>{{ report.b_conclusion }}</p>
      </template>

      <p v-if="report.exception_channel" class="concl"><b>例外通道：</b>{{ report.exception_channel }}</p>
      <p class="concl"><b>仓位建议：</b>{{ report.position_suggestion }}</p>

      <div v-if="report.teach_notes?.length" class="teach">
        <h4>📘 教学</h4>
        <ul><li v-for="(t, i) in report.teach_notes" :key="i"><b>{{ labelOf(t.gate_key) }}</b>：{{ t.note }}</li></ul>
      </div>
    </section>

    <section class="card" v-if="reports.length">
      <h2>历史报告</h2>
      <table>
        <thead><tr><th>代码</th><th>一句话结论</th><th>模型</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="r in reports" :key="r.id" @click="view(r.id)" class="rrow">
            <td>{{ r.stock_code }} {{ r.stock_name || '' }}</td>
            <td>{{ r.one_liner }}</td>
            <td class="muted">{{ r.ai_model }}</td>
            <td class="muted">{{ r.created_at }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, defineComponent, h } from 'vue';
import { analysisApi, type AnalysisReport, type ReportSummary, type GateResult } from '../api/analysis';
import StockPicker from '../components/StockPicker.vue';

const ICON: Record<string, string> = { pass: '✅', fail: '❌', unknown: '⚠️' };

const GateTable = defineComponent({
  props: { rows: { type: Array as () => GateResult[], required: true } },
  setup(props) {
    const cond = (r: GateResult) =>
      r.op === 'gt_field' ? `${r.field}>${r.ref_field}` : r.op === 'between' ? `${r.threshold}~${r.threshold2}` : `${r.op}${r.threshold}`;
    return () =>
      h('table', { class: 'gates' }, [
        h('thead', [h('tr', [h('th', '门槛'), h('th', '要求'), h('th', '实测'), h('th', '结果'), h('th', '类型')])]),
        h('tbody', props.rows.map((r) =>
          h('tr', { key: r.gate_key, title: r.teach }, [
            h('td', r.label),
            h('td', `${cond(r)}${r.unit}`),
            h('td', r.actual === null ? '—' : String(r.actual)),
            h('td', ICON[r.status] || '?'),
            h('td', { class: 'muted' }, r.veto ? '否决' : '质量'),
          ])
        )),
      ]);
  },
});

const code = ref('');
const busy = ref(false);
const err = ref('');
const report = ref<AnalysisReport | null>(null);
const reports = ref<ReportSummary[]>([]);

const systemsOf = computed(() => [...new Set((report.value?.gate_results || []).map((g) => g.system))].sort());
function gatesOf(sys: string) {
  return report.value?.gate_results.filter((g) => g.system === sys) || [];
}
function labelOf(key: string) {
  return report.value?.gate_results.find((g) => g.gate_key === key)?.label || key;
}
function authorityCn(a: string) {
  return { uploaded: '以上传数据为准', cross: '交叉验证', internal: '合理性检查', none: '无来源' }[a] || a;
}

function onPick(c: string) {
  code.value = c;
  run();
}
async function run() {
  if (!code.value.trim()) return;
  err.value = ''; busy.value = true;
  try {
    report.value = (await analysisApi.run(code.value.trim())).data.data;
    await loadList();
  } catch (e: any) {
    err.value = e.response?.data?.message || '分析失败';
  } finally {
    busy.value = false;
  }
}
async function view(id: string) {
  report.value = (await analysisApi.getReport(id)).data.data;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function loadList() {
  reports.value = (await analysisApi.listReports()).data.data;
}
onMounted(loadList);
</script>

<style scoped>
.analysis { max-width: 820px; margin: 24px auto; padding: 0 16px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
.run { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.run input { padding: 6px; }
.hint { color: #888; font-size: 12px; width: 100%; margin: 0; }
.rhead h2 { margin: 0; }
.meta { color: #999; font-size: 12px; }
.prov { font-size: 12px; color: #888; margin: 6px 0; }
.prov .ok { color: #2a8a2a; }
.prov .warn { color: #c08; }
.oneliner { background: #f3faf3; border: 1px solid #cce8cc; padding: 8px 12px; border-radius: 6px; font-weight: 600; }
.concl { margin: 6px 0; }
:deep(table.gates), table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
:deep(table.gates th), :deep(table.gates td), th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.teach { background: #fafafa; border-radius: 6px; padding: 8px 12px; }
.muted { color: #999; }
.err { color: #c00; }
.rrow { cursor: pointer; }
.rrow:hover { background: #f7f7f7; }
</style>
