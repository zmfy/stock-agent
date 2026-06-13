<template>
  <div class="stocktext">
    <div ref="body" class="st-body" :class="{ clamped: collapsed }">
      <template v-for="(seg, idx) in segments" :key="idx">
        <button v-if="seg.type === 'stock'" class="stock-chip" @click="onStock(seg.code)">{{ seg.name ? seg.name + ' ' : '' }}{{ seg.code }}</button>
        <span v-else>{{ seg.s }}</span>
      </template>
    </div>
    <button v-if="collapsed" class="clamp-more" @click="$emit('detail', text)">详细 ›</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch, inject } from 'vue';
import { useStockLinkify, type Seg } from '../composables/useStockLinkify';

const props = withDefaults(defineProps<{ text: string; clamp?: boolean }>(), { clamp: true });
defineEmits<{ (e: 'detail', text: string): void }>();

const openStock = inject<(code: string) => void>('openStock', () => {});
const { ready, ensureLoaded, tokenize } = useStockLinkify();

const body = ref<HTMLElement | null>(null);
const collapsed = ref(false);

// 内容超过这么多行才折叠到 3 行 + 详细；短内容直接全显（避免「点详细只多几个字」）。
const COLLAPSE_AFTER_LINES = 6;

// ready 变化时重算（字典异步到位后补上 chip）
const segments = computed<Seg[]>(() => { void ready.value; return tokenize(props.text); });

function onStock(code: string) { openStock(code); }

async function measure() {
  if (!props.clamp) { collapsed.value = false; return; }
  await nextTick();
  const el = body.value;
  if (!el) return;
  // line-clamp 下 scrollHeight 仍为全内容高度，可据此估算总行数。
  const cs = getComputedStyle(el);
  let lh = parseFloat(cs.lineHeight);
  if (!lh || Number.isNaN(lh)) lh = (parseFloat(cs.fontSize) || 14) * 1.4;
  const fullLines = Math.round(el.scrollHeight / lh);
  collapsed.value = fullLines > COLLAPSE_AFTER_LINES;
}

onMounted(() => { ensureLoaded(); measure(); });
watch(() => [props.text, segments.value, props.clamp], measure);
</script>

<style scoped>
.st-body { white-space: pre-wrap; word-break: break-word; }
.st-body.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.stock-chip {
  display: inline; padding: 0 2px; margin: 0; border: none; background: none;
  color: var(--accent, #2a8a2a); font: inherit; cursor: pointer; border-bottom: 1px dashed currentColor;
}
.stock-chip:hover { text-decoration: none; opacity: 0.8; }
.clamp-more { margin-top: 2px; font-size: 12px; color: var(--accent, #2a8a2a); background: none; border: none; cursor: pointer; padding: 0; }
.clamp-more:hover { text-decoration: underline; }
</style>
