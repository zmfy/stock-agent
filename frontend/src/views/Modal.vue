<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal-card">
      <div class="modal-head">
        <span class="modal-title">{{ title }}</span>
        <button class="modal-x" @click="$emit('close')" title="关闭">✕</button>
      </div>
      <div class="modal-body"><slot /></div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ title?: string }>();
defineEmits<{ (e: 'close'): void }>();
</script>

<style scoped>
.modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
.modal-card { background: var(--surface, #fff); border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2); width: 100%; max-width: 720px; max-height: 86vh; display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border, #e5e5e5); }
.modal-title { font-weight: 700; font-size: 15px; }
.modal-x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--muted, #888); padding: 2px 6px; }
.modal-body { padding: 16px; overflow-y: auto; }
</style>
