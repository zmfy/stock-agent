<template>
  <div class="login">
    <!-- 左：品牌 / 广告语 / 插画 -->
    <section class="hero">
      <div class="hero-in">
        <div class="logo">📈 股票小作手</div>
        <h2 class="slogan">{{ slogan }}</h2>
        <p class="sub">代码算硬门槛，AI 写软判断 —— 有纪律、可审计、会复盘的操盘助手。</p>

        <!-- 内联插画：一棵韭菜 + K 线 -->
        <svg class="art" viewBox="0 0 320 160" fill="none" xmlns="http://www.w3.org/2000/svg">
          <!-- K 线 -->
          <!-- 一路上涨的红色 K 线 -->
          <g opacity="0.98">
            <line x1="36" y1="124" x2="36" y2="148" stroke="rgba(74,59,42,0.3)" stroke-width="2"/>
            <rect x="28" y="126" width="16" height="18" rx="2" fill="#e5484d"/>
            <line x1="84" y1="104" x2="84" y2="132" stroke="rgba(74,59,42,0.3)" stroke-width="2"/>
            <rect x="76" y="106" width="16" height="22" rx="2" fill="#e5484d"/>
            <line x1="132" y1="82" x2="132" y2="112" stroke="rgba(74,59,42,0.3)" stroke-width="2"/>
            <rect x="124" y="84" width="16" height="24" rx="2" fill="#e5484d"/>
            <line x1="180" y1="60" x2="180" y2="92" stroke="rgba(74,59,42,0.3)" stroke-width="2"/>
            <rect x="172" y="62" width="16" height="26" rx="2" fill="#e5484d"/>
            <line x1="228" y1="38" x2="228" y2="72" stroke="rgba(74,59,42,0.3)" stroke-width="2"/>
            <rect x="220" y="40" width="16" height="28" rx="2" fill="#e5484d"/>
            <polyline points="36,126 84,106 132,84 180,62 228,40 296,16" stroke="#e07a2f" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="296" cy="16" r="4.5" fill="#e07a2f"/>
          </g>
        </svg>
        <p class="tag-mini">—— 一根韭菜，也要做有计划的韭菜 🥬</p>
      </div>
    </section>

    <!-- 右：登录表单 -->
    <section class="panel">
      <form class="card" @submit.prevent="submit">
        <h1>欢迎回来</h1>
        <p class="hint">登录后继续和你的股票小作手探讨规则、分析个股。</p>
        <label>用户名
          <input v-model="username" placeholder="用户名" autocomplete="username" />
        </label>
        <label>密码
          <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
        </label>
        <button type="submit" :disabled="loading">{{ loading ? '登录中…' : '登 录' }}</button>
        <p class="err" v-if="error">{{ error }}</p>
        <p class="risk">⚠️ 投资有风险，本系统仅为研究辅助，不构成投资建议，据此操作盈亏自负。</p>
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
.risk { font-size: 12px; color: #b07; background: #fdecef; border: 1px solid #f6cdd8; border-radius: 7px; padding: 7px 10px; margin: 2px 0 0; line-height: 1.6; }

@media (max-width: 720px) {
  .login { flex-direction: column; }
  .hero { padding: 32px 24px; }
  .slogan { font-size: 22px; white-space: normal; }
  .art { max-width: 280px; }
}
</style>
