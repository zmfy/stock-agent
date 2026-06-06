<template>
  <div class="stockpicker">
    <input
      v-model="q"
      :placeholder="placeholder || '代码 / 名称 / 拼音(如 gzmt)'"
      @input="onInput"
      @keyup.enter="onEnter"
      @focus="onInput"
      @blur="onBlur"
    />
    <ul v-if="open && suggest.length" class="sp-list">
      <li v-for="s in suggest" :key="s.code" @mousedown.prevent="choose(s)">
        {{ s.name }} <span class="sp-code">{{ s.code }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { dataApi } from '../api/data';

defineProps<{ placeholder?: string }>();
const emit = defineEmits<{ (e: 'pick', code: string): void }>();

const q = ref('');
const suggest = ref<Array<{ code: string; name: string }>>([]);
const open = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function onInput() {
  open.value = true;
  if (timer) clearTimeout(timer);
  const v = q.value.trim();
  if (!v) {
    suggest.value = [];
    return;
  }
  timer = setTimeout(async () => {
    try {
      suggest.value = (await dataApi.stockSearch(v)).data.data;
    } catch {
      suggest.value = [];
    }
  }, 250);
}
function choose(s: { code: string; name: string }) {
  emit('pick', s.code);
  q.value = '';
  suggest.value = [];
  open.value = false;
}
function onEnter() {
  const first = suggest.value[0];
  const code = first ? first.code : q.value.trim();
  if (!code) return;
  emit('pick', code);
  q.value = '';
  suggest.value = [];
  open.value = false;
}
function onBlur() {
  setTimeout(() => {
    open.value = false;
  }, 150);
}
</script>

<style scoped>
.stockpicker { position: relative; flex: 1; }
.stockpicker input { width: 100%; box-sizing: border-box; padding: 6px; }
.sp-list { position: absolute; z-index: 20; left: 0; right: 0; list-style: none; margin: 2px 0 0; padding: 0; max-height: 220px; overflow-y: auto; border: 1px solid #ddd; border-radius: 6px; background: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.sp-list li { padding: 6px 10px; cursor: pointer; font-size: 13px; }
.sp-list li:hover { background: #eef; }
.sp-code { color: #999; font-size: 12px; }
</style>
