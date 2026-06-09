<template>
  <div class="data">
    <header class="bar">
      <h1>数据</h1>
      <router-link to="/">返回</router-link>
    </header>

    <section class="overview">
      <span class="ov-item" :class="source.sidecarHealthy ? 'ok' : 'warn'">
        <b>●</b>
        <template v-if="source.sidecarConfigured">数据源 {{ source.sidecarHealthy ? '在线' : '离线' }}</template>
        <template v-else>未启用数据源</template>
      </span>
      <span class="ov-item">股票库 {{ fmtCNDate(jobs.stock_universe?.last_success_at) }}</span>
      <span class="ov-item">行情 {{ fmtCNDate(jobs.eod?.last_success_at) }}</span>
      <span v-if="anySyncing" class="ov-item syncing">⟳ 同步中…</span>
      <!-- admin: 后台有任务就显示进度 + 强制中止(任意子标签都可见) -->
      <template v-if="isAdmin">
        <span v-for="j in (['stock_universe','eod'] as const)" :key="j">
          <span v-if="jobs[j]?.state === 'running'" class="ov-item running">
            ⏳ {{ j === 'stock_universe' ? '股票库' : '行情' }} {{ jobs[j].done }}/{{ jobs[j].total }}（{{ jobPct(j) }}%）
            <button class="ov-stop" @click="doForceStop(j)">⛔ 强制中止</button>
          </span>
        </span>
      </template>
      <span v-if="!source.sidecarConfigured" class="ov-hint">可在「能力插件」启用 AkShare；仍可手动上传 CSV。</span>
    </section>

    <nav class="subtabs">
      <button :class="{ active: tab === 'source' }" @click="tab = 'source'">数据源</button>
      <button :class="{ active: tab === 'sync' }" @click="tab = 'sync'">同步状态</button>
      <button :class="{ active: tab === 'tools' }" @click="tab = 'tools'">工具</button>
    </nav>

    <div v-show="tab === 'source'">
      <section class="card">
        <h2>通达信行情服务器（主力源）</h2>
        <p class="hint">通达信(TDX)是行情 / 实时 / 列表 / 基本面的<b>主力数据源</b>。当前：<b>{{ tdxCurrent || '自动选最快(bestip)' }}</b></p>
        <div v-if="isAdmin" class="row">
          <button @click="testTdx" :disabled="tdxTesting">{{ tdxTesting ? '测速中…(约 10-20s)' : '⚡ 测速全部服务器' }}</button>
          <button @click="pickTdx('', 0)">自动选最快</button>
        </div>
        <table v-if="tdxServers.length" class="srctable">
          <thead><tr><th>服务器</th><th>地址</th><th>延迟</th><th>状态</th><th v-if="isAdmin">操作</th></tr></thead>
          <tbody>
            <tr v-for="s in tdxServers.slice(0, 30)" :key="s.addr + ':' + s.port">
              <td>{{ s.site }}</td>
              <td class="url">{{ s.addr }}:{{ s.port }}</td>
              <td>{{ s.latency_ms != null ? s.latency_ms + 'ms' : '—' }}</td>
              <td><span :class="s.ok ? 'probe-ok' : 'probe-bad'">{{ s.ok ? '可用' : '不可用' }}</span></td>
              <td v-if="isAdmin"><button v-if="s.ok" @click="pickTdx(s.addr, s.port)">选用</button></td>
            </tr>
          </tbody>
        </table>
        <p v-if="tdxServers.length" class="hint">仅显示前 30（已按可用+延迟排序）。</p>
      </section>

      <section v-if="isAdmin" class="card">
        <h2>出站代理</h2>
        <p class="hint"><b>SOCKS5</b>＝全部源（含通达信）走代理；<b>HTTP</b>＝仅 HTTP 源走代理，通达信直连。仅管理员可见可改。</p>
        <div class="row"><label><input type="checkbox" v-model="proxy.enabled" /> 启用代理</label></div>
        <div class="row">
          类型
          <select v-model="proxy.scheme"><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select>
          IP <input v-model="proxy.host" placeholder="代理服务器地址" />
          端口 <input v-model.number="proxy.port" type="number" style="width:90px" />
        </div>
        <div class="row">
          用户名 <input v-model="proxy.username" placeholder="可空" />
          口令 <input v-model="proxy.password" placeholder="可空" />
        </div>
        <div class="row">
          <button @click="saveProxy" :disabled="proxySaving">{{ proxySaving ? '保存中…' : '保存' }}</button>
          <button @click="testProxy" :disabled="proxyTesting">{{ proxyTesting ? '测试中…(约 10-40s)' : '测试代理' }}</button>
          <span v-if="proxyMsg" class="muted">{{ proxyMsg }}</span>
          <span v-if="proxyTestResult" :class="proxyTestResult.ok ? 'okmsg' : 'err'">
            {{ proxyTestResult.ok ? `✅ 通（${proxyTestResult.source} ${proxyTestResult.latency_ms}ms）` : `❌ ${proxyTestResult.error || '失败'}` }}
          </span>
        </div>
      </section>
    <section class="card">
      <h2>数据源管理</h2>
      <p class="hint">以下为<b>交叉验证与备选</b>数据源（仅在主力源缺失时补充/校验）；主力行情请用上方的通达信。</p>
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
      <h2>行情上游（探测择优）</h2>
      <p class="hint">探测各行情数据源的可达性与延迟，择优使用。</p>
      <div class="row">
        <button @click="runProbe" :disabled="busy">探测</button>
      </div>
      <div v-if="probeProgress" class="probe-progress">
        探测中… {{ probeProgress.done }}/{{ probeProgress.total }}
        <div class="bar"><div class="fill" :style="{ width: (probeProgress.total ? probeProgress.done / probeProgress.total * 100 : 0) + '%' }"></div></div>
      </div>
      <ul v-if="providers.length" class="probe-list">
        <li v-for="p in providers" :key="p.key">
          {{ p.label }}：<span :class="p.reachable ? 'probe-ok' : 'probe-bad'">{{ p.reachable ? '可达' : '不可达' }}</span>
          <span v-if="p.latencyMs != null"> · {{ p.latencyMs }}ms</span>
          <span v-if="p.error" class="probe-bad"> · {{ p.error }}</span>
        </li>
      </ul>
    </section>
    </div>

    <div v-show="tab === 'sync'">
    <section class="card">
      <h2>股票库（本地全量 A 股）</h2>
      <p class="hint">代码 + 名称 + 拼音首字母存本地，用于自由查询的快速搜索。后台同步，可手动触发更新（增量对比增删改）。</p>
      <div class="row">
        <span>最后成功：{{ fmtCN(jobs.stock_universe?.last_success_at) }}</span>
        <button
          @click="doRun('stock_universe')"
          :disabled="!canRun('stock_universe')"
          :title="runDisabledTitle('stock_universe')"
        >立即更新</button>
        <button
          v-if="isAdmin && jobs.stock_universe?.state === 'running'"
          @click="doCancel('stock_universe')"
        >取消</button>
        <button
          v-if="isAdmin && jobs.stock_universe?.state === 'running'"
          class="danger"
          @click="doForceStop('stock_universe')"
        >⛔ 强制中止</button>
        <button v-if="isAdmin" @click="showLog('stock_universe')">查看日志</button>
      </div>
      <div v-if="jobs.stock_universe?.state === 'running'" class="muted">
        {{ jobs.stock_universe.message }}（{{ jobs.stock_universe.done }}/{{ jobs.stock_universe.total }}）
        <div class="pbar"><i :style="{ width: jobPct('stock_universe') + '%' }"></i></div>
      </div>
      <div v-else-if="jobs.stock_universe?.error" class="err">{{ jobs.stock_universe.error }}</div>
      <div v-if="jobs.stock_universe?.source_breakdown" class="muted">来源占比：{{ pct(jobs.stock_universe.source_breakdown) }}</div>
      <div v-if="jobLogLines.stock_universe.length" class="logpanel">
        <div v-for="(l, i) in jobLogLines.stock_universe" :key="i" :class="['logline', 'log-' + l.level]">
          <span class="logts">{{ fmtCN(l.ts) }}</span> <span class="loglvl">{{ l.level }}</span> {{ l.message }}
        </div>
      </div>
    </section>

    <section class="card">
      <h2>行情数据（本地）</h2>
      <p class="hint">后台批量把全量 A 股的日线行情拉到本地缓存，分析时直接读本地、不再实时联网。每天晚上自动增量更新；可手动触发。</p>
      <div class="row">
        <span>最后成功：{{ fmtCN(jobs.eod?.last_success_at) }}</span>
        <button
          @click="doRun('eod')"
          :disabled="!canRun('eod')"
          :title="runDisabledTitle('eod')"
        >立即更新</button>
        <button
          v-if="isAdmin && jobs.eod?.state === 'running'"
          @click="doCancel('eod')"
        >取消</button>
        <button
          v-if="isAdmin && jobs.eod?.state === 'running'"
          class="danger"
          @click="doForceStop('eod')"
        >⛔ 强制中止</button>
        <button v-if="isAdmin" @click="showLog('eod')">查看日志</button>
      </div>
      <div v-if="jobs.eod?.state === 'running'" class="muted">
        {{ jobs.eod.message }}（{{ jobs.eod.done }}/{{ jobs.eod.total }}）
        <div class="pbar"><i :style="{ width: jobPct('eod') + '%' }"></i></div>
      </div>
      <div v-else-if="jobs.eod?.error" class="err">{{ jobs.eod.error }}</div>
      <div v-if="jobs.eod?.source_breakdown" class="muted">来源占比：{{ pct(jobs.eod.source_breakdown) }}</div>
      <div v-if="jobLogLines.eod.length" class="logpanel">
        <div v-for="(l, i) in jobLogLines.eod" :key="i" :class="['logline', 'log-' + l.level]">
          <span class="logts">{{ fmtCN(l.ts) }}</span> <span class="loglvl">{{ l.level }}</span> {{ l.message }}
        </div>
      </div>
    </section>

    <section class="card">
      <h2>数据采集</h2>
      <div class="row">
        <button @click="refreshMarket" :disabled="busy">刷新大盘/情绪数据</button>
        <button @click="collectNews" :disabled="busy">采集热点新闻</button>
      </div>
      <p v-if="collectMsg" :class="collectOk ? 'ok-msg' : 'err'">{{ collectMsg }}</p>
      <ul v-if="newsLog.length" class="news-log">
        <li v-for="n in newsLog" :key="n.id">
          <a href="#" @click.prevent="showNewsContent(n.content_id)">{{ n.title }}</a>
          <span class="muted"> · {{ fmtCN(n.collected_at) }}</span>
          <span v-if="n.adopted" class="adopted">已采用</span>
        </li>
      </ul>
      <div v-if="openNews" class="news-content">
        <div class="nc-head"><b>{{ openNews.title }}</b><button class="mini" @click="openNews = null">关闭</button></div>
        <p>{{ openNews.content || '（无正文）' }}</p>
      </div>
    </section>
    </div>

    <div v-show="tab === 'tools'">
    <section class="card">
      <h2>上传行情 CSV（通达信导出）</h2>
      <p class="hint">仅在<b>极端情况</b>（数据源都取不到）或需导入<b>特殊 / 自有数据</b>时使用；日常行情走通达信主力源。</p>
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
        <StockPicker placeholder="代码 / 名称 / 拼音，选中即查询" @pick="onPickSnapshot" />
        <button @click="refresh" :disabled="busy">刷新数据源</button>
      </div>
      <div v-if="snap?.realtime" class="rt">
          实时现价：<b>{{ snap.realtime.price }}</b>
          <span class="muted" v-if="snap.realtime.time"> @ {{ snap.realtime.time }}（{{ snap.realtime.source }}）</span>
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
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { dataApi, type StockSnapshot, type DataSource, type ProxyConfig } from '../api/data';
import StockPicker from '../components/StockPicker.vue';
import { useAuthStore } from '../stores/auth';
import { fmtCN, fmtCNDate } from '../utils/time';

