<template>
  <div class="report">
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
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h } from 'vue';
import { type AnalysisReport, type GateResult } from '../api/analysis';
import { fmtCN } from '../utils/time';

const props = defineProps<{ report: AnalysisReport }>();

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

const systemsOf = computed(() => [...new Set((props.report.gate_results || []).map((g) => g.system))].sort());
function gatesOf(sys: string) {
  return props.report.gate_results.filter((g) => g.system === sys) || [];
}
function labelOf(key: string) {
  return props.report.gate_results.find((g) => g.gate_key === key)?.label || key;
}
function authorityCn(a: string) {
  return ({ uploaded: '以上传数据为准', cross: '交叉验证', internal: '合理性检查', none: '无来源' } as Record<string, string>)[a] || a;
}
</script>

<style scoped>
.report { font-size: 13px; }
.meta { color: #999; font-size: 12px; }
.prov { font-size: 12px; color: #888; margin: 6px 0; }
.prov .ok { color: #2a8a2a; }
.prov .warn { color: #c08; }
.oneliner { background: #f3faf3; border: 1px solid #cce8cc; padding: 8px 12px; border-radius: 6px; font-weight: 600; }
.concl { margin: 6px 0; }
h4 { margin: 10px 0 4px; }
:deep(table.gates) { width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
:deep(table.gates th), :deep(table.gates td) { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.teach { background: #fafafa; border-radius: 6px; padding: 8px 12px; }
.teach ul { margin: 4px 0 0; padding-left: 18px; }
</style>
