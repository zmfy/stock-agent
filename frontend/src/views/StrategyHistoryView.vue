<template>
  <div class="sh">
    <p v-if="!list.length" class="muted">还没有策略记录。预判/盘中/复盘会按你的设定时间自动生成，也可在「操盘和复盘」房间手动生成。</p>
    <section v-for="(m, i) in list" :key="i" class="card" @click="selected = m">
      <span class="tag" :class="m.phase">{{ phaseLabel(m.phase) }}</span>
      <span class="date">{{ m.date }}</span>
      <span class="summary">{{ summarize(m.content) }}</span>
    </section>

    <Modal v-if="selected" :title="`${phaseLabel(selected.phase)} · ${selected.date}`" @close="selected = null">
      <pre class="full">{{ selected.content }}</pre>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { strategyApi, type StrategyHistoryRow, type StrategyPhase } from '../api/strategy';
import Modal from './Modal.vue';

const list = ref<StrategyHistoryRow[]>([]);
const selected = ref<StrategyHistoryRow | null>(null);

const LABELS: Record<StrategyPhase, string> = { prejudge: '预判', intraday: '盘中', review: '复盘', holiday: '休市快报' };
function phaseLabel(p: StrategyPhase) { return LABELS[p] || p; }
function summarize(c: string) {
  const t = (c || '').replace(/[#*\n]/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}

onMounted(async () => {
  try { list.value = (await strategyApi.history()).data.data; } catch { /* ignore */ }
});
</script>

<style scoped>
.sh { max-width: 960px; margin: 0; padding: 0; }
.muted { color: #999; }
.card { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; cursor: pointer; font-size: 13px; transition: border-color 0.12s; }
.card:hover { border-color: var(--info, #2563a8); }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 8px; }
.tag.prejudge { background: #fff3d6; color: #a76b00; }
.tag.intraday { background: #e8f3ff; color: #2563a8; }
.tag.review { background: #e9f7e9; color: #2a8a2a; }
.tag.holiday { background: #eee; color: #777; }
.date { color: #666; }
.summary { flex: 1; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.full { white-space: pre-wrap; font-size: 13px; line-height: 1.7; margin: 0; }
</style>
