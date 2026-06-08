<template>
  <div class="clamptext">
    <div ref="body" class="clamp-body">{{ text }}</div>
    <button v-if="truncated" class="clamp-more" @click="$emit('detail', text)">详细 ›</button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue';

const props = defineProps<{ text: string }>();
defineEmits<{ (e: 'detail', text: string): void }>();

const body = ref<HTMLElement | null>(null);
const truncated = ref(false);

async function measure() {
  await nextTick();
  const el = body.value;
  if (!el) return;
  truncated.value = el.scrollHeight - el.clientHeight > 2;
}

onMounted(measure);
watch(() => props.text, measure);
</script>

<style scoped>
/* 始终最多 3 行；超出则旁边出「详细」按钮，点开走 markdown 弹层。 */
.clamp-body {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
.clamp-more {
  margin-top: 2px;
  font-size: 12px;
  color: var(--accent, #2a8a2a);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.clamp-more:hover { text-decoration: underline; }
</style>
