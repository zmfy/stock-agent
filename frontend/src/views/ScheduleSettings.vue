<template>
  <div class="sched">
    <div class="row">预判时间 <input type="time" v-model="cfg.prejudgeTime" /></div>
    <div class="row">盘中间隔
      <select v-model.number="cfg.intradayInterval">
        <option :value="30">每 30 分钟</option>
        <option :value="60">每 1 小时</option>
        <option :value="120">每 2 小时</option>
        <option :value="0">无</option>
      </select>
    </div>
    <div class="row">复盘时间 <input type="time" v-model="cfg.reviewTime" /></div>
    <div class="row">休市快报时间 <input type="time" v-model="cfg.holidayBriefTime" /></div>
    <div class="row">
      <button :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      <span v-if="msg" class="muted">{{ msg }}</span>
    </div>
  </div>
</template>
<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue';
import { strategyApi, type ScheduleConfig } from '../api/strategy';
const emit = defineEmits<{ (e: 'saved'): void }>();
const cfg = reactive<ScheduleConfig>({ prejudgeTime: '08:30', intradayInterval: 60, reviewTime: '15:30', holidayBriefTime: '09:00' });
const saving = ref(false);
const msg = ref('');
onMounted(async () => {
  try { Object.assign(cfg, (await strategyApi.getSchedule()).data.data.config); } catch { /* ignore */ }
});
async function save() {
  saving.value = true; msg.value = '';
  try { Object.assign(cfg, (await strategyApi.setSchedule({ ...cfg })).data.data.config); msg.value = '已保存'; emit('saved'); }
  catch (e: any) { msg.value = e.response?.data?.message || '保存失败'; }
  finally { saving.value = false; }
}
</script>
<style scoped>
.sched { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border, #e5e5e5); border-radius: 8px; }
.row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
</style>
