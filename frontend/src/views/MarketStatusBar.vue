<template>
  <div v-if="st" class="market-bar" :class="st.alertLevel || ''">
    <div class="indices">
      <span v-for="ix in st.indices" :key="ix.code" class="ix">
        <span class="ix-name">{{ ix.name }}</span>
        <template v-if="ix.point != null">
          <b :class="pctClass(ix.changePct)">{{ ix.point.toFixed(2) }}</b>
          <span v-if="ix.changePct != null" class="ix-pct" :class="pctClass(ix.changePct)">{{ ix.changePct >= 0 ? '+' : '' }}{{ ix.changePct.toFixed(2) }}%</span>
        </template>
        <span v-else class="muted">—</span>
      </span>
      <span class="ix" :title="sentimentTip"><span class="ix-name">涨停</span><b class="up">{{ st.limitUp != null ? st.limitUp : '—' }}</b></span>
      <span class="ix" :title="sentimentTip"><span class="ix-name">跌停</span><b class="down">{{ st.limitDown != null ? st.limitDown : '—' }}</b></span>
    </div>
    <div class="right">
      <button v-if="st.alertLevel" class="alert-toggle" @click="alertsOpen = !alertsOpen">⚠ 数据异常 {{ st.alerts.length }} 条</button>
      <span class="muted updated">数据更新于 {{ fmtUpdated(st.updatedAt) }}</span>
      <CalendarPopover />
    </div>
    <div v-if="alertsOpen && st.alerts.length" class="alert-pop">
      <div v-for="(a, i) in st.alerts" :key="i" class="alert-row" :class="a.level">
        <span class="badge">{{ a.level === 'error' ? '错误' : '警告' }}</span> {{ a.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { marketApi, type MarketStatus } from '../api/market';
import CalendarPopover from './CalendarPopover.vue';

const st = ref<MarketStatus | null>(null);
const alertsOpen = ref(false);
let timer: number | undefined;

function pctClass(p: number | null) { return p == null ? '' : p >= 0 ? 'up' : 'down'; }
function fmtUpdated(s: string | null) { return s ? String(s).slice(0, 16) : '—'; }
// 涨停/跌停 的来源与取得时间(悬停可见)——情绪数据日期常与指数实时更新时间不同。
const sentimentTip = computed(() => {
  const s = st.value;
  if (!s || (s.limitUp == null && s.limitDown == null)) return '暂无情绪数据';
  const parts = [`情绪数据 ${s.sentimentDate || '—'}`];
  if (s.sentimentSlope != null) parts.push(`上证20日斜率 ${s.sentimentSlope}`);
  if (s.sentimentFetchedAt) parts.push(`取得于 ${String(s.sentimentFetchedAt).slice(0, 16)}`);
  if (s.sentimentSource) parts.push(`来源 ${s.sentimentSource}`);
  return parts.join(' · ');
});
async function load() {
  try {
    st.value = (await marketApi.status()).data.data;
    if (!st.value.alertLevel) alertsOpen.value = false; // 告警清除后收起明细，避免下次恢复时自动弹开
  } catch { /* ignore */ }
}
onMounted(() => { load(); timer = window.setInterval(load, 30000); });
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.market-bar { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 6px 12px; border-top: 1px solid var(--border, #e5e5e5); font-size: 12px; background: var(--surface, #fff); }
.market-bar.error { background: #fdecec; }
.market-bar.warn { background: #fff7e6; }
.indices { display: flex; gap: 14px; flex-wrap: wrap; }
.ix { display: inline-flex; align-items: center; gap: 4px; }
.ix-name { color: var(--muted, #888); }
.ix-pct { font-size: 11px; }
.up { color: #d33; }
.down { color: #2a8a2a; }
.right { display: flex; align-items: center; gap: 12px; }
.alert-toggle { background: none; border: none; cursor: pointer; color: #a40000; font-weight: 600; }
.market-bar.warn .alert-toggle { color: #a76b00; }
.updated { white-space: nowrap; }
.alert-pop { position: absolute; bottom: 110%; right: 8px; z-index: 60; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.12); padding: 8px 10px; max-width: 480px; }
.alert-row { font-size: 12px; padding: 2px 0; }
.alert-row .badge { font-size: 10px; padding: 0 6px; border-radius: 8px; color: #fff; margin-right: 6px; }
.alert-row.error .badge { background: #d33; }
.alert-row.warn .badge { background: #d9a300; }
</style>
