<template>
  <div class="mh">
    <header class="bar"><h1>早会 / 晚会历史</h1></header>
    <p v-if="!list.length" class="muted">还没有早会/晚会记录。可在主页左栏「生成早会/晚会」，或等每天 8:00 / 16:45 自动生成。</p>
    <div v-for="m in list" :key="m.id" class="item">
      <div class="head" @click="toggle(m.id)">
        <span class="tag" :class="m.kind">{{ m.kind === 'morning' ? '早会' : '晚会' }}</span>
        <span class="date">{{ m.date }}</span>
        <span class="summary">{{ open[m.id] ? '' : summarize(m.content) }}</span>
        <span class="chev">{{ open[m.id] ? '▾' : '▸' }}</span>
      </div>
      <pre v-if="open[m.id]" class="full">{{ m.content }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { meetingsApi, type Meeting } from '../api/meetings';

const list = ref<Meeting[]>([]);
const open = reactive<Record<string, boolean>>({});

function summarize(c: string) {
  const t = (c || '').replace(/[#*\n]/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
function toggle(id: string) {
  open[id] = !open[id];
}

onMounted(async () => {
  try {
    list.value = (await meetingsApi.list()).data.data;
  } catch {
    /* ignore */
  }
});
</script>

<style scoped>
.mh { max-width: 760px; margin: 0 auto; }
.muted { color: #999; }
.item { border: 1px solid #eee; border-radius: 8px; margin: 8px 0; }
.head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; font-size: 13px; }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 8px; }
.tag.morning { background: #fff3d6; color: #a76b00; }
.tag.evening { background: #e8eef7; color: #34699a; }
.date { color: #666; }
.summary { flex: 1; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chev { color: #aaa; }
.full { white-space: pre-wrap; padding: 0 12px 12px; font-size: 13px; line-height: 1.6; margin: 0; }
</style>
