<template>
  <div class="ah">
    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="!reports.length && !err" class="muted">还没有分析记录。在「个股讨论」里分析任意股票后，会自动存档到这里。</p>

    <section v-for="r in reports" :key="r.id" class="card" @click="openReport(r)">
      <span class="tag">{{ r.stock_code }}</span>
      <span v-if="r.stock_name" class="name">{{ r.stock_name }}</span>
      <span class="date">{{ fmtCN(r.created_at) }}</span>
      <span class="summary">{{ r.one_liner }}</span>
    </section>

    <Modal v-if="selected" :title="`${selected.stock_code} ${selected.stock_name || ''} · ${fmtCN(selected.created_at)}`" @close="selected = null">
      <ReportDetail v-if="loaded[selected.id]" :report="loaded[selected.id]" />
      <p v-else-if="err" class="err">{{ err }}</p>
      <p v-else class="muted">加载中…</p>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { analysisApi, type AnalysisReport, type ReportSummary } from '../api/analysis';
import { fmtCN } from '../utils/time';
import Modal from './Modal.vue';
import ReportDetail from '../components/ReportDetail.vue';

const route = useRoute();
const focusCode = ref<string>(typeof route.query.code === 'string' ? route.query.code : '');

const err = ref('');
const reports = ref<ReportSummary[]>([]);
const selected = ref<ReportSummary | null>(null);
const loaded = reactive<Record<string, AnalysisReport>>({});

async function loadList() {
  try {
    reports.value = (await analysisApi.listReports()).data.data;
  } catch (e: any) {
    err.value = e.response?.data?.message || '加载分析历史失败';
  }
}

async function openReport(r: ReportSummary) {
  selected.value = r;
  err.value = '';
  if (!loaded[r.id]) {
    try {
      loaded[r.id] = (await analysisApi.getReport(r.id)).data.data;
    } catch (e: any) {
      err.value = e.response?.data?.message || '加载报告失败';
    }
  }
}

onMounted(async () => {
  await loadList();
  // 直达模式（标准路由 /analysis?code=）：自动弹出该股最近一份报告。
  if (focusCode.value) {
    const m = reports.value.find((r) => r.stock_code === focusCode.value);
    if (m) await openReport(m);
  }
});
</script>

<style scoped>
.ah { max-width: 960px; margin: 0; padding: 0; }
.muted { color: #999; }
.err { color: #c00; }
.card { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; cursor: pointer; font-size: 13px; transition: border-color 0.12s; }
.card:hover { border-color: var(--info, #2563a8); }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 8px; background: #e8f3ff; color: #2563a8; font-weight: 600; }
.name { color: #333; }
.date { color: #666; }
.summary { flex: 1; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