const authStore = useAuthStore();
const isAdmin = computed(() => authStore.isAdmin);

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

function onPickSnapshot(c: string) {
  code.value = c;
  lookup();
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

const collectMsg = ref('');
const collectOk = ref(false);
const showTdxHelp = ref(false);

const newsLog = ref<Array<{ id: string; content_id: string; title: string; source: string; collected_at: string; adopted: number }>>([]);
const openNews = ref<{ title: string; content: string } | null>(null);
async function loadNewsLog() { newsLog.value = await dataApi.newsLog(50); }
async function showNewsContent(id: string) { openNews.value = await dataApi.newsContent(id); }

async function refreshMarket() {
  busy.value = true; collectMsg.value = '';
  try {
    const res = await dataApi.refresh();
    const ok = res.data?.data?.marketRefreshed;
    collectOk.value = !!ok;
    collectMsg.value = ok
      ? '大盘/情绪数据已刷新'
      : '未取到大盘数据：数据源暂不可达。请到「数据源」标签测速选用通达信服务器后重试（涨停/跌停依赖东方财富，该源不通时取不到）。';
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
    await dataApi.refreshNews();
    await loadNewsLog();
    collectOk.value = true; collectMsg.value = '已采集，日志已刷新';
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
  await dataApi.updateSource(s.id, { enabled: s.enabled === 1 ? 0 : 1 });
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

// ---- TDX server management ----
const tdxCurrent = ref('');
const tdxServers = ref<Array<{ site: string; addr: string; port: number; ok: boolean; latency_ms: number | null }>>([]);
const tdxTesting = ref(false);
async function loadTdxCurrent() {
  try { tdxCurrent.value = await dataApi.tdxGetServer(); } catch { /* ignore */ }
}

// ---- 出站代理（仅 admin）----
const proxy = reactive<ProxyConfig>({ enabled: false, scheme: 'http', host: '', port: 0, username: '', password: '' });
const proxySaving = ref(false);
const proxyTesting = ref(false);
const proxyMsg = ref('');
const proxyTestResult = ref<{ ok: boolean; latency_ms: number; source: string | null; error: string | null } | null>(null);
async function loadProxy() {
  if (!isAdmin.value) return;
  try { Object.assign(proxy, (await dataApi.getProxy()).config); } catch { /* ignore */ }
}
async function saveProxy() {
  proxySaving.value = true; proxyMsg.value = '';
  try { const r = await dataApi.setProxy({ ...proxy }); proxyMsg.value = r.live ? '已保存并生效' : '已保存（重启后生效）'; }
  catch (e: any) { proxyMsg.value = e.response?.data?.message || '保存失败'; }
  finally { proxySaving.value = false; }
}
async function testProxy() {
  proxyTesting.value = true; proxyTestResult.value = null;
  try { proxyTestResult.value = await dataApi.testProxy({ ...proxy }); }
  catch (e: any) { proxyTestResult.value = { ok: false, latency_ms: 0, source: null, error: e.response?.data?.message || '测试失败' }; }
  finally { proxyTesting.value = false; }
}
async function testTdx() {
  tdxTesting.value = true;
  try { tdxServers.value = await dataApi.tdxTestServers(); } catch { /* ignore */ } finally { tdxTesting.value = false; }
}
async function pickTdx(addr: string, port: number) {
  try { tdxCurrent.value = await dataApi.tdxSetServer(addr, port); } catch { /* ignore */ }
}

// ---- upstream probe ----
const providers = ref<Array<{ key: string; label: string; reachable: boolean; latencyMs: number | null; error: string | null }>>([]);
const probeProgress = ref<{ done: number; total: number } | null>(null);
async function runProbe() {
  busy.value = true;
  providers.value = [];
  try {
    const list = await dataApi.probeList('quote');
    probeProgress.value = { done: 0, total: list.length };
    for (const it of list) {
      const r = await dataApi.probeOne('quote', it.key);
      providers.value.push(r ?? { key: it.key, label: it.label, reachable: false, latencyMs: null, error: '探测失败' });
      probeProgress.value.done++;
    }
  } finally {
    busy.value = false;
    probeProgress.value = null;
  }
}

// ---- shared job governance (stock_universe + eod) ----
interface JobStatus {
  state: string;
  total: number;
  done: number;
  message: string | null;
  updated_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_success_at: string | null;
  started_by: string | null;
  error: string | null;
  cancel_requested: number;
  source_breakdown: Record<string, number> | null;
}
const jobs = reactive<Record<string, JobStatus | null>>({ stock_universe: null, eod: null });
const tab = ref<'source' | 'sync' | 'tools'>('source'); // 二级标签：数据源 / 同步状态 / 工具
const anySyncing = computed(
  () => jobs.stock_universe?.state === 'running' || jobs.eod?.state === 'running'
);
const jobLogLines = reactive<Record<string, Array<{ ts: string; level: string; message: string }>>>({ stock_universe: [], eod: [] });
let jobTimer: ReturnType<typeof setInterval> | null = null;

// 点击「立即更新」后记录启动时刻；宽限期内若服务端还没标 running，不把乐观的「启动中」降级（防进度条闪一下消失）。
const pendingStart = reactive<Record<string, number>>({});
async function refreshJob(job: 'stock_universe' | 'eod') {
  try {
    const st = await dataApi.jobStatus(job);
    const since = pendingStart[job];
    if (since) {
      if (st?.state === 'running') { delete pendingStart[job]; }            // 服务端确认在跑
      else if (Date.now() - since < 8000 && jobs[job]?.state === 'running') return; // 宽限期：保持乐观进度条
      else delete pendingStart[job];                                         // 宽限期过：采用真实状态
    }
    jobs[job] = st;
  } catch { /* ignore */ }
}

function pct(b: Record<string, number> | null) {
  return b ? Object.entries(b).map(([k, v]) => `${k} ${v}%`).join('、') : '';
}

// 只有「正在运行」才禁止再次更新；今日已成功也可再点（增量取数，负担小）。
function canRun(job: 'stock_universe' | 'eod') {
  return jobs[job]?.state !== 'running';
}

function runDisabledTitle(job: 'stock_universe' | 'eod') {
  return jobs[job]?.state === 'running' ? '任务正在运行中' : '';
}

async function doRun(job: 'stock_universe' | 'eod') {
  // 乐观:点击立刻显示进度条/「启动中…」,不被随后的早轮询降级(宽限期由 refreshJob 守护)。
  pendingStart[job] = Date.now();
  jobs[job] = { ...(jobs[job] || {}), state: 'running', done: 0, total: jobs[job]?.total || 0, message: '启动中…' } as any;
  try { await dataApi.runJob(job); } catch { /* 409 locked — ignore */ }
  refreshJob(job); // 不 await；被宽限期守护，不会把乐观进度条降级
}

async function doCancel(job: 'stock_universe' | 'eod') {
  try { await dataApi.cancelJob(job); } catch { /* ignore */ }
  refreshJob(job);
}

async function doForceStop(job: 'stock_universe' | 'eod') {
  try { await dataApi.forceStopJob(job); } catch { /* ignore */ }
  await refreshJob(job);
}

async function showLog(job: 'stock_universe' | 'eod') {
  try { jobLogLines[job] = await dataApi.jobLog(job); } catch { /* ignore */ }
}

function jobPct(job: 'stock_universe' | 'eod') {
  const s = jobs[job]; if (!s || !s.total) return 0;
  return Math.round((s.done / s.total) * 100);
}

onBeforeUnmount(() => { if (jobTimer) clearInterval(jobTimer); });

onMounted(async () => {
  await loadSource();
  await loadSources();
  loadTdxCurrent();
  loadProxy();
  await refreshJob('stock_universe');
  await refreshJob('eod');
  runProbe();
  loadNewsLog();
  // 始终刷新两个任务状态（不只在已知 running 时）——这样后台(cron/别处)起的任务，admin 一进页面也能看到进度。
  jobTimer = setInterval(() => {
    (['stock_universe', 'eod'] as const).forEach((j) => refreshJob(j));
  }, 2500);
});
</script>

<style scoped>
.data { max-width: 960px; margin: 0; padding: 0 16px; }
.okmsg { color: var(--accent, #2a8a2a); }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.overview { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 10px 14px; background: #f7faff; border: 1px solid #d6e4ff; border-radius: 8px; margin-top: 12px; font-size: 13px; }
.ov-item { color: #334; }
.ov-item.ok b { color: #389e0d; }
.ov-item.running { color: #d46b08; font-weight: 600; }
.ov-stop { margin-left: 6px; font-size: 12px; color: #fff; background: #e5484d; border: none; border-radius: 5px; padding: 1px 7px; cursor: pointer; }
.ov-item.warn b { color: #cf1322; }
.ov-item.syncing { color: #1677ff; }
.ov-hint { color: #888; margin-left: auto; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
.hint { color: #777; font-size: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.muted { color: #777; font-size: 12px; margin-top: 8px; }
.pbar { height: 6px; background: #eee; border-radius: 3px; margin-top: 6px; overflow: hidden; }
.pbar i { display: block; height: 100%; background: #2a8a2a; transition: width .3s; }
input { padding: 5px; }
.snap { width: 100%; border-collapse: collapse; margin-top: 10px; }
.snap th, .snap td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.snap th { width: 40%; color: #555; }
.snap tr.miss td { color: #c08; }
.err { color: #c00; }
.ok-msg { color: #2a8a2a; }
.news-log { list-style: none; padding: 0; margin: 10px 0 0; max-height: 320px; overflow-y: auto; }
.news-log li { padding: 5px 0; border-top: 1px solid #eee; font-size: 13px; }
.news-log a { color: #34699a; text-decoration: none; }
.news-log a:hover { text-decoration: underline; }
.adopted { display: inline-block; font-size: 11px; background: #e6f7e6; color: #2a8a2a; border-radius: 8px; padding: 1px 7px; margin-left: 6px; }
.news-content { margin-top: 10px; border: 1px solid #d6e4ff; border-radius: 8px; padding: 10px 12px; background: #f7faff; }
.nc-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 14px; }
.news-content p { font-size: 13px; line-height: 1.65; white-space: pre-wrap; margin: 0; color: #333; }
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
.probe-list { padding-left: 16px; margin: 8px 0; font-size: 13px; }
.probe-list li { padding: 3px 0; }
.probe-ok { color: #2a8a2a; font-weight: 600; }
.probe-bad { color: #c00; font-weight: 600; }
.probe-progress { margin: 6px 0; font-size: 13px; color: #666; }
.probe-progress .bar { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin-top: 4px; }
.probe-progress .fill { height: 100%; background: var(--accent, #e5484d); transition: width .2s; }
.logpanel { background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: 8px; margin-top: 8px; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 12px; }
.logline { padding: 2px 0; border-bottom: 1px solid #eee; }
.logts { color: #999; }
.loglvl { display: inline-block; width: 44px; text-transform: uppercase; font-weight: 600; }
.log-error .loglvl { color: #c00; }
.log-warn .loglvl { color: #c80; }
.log-info .loglvl { color: #2a8a2a; }
.danger { color: #cf1322; border-color: #ffccc7; }
</style>
