<template>
  <div class="conclusion-bubble">
    <template v-if="parsed.hasSummary">
      <StockText :text="parsed.summary" :clamp="false" />
      <button class="clamp-more" @click="$emit('detail', parsed.full)">详细 ›</button>
    </template>
    <StockText v-else :text="parsed.full" @detail="$emit('detail', $event)" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import StockText from './StockText.vue';
import { splitConclusion } from '../utils/conclusion';

const props = defineProps<{ text: string }>();
defineEmits<{ (e: 'detail', text: string): void }>();

const parsed = computed(() => splitConclusion(props.text));
</script>

<style scoped>
.clamp-more { margin-top: 2px; font-size: 12px; color: var(--accent, #2a8a2a); background: none; border: none; cursor: pointer; padding: 0; }
.clamp-more:hover { text-decoration: underline; }
</style>
