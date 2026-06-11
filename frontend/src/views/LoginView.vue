<template>
  <div class="login">
    <!-- 左：品牌 / 广告语 / 插画 -->
    <section class="hero">
      <div class="hero-in">
        <div class="logo">📈 小作手</div>
        <div class="tagline">您的决策小助手 · v{{ APP_VERSION }}</div>
        <h2 class="slogan">{{ slogan }}</h2>
        <p class="sub">代码算硬门槛，AI 写软判断 —— 有纪律、可审计、会复盘的操盘助手。</p>

        <!-- 内联插画：一棵韭菜 + K 线 -->
        <svg class="art" viewBox="0 0 320 160" fill="none" xmlns="http://www.w3.org/2000/svg">
          <!-- K 线 -->
          <!-- 一路上涨的红色 K 线 -->
          <!-- 多头排列：12 根红柱长短不一，均线穿插（柱在线上 / 线中 / 线下都有） -->
          <g opacity="0.98">
            <line x1="30" y1="114" x2="30" y2="144" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="24" y="120" width="12" height="18" rx="1.5" fill="#e5484d"/>
            <line x1="54" y1="104" x2="54" y2="134" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="48" y="110" width="12" height="18" rx="1.5" fill="#e5484d"/>
            <line x1="78" y1="102" x2="78" y2="122" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="72" y="108" width="12" height="8" rx="1.5" fill="#e5484d"/>
            <line x1="102" y1="90" x2="102" y2="120" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="96" y="96" width="12" height="18" rx="1.5" fill="#e5484d"/>
            <line x1="126" y1="94" x2="126" y2="114" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="120" y="100" width="12" height="8" rx="1.5" fill="#e5484d"/>
            <line x1="150" y1="78" x2="150" y2="110" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="144" y="84" width="12" height="20" rx="1.5" fill="#e5484d"/>
            <line x1="174" y1="74" x2="174" y2="98" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="168" y="80" width="12" height="10" rx="1.5" fill="#e5484d"/>
            <line x1="198" y1="58" x2="198" y2="92" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="192" y="64" width="12" height="22" rx="1.5" fill="#e5484d"/>
            <line x1="222" y1="60" x2="222" y2="82" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="216" y="66" width="12" height="8" rx="1.5" fill="#e5484d"/>
            <line x1="246" y1="44" x2="246" y2="78" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="240" y="50" width="12" height="20" rx="1.5" fill="#e5484d"/>
            <line x1="270" y1="40" x2="270" y2="64" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="264" y="46" width="12" height="10" rx="1.5" fill="#e5484d"/>
            <line x1="294" y1="24" x2="294" y2="58" stroke="rgba(74,59,42,0.35)" stroke-width="1.6"/>
            <rect x="288" y="30" width="12" height="22" rx="1.5" fill="#e5484d"/>
            <polyline points="30,118 54,122 78,120 102,110 126,112 150,100 174,96 198,84 222,80 246,70 270,62 294,54" stroke="#e07a2f" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="294" cy="54" r="4" fill="#e07a2f"/>
          </g>
        </svg>
        <p class="tag-mini">—— 一根韭菜，也要做有计划的韭菜 🥬</p>
      </div>
    </section>

    <!-- 右：登录表单 -->
    <section class="panel">
      <form class="card" @submit.prevent="submit">
        <h1>欢迎回来</h1>
        <p class="hint">登录后继续和你的小作手探讨策略、分析个股。</p>
        <label>用户名
          <input v-model="username" placeholder="用户名" autocomplete="username" />
        </label>
        <label>密码
          <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
        </label>
        <button type="submit" :disabled="loading">{{ loading ? '登录中…' : '登 录' }}</button>
        <p class="err" v-if="error">{{ error }}</p>
        <div class="disclaimer">
          <b>⚠️ 免责声明</b>
          本工具仅为个人投资纪律与复盘的辅助工具，所有分析、判定与建议均由 AI 依据你自设的规则生成，<b>仅供参考，不构成任何投资建议</b>。买卖由你自行决策、盈亏自负。
        </div>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const username = ref('');
const password = ref('');
const error = ref('');
import { APP_VERSION } from '../version';
const loading = ref(false);

const SLOGANS = [
  '一根韭菜，最后的倔强',
  '亏过，但这次有纪律',
  '不预测，只执行你的规则',
  '把冲动交给代码，把判断留给 AI',
];
const slogan = SLOGANS[Math.floor(Math.random() * SLOGANS.length)];

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login { display: flex; min-height: 100vh; }

/* 左侧 hero */
.hero { flex: 1.1; background: linear-gradient(150deg, #fdf5ea 0%, #f5e6cf 55%, #efd8ba 100%); color: #4a3b2a; display: flex; align-items: center; justify-content: center; padding: 40px; }
.hero-in { max-width: 500px; }
.logo { font-size: 22px; font-weight: 800; letter-spacing: 0.4px; }
.tagline { color: var(--muted); font-size: 13px; margin-top: 6px; letter-spacing: 0.3px; }
.slogan { font-size: 28px; line-height: 1.25; margin: 22px 0 12px; font-weight: 800; white-space: nowrap; }
.sub { font-size: 14px; opacity: 0.9; line-height: 1.7; margin: 0 0 24px; }
.art { width: 100%; max-width: 360px; display: block; margin: 8px 0; }
.tag-mini { font-size: 13px; opacity: 0.85; margin-top: 4px; }

/* 右侧表单 */
.panel { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px; background: #fbf6ef; }
.card { width: 100%; max-width: 360px; background: var(--surface); border-radius: 16px; box-shadow: var(--shadow-md); padding: 32px 28px; display: flex; flex-direction: column; gap: 14px; }
.card h1 { margin: 0; font-size: 22px; }
.hint { color: var(--muted); font-size: 13px; margin: 0 0 6px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-soft); }
input { padding: 10px 12px; font-size: 14px; }
.card input:focus { border-color: #e5484d; box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.15); }
button { margin-top: 6px; background: #e5484d; color: #fff; border: none; border-radius: var(--radius-sm); padding: 11px; font-size: 15px; font-weight: 700; letter-spacing: 2px; transition: background 0.15s; }
button:hover:not(:disabled) { background: #d23b40; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
.err { color: var(--danger); font-size: 13px; margin: 0; }
.disclaimer { font-size: 12.5px; color: #9a2843; background: #fdecef; border: 1.5px solid #f0a8bc; border-radius: 8px; padding: 10px 12px; margin: 4px 0 0; line-height: 1.7; }
.disclaimer b { color: #c0143c; }

@media (max-width: 720px) {
  .login { flex-direction: column; }
  .hero { padding: 32px 24px; }
  .slogan { font-size: 22px; white-space: normal; }
  .art { max-width: 280px; }
}
</style>
