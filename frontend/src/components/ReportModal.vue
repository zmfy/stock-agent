<template>
  <div v-if="open" class="rpt-mask" @click.self="$emit('close')">
    <div class="rpt-card">
      <div class="rpt-head">
        <h3 class="rpt-title">
          📊 完整报告<template v-if="report"> · {{ report.stock_code }} {{ report.stock_name || '' }}</template>
          <template v-else-if="code"> · {{ code }}</template>
        </h3>
        <button class="rpt-close" @click="$emit('close')">✕</button>
      </div>

      <div class="rpt-body">
        <p v-if="err" class="err">{{ err }}</p>
        <p v-else-if="busy" class="hint">正在加载 {{ code }} 的报告…</p>

        <section v-else-if="report" class="report">
          <div class="meta">
            规则版本 {{ report.rulebook_version_id?.slice(0, 8) || '—' }} · 数据 {{ report.data_date }} ·
            模型 {{ report.ai_provider }}/{{ report.ai_model }} · {{ fmtCN(report.created_at) }}
          </div>
          <div class="prov">
            <span v-if="report.validation" :class="report.validation.trusted ? 'ok' : 'warn'">
              数据校验：{{ report.validation.trusted ? '✅ 通过' : '⚠️ 存疑' }}（{{ authorityCn(report.validation.authority) }}）
            </span>
            <span v-if="report.sources?.quote">· 行情 {{ report.sources.quote.source }}@{{ report.sources.quote.date }}</span>
            <span v-if="report.sources?.fundamentals">· 基本面 {{ report.sources.fundamentals.source }}@{{ report.sources.fundamentals.date }}</span>
          </div>

          <p class="oneliner">👉 {{ report.one_liner }}</p>

          <template v-for="sys in systemsOf" :key="sys">
            <h4>{{ sys }} 系统</h4>
            <GateTable :rows="gatesOf(sys)" />
            <p v-if="sys === 'A' && report.a_conclusion" class="concl"><b>A 结论：</b>{{ report.a_conclusion }}</p>
            <p v-if="sys === 'B' && report.b_conclusion" class="concl"><b>B 结论：</b>{{ report.b_conclusion }}</p>
          </template>

          <p v-if="!systemsOf.length && report.a_conclusion" class="concl">{{ report.a_conclusion }}</p>
          <p v-if="report.exception_channel" class="concl"><b>例外通道：</b>{{ report.exception_channel }}</p>
          <p class="concl"><b>仓位建议：</b>{{ report.position_suggestion }}</p>

          <div v-if="report.teach_notes?.length" class="teach">
            <h4>📘 教学</h4>
            <ul><li v-for="(t, i) in report.teach_notes" :key="i"><b>{{ labelOf(t.gate_key) }}</b>：{{ t.note }}</li></ul>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, defineComponent, h } from 'vue';
import { analysisApi, type AnalysisReport, type GateResult } from '../api/analysis';
import { fmtCN } from '../utils/time';

const props = defineProps<{ open: boolean; code: string }>();
defineEmits<{ (e: 'close'): void }>();

const ICON: Record<string, string> = { pass: '✅', fail: '❌', unknown: '⚠️' };

const GateTable = defineComponent({
  props: { rows: { type: Array as () => GateResult[], required: true } },
  setup(p) {
    const cond = (r: GateResult) =>
      r.op === 'gt_field' ? `${r.field}>${r.ref_field}` : r.op === 'between' ? `${r.threshold}~${r.threshold2}` : `${r.op}${r.threshold}`;
    return () =>
      h('table', { class: 'gates' }, [
        h('thead', [h('tr', [h('th', '门槛'), h('th', '要求'), h('th', '实测'), h('th', '结果'), h('th', '类型')])]),
        h('tbody', p.rows.map((r) =>
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

const busy = ref(false);
const err = ref('');
const report = ref<AnalysisReport | null>(null);

const systemsOf = computed(() => [...new Set((report.value?.gate_results || []).map((g) => g.system))].sort());
function gatesOf(sys: string) {
  return report.value?.gate_results.filter((g) => g.system === sys) || [];
}
function labelOf(key: string) {
  return report.value?.gate_results.find((g) => g.gate_key === key)?.label || key;
}
function authorityCn(a: string) {
  return ({ uploaded: '以上传数据为准', cross: '交叉验证', internal: '合理性检查', none: '无来源' } as Record<string, string>)[a] || a;
}

async function load() {
  if (!props.code) return;
  busy.value = true;
  err.value = '';
  report.value = null;
  try {
    report.value = (await analysisApi.getLatestByCode(props.code)).data.data;
  } catch {
    try {
      report.value = (await analysisApi.run(props.code)).data.data;
    } catch (e: any) {
      err.value = e.response?.data?.message || '暂无报告，且重新分析失败';
    }
  } finally {
    busy.value = false;
  }
}

watch(
  () => [props.open, props.code],
  () => { if (props.open) load(); }
);
</script>

<style scoped>
.rpt-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.rpt-card { background: var(--surface, #fff); color: var(--text, #222); border-radius: 12px; width: 90%; max-width: 980px; height: 80vh; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25); overflow: hidden; }
.rpt-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; border-bottom: 1px solid var(--border, #eee); flex: none; }
.rpt-title { margin: 0; font-size: 16px; }
.rpt-close { border: none; background: none; font-size: 18px; cursor: pointer; color: #888; }
.rpt-body { padding: 16px 20px; overflow: auto; flex: 1; }
.meta { color: #999; font-size: 12px; }
.prov { font-size: 12px; color: #888; margin: 6px 0; }
.prov .ok { color: #2a8a2a; }
.prov .warn { color: #c08; }
.oneliner { background: #f3faf3; border: 1px solid #cce8cc; padding: 8px 12px; border-radius: 6px; font-weight: 600; }
.concl { margin: 6px 0; }
:deep(table.gates) { width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
:deep(table.gates th), :deep(table.gates td) { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.teach { background: #fafafa; border-radius: 6px; padding: 8px 12px; }
.muted { color: #999; }
.err { color: #c00; }
.hint { color: #888; }
</style>
