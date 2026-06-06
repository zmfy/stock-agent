<template>
  <div class="data">
    <header class="bar">
      <h1>数据</h1>
      <router-link to="/">返回</router-link>
    </header>

    <section class="banner" :class="source.sidecarHealthy ? 'ok' : 'warn'">
      <template v-if="source.sidecarConfigured">
        数据源（AkShare）：{{ source.base }} —
        <b>{{ source.sidecarHealthy ? '在线' : '离线/不可达' }}</b>
      </template>
      <template v-else>未启用 AkShare 数据源插件（可在「能力插件」启用）。仍可手动上传 CSV 行情。</template>
    </section>

    <section class="card">
      <h2>数据采集</h2>
      <div class="row">
        <button @click="refreshMarket" :disabled="busy">刷新大盘/情绪数据</button>
        <button @click="collectNews" :disabled="busy">采集热点新闻</button>
      </div>
      <p v-if="collectMsg" :class="collectOk ? 'ok-msg' : 'err'">{{ collectMsg }}</p>
      <div v-if="news.length" class="news">
        <div v-for="(n, i) in news" :key="i" class="nitem">
          <div class="ntitle">{{ n.title }}</div>
          <div class="nmeta">{{ n.published_at || n.fetched_at }}</div>
          <div v-if="n.summary" class="nsum">{{ n.summary }}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>上传行情 CSV（通达信导出）</h2>
      <p class="hint">支持中英文表头（代码/日期/开盘/最高/最低/收盘/成交量），日期可为 20260601 或 2026-06-01。无代码列时可在下方填写。</p>
      <input type="file" accept=".csv,.txt" @change="onFile" />
      <input v-model="uploadCode" placeholder="（可选）股票代码，CSV 无代码列时使用" />
      <button @click="doUpload" :disabled="!file || busy">上传</button>
      <p v-if="uploadMsg" :class="uploadOk ? 'ok-msg' : 'err'">{{ uploadMsg }}</p>
    </section>

    <section class="card">
      <h2>查看个股快照</h2>
      <div class="row">
        <input v-model="code" placeholder="股票代码，如 600519" @keyup.enter="lookup" />
        <button @click="lookup" :disabled="busy">查询</button>
        <button @click="refresh" :disabled="busy">刷新数据源</button>
      </div>
      <table v-if="snap" class="snap">
        <tbody>
          <tr><th>代码 / 名称</th><td>{{ snap.code }} {{ snap.name || '' }}</td></tr>
          <tr v-for="f in fields" :key="f.key" :class="{ miss: snap._missing.includes(f.key) }">
            <th>{{ f.label }}</th>
            <td>{{ snap[f.key] === null ? '—（缺）' : snap[f.key] }}{{ snap[f.key] !== null ? f.unit : '' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="snap && snap._missing.length" class="hint">缺失字段：{{ snap._missing.join('、') }}（上传 CSV 或启用数据源后可补全）。</p>
      <p v-if="lookupMsg" class="err">{{ lookupMsg }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { dataApi, type StockSnapshot, type NewsItem } from '../api/data';

const source = reactive({ sidecarConfigured: false, base: null as string | null, sidecarHealthy: false });
const file = ref<File | null>(null);
const uploadCode = ref('');
const uploadMsg = ref(''); const uploadOk = ref(false);
const code = ref('');
const snap = ref<StockSnapshot | null>(null);
const lookupMsg = ref('');
const busy = ref(false);

const fields = [
  { key: 'close', label: '最新收盘', unit: '' },
  { key: 'roe_ttm', label: 'ROE(TTM)', unit: '%' },
  { key: 'pe', label: 'PE(TTM)', unit: '倍' },
  { key: 'pb', label: 'PB', unit: '倍' },
  { key: 'ps', label: 'PS', unit: '倍' },
  { key: 'net_profit', label: '归母净利润', unit: '元' },
  { key: 'turnover_rate', label: '换手率', unit: '%' },
  { key: 'ma20', label: '20日均线', unit: '' },
  { key: 'ma60', label: '60日均线', unit: '' },
  { key: 'year_high', label: '年内高点', unit: '' },
  { key: 'limit_up_count', label: '涨停家数', unit: '家' },
  { key: 'limit_down_count', label: '跌停家数', unit: '家' },
  { key: 'sse_ma20_slope', label: '上证20日线斜率', unit: '' },
] as const;

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] || null;
}

async function doUpload() {
  if (!file.value) return;
  uploadMsg.value = ''; busy.value = true;
  try {
    const res = await dataApi.uploadCsv(file.value, uploadCode.value || undefined);
    uploadOk.value = true;
    uploadMsg.value = `已导入 ${res.data.data.inserted} 行，代码：${res.data.data.codes.join('、')}`;
  } catch (e: any) {
    uploadOk.value = false; uploadMsg.value = e.response?.data?.message || '上传失败';
  } finally {
    busy.value = false;
  }
}

async function lookup() {
  if (!code.value.trim()) return;
  lookupMsg.value = ''; busy.value = true;
  try {
    snap.value = (await dataApi.snapshot(code.value.trim())).data.data;
  } catch (e: any) {
    lookupMsg.value = e.response?.data?.message || '查询失败';
  } finally {
    busy.value = false;
  }
}

async function refresh() {
  busy.value = true; lookupMsg.value = '';
  try {
    const res = await dataApi.refresh(code.value.trim() || undefined);
    if (res.data.data.snapshot) snap.value = res.data.data.snapshot;
    await loadSource();
  } catch (e: any) {
    lookupMsg.value = e.response?.data?.message || '刷新失败';
  } finally {
    busy.value = false;
  }
}

async function loadSource() {
  try {
    const s = (await dataApi.getSource()).data.data;
    Object.assign(source, s);
  } catch { /* ignore */ }
}

const news = ref<NewsItem[]>([]);
const collectMsg = ref('');
const collectOk = ref(false);

async function refreshMarket() {
  busy.value = true; collectMsg.value = '';
  try {
    await dataApi.refresh();
    collectOk.value = true; collectMsg.value = '大盘/情绪数据已刷新';
    await loadSource();
  } catch (e: any) {
    collectOk.value = false; collectMsg.value = e.response?.data?.message || '刷新失败';
  } finally {
    busy.value = false;
  }
}

async function collectNews() {
  busy.value = true; collectMsg.value = '';
  try {
    const res = await dataApi.refreshNews();
    news.value = res.data.data.news;
    collectOk.value = res.data.data.inserted > 0;
    collectMsg.value = res.data.data.inserted > 0 ? `已采集 ${res.data.data.inserted} 条热点新闻` : '未取到新闻（数据源不可用或未启用 AkShare 插件）';
  } catch (e: any) {
    collectOk.value = false; collectMsg.value = e.response?.data?.message || '采集失败';
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await loadSource();
  try {
    news.value = (await dataApi.getNews()).data.data;
  } catch { /* ignore */ }
});
</script>

<style scoped>
.data { max-width: 720px; margin: 24px auto; padding: 0 16px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.banner { padding: 8px 12px; border-radius: 6px; margin-top: 12px; font-size: 13px; }
.banner.ok { background: #f3faf3; border: 1px solid #cce8cc; }
.banner.warn { background: #fff7e6; border: 1px solid #ffe0a3; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
.hint { color: #777; font-size: 12px; }
.row { display: flex; gap: 8px; }
input { padding: 5px; }
.snap { width: 100%; border-collapse: collapse; margin-top: 10px; }
.snap th, .snap td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.snap th { width: 40%; color: #555; }
.snap tr.miss td { color: #c08; }
.err { color: #c00; }
.ok-msg { color: #2a8a2a; }
.news { margin-top: 10px; max-height: 320px; overflow-y: auto; }
.nitem { border-top: 1px solid #eee; padding: 8px 0; }
.ntitle { font-size: 14px; font-weight: 600; }
.nmeta { font-size: 11px; color: #999; }
.nsum { font-size: 13px; color: #555; margin-top: 2px; }
button:disabled { opacity: 0.5; }
</style>
