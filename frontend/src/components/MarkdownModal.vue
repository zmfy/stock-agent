<template>
  <div v-if="open" class="md-mask" @click.self="$emit('close')">
    <div class="md-card">
      <button class="md-close" @click="$emit('close')">✕</button>
      <!-- 内容为用户自有 AI 输出，单用户自托管，渲染 markdown -->
      <div class="md-body" v-html="html"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../utils/md';

const props = defineProps<{ open: boolean; text: string }>();
defineEmits<{ (e: 'close'): void }>();

const html = computed(() => renderMarkdown(props.text));
</script>

<style scoped>
.md-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 24px;
}
.md-card {
  position: relative;
  background: var(--surface, #fff);
  color: var(--text, #222);
  border-radius: 12px;
  max-width: 760px;
  width: 100%;
  max-height: 82vh;
  overflow: auto;
  padding: 22px 26px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.md-close {
  position: absolute;
  top: 10px;
  right: 12px;
  border: none;
  background: none;
  font-size: 18px;
  cursor: pointer;
  color: #888;
}
.md-body { font-size: 14px; line-height: 1.7; }
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3) { margin: 0.6em 0 0.3em; }
.md-body :deep(ul), .md-body :deep(ol) { padding-left: 1.4em; margin: 0.4em 0; }
.md-body :deep(p) { margin: 0.4em 0; }
.md-body :deep(code) { background: var(--accent-soft, #f0f0f0); padding: 1px 4px; border-radius: 4px; }
.md-body :deep(pre) { background: var(--accent-soft, #f5f5f5); padding: 10px; border-radius: 6px; overflow: auto; }
.md-body :deep(table) { border-collapse: collapse; }
.md-body :deep(th), .md-body :deep(td) { border: 1px solid var(--border, #ddd); padding: 4px 8px; }
</style>
