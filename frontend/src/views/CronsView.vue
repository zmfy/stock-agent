<template>
  <div class="crons">
    <h2>定时任务</h2>
    <p v-if="!cronEnabled" class="err">⚠️ 定时未全局启用（ENABLE_CRON=false），以下配置将在启用后生效。</p>
    <table class="ctable">
      <thead><tr><th>任务</th><th>每天时间</th><th>启用</th><th>最后运行</th><th>下次运行</th><th>操作</th></tr></thead>
      <tbody>
        <tr v-for="j in jobs" :key="j.key">
          <td><b>{{ j.label }}</b><div class="muted">{{ j.description }}</div></td>
          <td>
            <template v-if="j.time !== null">
              <input type="time" v-model="edit[j.key]" /> <button @click="saveTime(j)">保存</button>
            </template>
            <span v-else class="muted">自定义（{{ j.expr }}）</span>
          </td>
          <td><input type="checkbox" :checked="j.enabled" @change="toggle(j, ($event.target as HTMLInputElement).checked)" /></td>
          <td>
            <span v-if="j.lastRunAt">{{ fmtCN(j.lastRunAt) }}
              <span :class="j.lastStatus === 'error' ? 'err' : j.lastStatus === 'running' ? 'muted' : 'okmsg'">
                {{ j.lastStatus === 'ok' ? '✅' : j.lastStatus === 'error' ? '❌' : '⏳' }}{{ j.lastDurationMs != null ? ` ${j.lastDurationMs}ms` : '' }}
              </span>
            </span><span v-else class="muted">从未</span>
            <div v-if="j.lastError" class="err">{{ j.lastError }}</div>
          </td>
          <td>{{ j.nextRunAt ? fmtCN(j.nextRunAt) : '—' }}</td>
          <td>
            <button @click="runNow(j)" :disabled="j.lastStatus === 'running'">立即运行</button>
            <button @click="showLog(j)">日志</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="msg" :class="msgOk ? 'okmsg' : 'err'">{{ msg }}</p>
    <div v-if="logKey" class="logbox">
      <h3>{{ logKey }} 日志 <button @click="logKey = null">关闭</button></h3>
      <div v-for="(l, i) in logLines" :key="i" :class="l.level === 'error' ? 'err' : 'muted'">{{ fmtCN(l.ts) }} [{{ l.level }}] {{ l.message }}</div>
      <div v-if="!logLines.length" class="muted">暂无日志</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import { cronApi, type CronJob } from '../api/cron';
import { fmtCN } from '../utils/time';

const jobs = ref<CronJob[]>([]);
const cronEnabled = ref(true);
const edit = reactive<Record<string, string>>({});
const msg = ref(''); const msgOk = ref(false);
const logKey = ref<string | null>(null);
const logLines = ref<Array<{ ts: string; level: string; message: string }>>([]);
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  const d = await cronApi.list();
  cronEnabled.value = d.cronEnabled;
  jobs.value = d.jobs;
  for (const j of d.jobs) if (j.time) edit[j.key] = j.time;
}
async function saveTime(j: CronJob) {
  try { await cronApi.update(j.key, { time: edit[j.key] }); msgOk.value = true; msg.value = `${j.label} 已改为每天 ${edit[j.key]}`; await load(); }
  catch (e: any) { msgOk.value = false; msg.value = e.response?.data?.message || '保存失败'; }
}
async function toggle(j: CronJob, enabled: boolean) {
  try { await cronApi.update(j.key, { enabled }); msgOk.value = true; msg.value = `${j.label} 已${enabled ? '启用' : '停用'}`; await load(); }
  catch (e: any) { msgOk.value = false; msg.value = e.response?.data?.message || '操作失败'; }
}
async function runNow(j: CronJob) {
  try { await cronApi.runNow(j.key); msgOk.value = true; msg.value = `${j.label} 已触发`; setTimeout(load, 800); }
  catch (e: any) { msgOk.value = false; msg.value = e.response?.data?.message || '触发失败'; }
}
async function showLog(j: CronJob) { logKey.value = j.key; logLines.value = await cronApi.log(j.key); }

onMounted(async () => {
  await load();
  timer = setInterval(() => { if (jobs.value.some((j) => j.lastStatus === 'running')) load(); }, 1500);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.crons { max-width: 960px; }
.ctable { width: 100%; border-collapse: collapse; }
.ctable th, .ctable td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
.okmsg { color: var(--accent, #2a8a2a); }
.err { color: #e5484d; }
.muted { color: #888; font-size: 12px; }
.logbox { margin-top: 12px; font-family: monospace; font-size: 12px; }
</style>
