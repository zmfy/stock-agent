<template>
  <div class="cal-wrap">
    <button class="mini cal-btn" title="A股日历" @click="toggleCalendar">📅</button>
    <div v-if="calOpen" class="cal-pop">
      <div class="cal-nav">
        <button class="mini" @click="prevMonth">‹</button>
        <span>{{ calYear }} 年 {{ calMonth }} 月</span>
        <button class="mini" @click="nextMonth" :disabled="atCalMax">›</button>
      </div>
      <div class="cal-grid cal-head">
        <span v-for="w in ['一','二','三','四','五','六','日']" :key="w">{{ w }}</span>
      </div>
      <div class="cal-grid">
        <span v-for="n in calLead" :key="'b' + n" class="cal-cell blank"></span>
        <span v-for="d in calDays" :key="d.date" class="cal-cell" :class="{ closed: !d.trading, today: d.date === calToday }">
          {{ Number(d.date.slice(8, 10)) }}
          <i v-if="!d.trading" class="cal-x">休</i>
        </span>
      </div>
      <div class="cal-foot muted">灰色=休市（周末/节假日）；今日高亮。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { dataApi } from '../api/data';

const calToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const calOpen = ref(false);
const calYear = ref(Number(calToday.slice(0, 4)));
const calMonth = ref(Number(calToday.slice(5, 7)));
const calDays = ref<Array<{ date: string; trading: boolean }>>([]);
const calLead = computed(() => {
  const first = `${calYear.value}-${String(calMonth.value).padStart(2, '0')}-01`;
  return (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
});
const calMax = (() => {
  const y = Number(calToday.slice(0, 4));
  const m = Number(calToday.slice(5, 7));
  const d = Number(calToday.slice(8, 10));
  const afterNov30 = m > 11 || (m === 11 && d >= 30);
  return { year: afterNov30 ? y + 1 : y, month: 12 };
})();
const atCalMax = computed(() => calYear.value > calMax.year || (calYear.value === calMax.year && calMonth.value >= calMax.month));
async function loadCalendar() {
  try { calDays.value = (await dataApi.tradeCalendar(calYear.value, calMonth.value)).days; } catch { calDays.value = []; }
}
function toggleCalendar() {
  calOpen.value = !calOpen.value;
  if (calOpen.value) {
    calYear.value = Number(calToday.slice(0, 4));
    calMonth.value = Number(calToday.slice(5, 7));
    loadCalendar();
  }
}
function prevMonth() {
  if (calMonth.value === 1) { calMonth.value = 12; calYear.value--; } else calMonth.value--;
  loadCalendar();
}
function nextMonth() {
  if (atCalMax.value) return;
  if (calMonth.value === 12) { calMonth.value = 1; calYear.value++; } else calMonth.value++;
  loadCalendar();
}
</script>

<style scoped>
.cal-wrap { position: relative; }
.cal-btn { font-size: 14px; padding: 2px 6px; }
.cal-pop { position: absolute; bottom: calc(100% + 6px); right: 0; min-width: 240px; max-width: calc(100vw - 24px); background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,0.16); padding: 10px; z-index: 60; }
.cal-nav { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.cal-head span { text-align: center; font-size: 11px; color: var(--muted, #888); padding: 2px 0; }
.cal-cell { position: relative; text-align: center; font-size: 12px; padding: 5px 0; border-radius: 6px; cursor: default; }
.cal-cell.blank { visibility: hidden; }
.cal-cell.closed { background: #f0f0f0; color: #aaa; }
.cal-cell.today { outline: 2px solid var(--accent, #2a8a2a); font-weight: 700; }
.cal-x { position: absolute; top: 0; right: 2px; font-size: 8px; color: #c98; font-style: normal; }
.cal-foot { font-size: 11px; margin-top: 6px; }
.mini { font-size: 12px; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
</style>
