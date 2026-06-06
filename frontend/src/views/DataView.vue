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
      <h2>数据源管理</h2>
      <p class="hint">推荐用内置源；也可添加你自己的数据服务（同接口的 HTTP 地址）。优先级数字越小越优先；多个源会用于交叉验证。</p>
      <table class="srctable">
        <thead><tr><th>启用</th><th>名称</th><th>地址</th><th>优先级</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="s in dsources" :key="s.id">
            <td><input type="checkbox" :checked="s.enabled === 1" @change="toggleSource(s)" /></td>
            <td>{{ s.name }} <span v-if="s.builtin" class="tag">内置</span></td>
            <td class="url">{{ s.base_url }}</td>
            <td><input class="pri" type="number" :value="s.priority" @change="setPriority(s, $event)" /></td>
            <td><button v-if="!s.builtin" class="del" @click="removeSource(s)">删除</button></td>
          </tr>
        </tbody>
      </table>
      <div v-if="catalog.length" class="catalog">
        <div class="chint">推荐数据源（一键添加）：</div>
        <div v-for="c in catalog" :key="c.base_url" class="crow">
          <span><b>{{ c.name }}</b> <span class="muted">— {{ c.note }}</span></span>
          <button @click="addRecommended(c)" :disabled="busy">添加</button>
        </div>
      </div>

      <div class="row addsrc">
        <input v-model="newSrc.name" placeholder="自定义数据源名称" />
        <input v-model="newSrc.url" placeholder="https://地址（同接口的服务）" />
        <button @click="addSource" :disabled="busy">添加自定义</button>
      </div>
      <p v-if="srcMsg" :class="srcOk ? 'ok-msg' : 'err'">{{ srcMsg }}</p>
    </section>

    <section class="card">
      <h2>股票库（本地全量 A 股）</h2>
      <p class="hint">代码 + 名称 + 拼音首字母存本地，用于自由查询的快速搜索。后台同步，可手动触发增量同步（对比增删改，不全量重拉）。</p>
      <div class="row">
        <span>本地：<b>{{ sync.count }}</b> 只 · 状态：{{ syncStateCn }}</span>
        <button @click="doStockSync" :disabled="sync.state === 'running'">{{ sync.state === 'running' ? '同步中…' : '重新同步（增量）' }}</button>
      </div>
      <div v-if="sync.state === 'running'" class="muted">{{ sync.message }}（{{ sync.done }}/{{ sync.total }}）</div>
      <div v-else-if="sync.message" class="muted">{{ sync.message }}</div>
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
          <div class="nmeta">来源 AkShare · {{ n.published_at || n.fetched_at }}</div>
          <div v-if="n.summary" class="nsum">{{ n.summary }}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>上传行情 CSV（通达信导出）</h2>
      <p class="hint">支持中英文表头（代码/日期/开盘/最高/最低/收盘/成交量），日期可为 20260601 或 2026-06-01。无代码列时可在下方填写。</p>
      <button class="linklike" @click="showTdxHelp = !showTdxHelp">{{ showTdxHelp ? '▾' : '▸' }} 通达信数据怎么导入？（帮助说明）</button>
      <div v-if="showTdxHelp" class="tdxhelp">
        <ol>
          <li>打开<b>通达信</b>客户端，进入要导出的个股 K 线图（日线）。</li>
          <li>菜单 <b>系统 → 数据导出</b>（或在 K 线图上点右键 → 导出数据 / 复制数据）。</li>
          <li>选择<b>当前股票</b>、周期<b>日线</b>、范围按需，格式选 <b>CSV / Excel / TXT（带表头）</b>，导出到本地。</li>
          <li>确认文件含这些列（中文或英文均可）：<code>代码, 日期, 开盘, 最高, 最低, 收盘, 成交量</code>。
            日期 <code>20260601</code> 或 <code>2026-06-01</code> 都行；代码可带 <code>sh/sz</code> 前缀。</li>
          <li>回到本页，点下方「选择文件」上传即可。若文件没有“代码”列，在下面的输入框填上股票代码。</li>
        </ol>
        <p class="muted">说明：上传的数据会作为该股的<b>最高优先级数据源</b>（覆盖在线源），并参与校验。也可一次导出多只股票（含“代码”列）一起上传。</p>
        <p class="muted">示例表头：<code>代码,日期,开盘,最高,最低,收盘,成交量</code></p>
      </div>
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
      <div v-if="snap?.sources" class="prov">
        数据来源：
        <span v-if="snap.sources.quote">行情 {{ snap.sources.quote.source }}@{{ snap.sources.quote.date }}（取于 {{ snap.sources.quote.fetched_at }}）</span>
        <span v-if="snap.sources.fundamentals">· 基本面 {{ snap.sources.fundamentals.source }}@{{ snap.sources.fundamentals.date }}</span>
        <span v-if="snap.sources.market">· 情绪 {{ snap.sources.market.source }}@{{ snap.sources.market.date }}</span>
        <span v-if="snap.sources.sidecarBase">· 主源 {{ snap.sources.sidecarBase }}</span>
      </div>
      <p v-if="snap && snap._missing.length" class="hint">缺失字段：{{ snap._missing.join('、') }}（上传 CSV 或启用数据源后可补全）。</p>
      <p v-if="lookupMsg" class="err">{{ lookupMsg }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { dataApi, type StockSnapshot, type NewsItem, type DataSource } from '../api/data';

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
const showTdxHelp = ref(false);

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

// ---- data source management ----
const dsources = ref<DataSource[]>([]);
const catalog = ref<Array<{ name: string; base_url: string; note: string }>>([]);
const newSrc = ref({ name: '', url: '' });
const srcMsg = ref('');
const srcOk = ref(false);

async function loadSources() {
  try {
    dsources.value = (await dataApi.listSources()).data.data;
    catalog.value = (await dataApi.catalog()).data.data;
  } catch { /* ignore */ }
}
async function addRecommended(c: { name: string; base_url: string }) {
  busy.value = true; srcMsg.value = '';
  try {
    await dataApi.addSource(c.name, c.base_url);
    srcOk.value = true; srcMsg.value = `已添加 ${c.name}`;
    await loadSources(); await loadSource();
  } catch (e: any) {
    srcOk.value = false; srcMsg.value = e.response?.data?.message || '添加失败';
  } finally { busy.value = false; }
}
async function addSource() {
  srcMsg.value = '';
  if (!newSrc.value.name.trim() || !newSrc.value.url.trim()) { srcOk.value = false; srcMsg.value = '请填写名称和地址'; return; }
  busy.value = true;
  try {
    await dataApi.addSource(newSrc.value.name.trim(), newSrc.value.url.trim());
    newSrc.value = { name: '', url: '' };
    srcOk.value = true; srcMsg.value = '已添加';
    await loadSources(); await loadSource();
  } catch (e: any) {
    srcOk.value = false; srcMsg.value = e.response?.data?.message || '添加失败';
  } finally { busy.value = false; }
}
async function toggleSource(s: DataSource) {
  await dataApi.updateSource(s.id, { enabled: s.enabled !== 1 });
  await loadSources(); await loadSource();
}
async function setPriority(s: DataSource, ev: Event) {
  const v = parseInt((ev.target as HTMLInputElement).value, 10);
  if (!isNaN(v)) { await dataApi.updateSource(s.id, { priority: v }); await loadSources(); await loadSource(); }
}
async function removeSource(s: DataSource) {
  if (!confirm(`删除数据源「${s.name}」？`)) return;
  try {
    await dataApi.deleteSource(s.id);
    await loadSources(); await loadSource();
  } catch (e: any) {
    srcOk.value = false; srcMsg.value = e.response?.data?.message || '删除失败';
  }
}

// ---- stock universe sync ----
const sync = reactive({ state: 'idle', total: 0, done: 0, message: '', count: 0 });
let syncPoll: ReturnType<typeof setInterval> | null = null;
const syncStateCn = computed(() => ({ idle: '未同步', running: '同步中', done: '已完成', error: '出错' }[sync.state] || sync.state));
async function loadSyncStatus() {
  try { Object.assign(sync, (await dataApi.stockSyncStatus()).data.data); } catch { /* ignore */ }
}
async function doStockSync() {
  await dataApi.stockSync();
  sync.state = 'running';
  if (syncPoll) clearInterval(syncPoll);
  syncPoll = setInterval(async () => {
    await loadSyncStatus();
    if (sync.state !== 'running' && syncPoll) { clearInterval(syncPoll); syncPoll = null; }
  }, 1500);
}
onUnmounted(() => { if (syncPoll) clearInterval(syncPoll); });

onMounted(async () => {
  await loadSource();
  await loadSources();
  await loadSyncStatus();
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
.prov { font-size: 12px; color: #888; margin-top: 8px; }
.srctable { width: 100%; border-collapse: collapse; margin: 8px 0; }
.srctable th, .srctable td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.srctable .url { color: #777; font-size: 12px; }
.srctable .pri { width: 60px; }
.tag { font-size: 11px; background: #eef; color: #446; border-radius: 8px; padding: 1px 6px; }
.addsrc input { flex: 1; }
.linklike { background: none; border: none; color: #34699a; cursor: pointer; padding: 4px 0; font-size: 13px; }
.tdxhelp { background: #f7f9fc; border: 1px solid #dfe7f2; border-radius: 6px; padding: 8px 14px; font-size: 13px; line-height: 1.7; }
.tdxhelp code { background: #eef; padding: 0 4px; border-radius: 3px; }
.catalog { background: #f7faf7; border: 1px solid #e0eee0; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.chint { font-size: 12px; color: #666; margin-bottom: 4px; }
.crow { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; padding: 3px 0; }
button:disabled { opacity: 0.5; }
</style>
