<template>
  <div class="alerts-view">
    <div class="head">
      <h1>数据告警</h1>
      <button class="mini" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '🔄 刷新' }}</button>
    </div>
    <p class="hint">从同步状态、定时任务、大盘数据、sidecar 健康实时计算；问题修复后自动消失。每 30 秒自动刷新。</p>

    <div v-if="!alerts.length" class="ok-box">✅ 一切正常，暂无数据告警。</div>
    <ul v-else class="alert-list">
      <li v-for="a in alerts" :key="a.source" class="alert-item" :class="a.level">
        <span class="badge">{{ a.level === 'error' ? '错误' : '警告' }}</span>
        <span class="src">{{ a.source }}</span>
        <span class="msg">{{ a.message }}</span>
        <span v-if="a.since" class="since">{{ a.since }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { dataApi, type DataAlert } from '../api/data';

const alerts = ref<DataAlert[]>([]);
const loading = ref(false);
let timer: number | undefined;

async function load() {
  loading.value = true;
  try {
    alerts.value = (await dataApi.getAlerts()).alerts;
  } catch {
    /* ignore */
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  timer = window.setInterval(load, 30000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.alerts-view { padding: 18px 22px; }
.head { display: flex; align-items: center; gap: 12px; }
.hint { color: var(--muted); font-size: 13px; margin: 6px 0 16px; }
.ok-box { padding: 16px; background: var(--card, #fff); border-radius: 8px; color: var(--muted); }
.alert-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.alert-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; border-left: 4px solid; background: var(--card, #fff); }
.alert-item.error { border-color: #d33; }
.alert-item.warn { border-color: #d9a300; }
.badge { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 10px; color: #fff; }
.alert-item.error .badge { background: #d33; }
.alert-item.warn .badge { background: #d9a300; }
.src { font-family: monospace; font-size: 12px; color: var(--muted); }
.msg { flex: 1; }
.since { color: var(--muted); font-size: 12px; }
</style>
