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
          <g opacity="0.95">
            <line x1="40" y1="40" x2="40" y2="120" stroke="#7fe3d8" stroke-width="2"/>
            <rect x="32" y="64" width="16" height="40" rx="2" fill="#ef6b6f"/>
            <line x1="78" y1="30" x2="78" y2="118" stroke="#7fe3d8" stroke-width="2"/>
            <rect x="70" y="50" width="16" height="44" rx="2" fill="#2fd1bf"/>
            <line x1="116" y1="48" x2="116" y2="128" stroke="#7fe3d8" stroke-width="2"/>
            <rect x="108" y="72" width="16" height="34" rx="2" fill="#ef6b6f"/>
            <line x1="154" y1="24" x2="154" y2="110" stroke="#7fe3d8" stroke-width="2"/>
            <rect x="146" y="40" width="16" height="48" rx="2" fill="#2fd1bf"/>
            <polyline points="40,70 78,58 116,80 154,46 200,30" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="200" cy="30" r="4" fill="#fff"/>
          </g>
          <!-- 韭菜 -->
          <g transform="translate(232,40)">
            <path d="M34 100 C30 60 22 40 14 18 C20 36 26 60 28 100 Z" fill="#3fae6a"/>
            <path d="M40 100 C40 54 40 30 40 6 C46 30 48 60 48 100 Z" fill="#4cc278"/>
            <path d="M46 100 C52 62 60 42 70 22 C64 42 58 64 56 100 Z" fill="#3fae6a"/>
            <rect x="26" y="98" width="30" height="14" rx="4" fill="#e7eff6"/>
          </g>
        </svg>
        <p class="tag-mini">—— 一根韭菜，也要做有计划的韭菜 🥬</p>
      </div>
    </section>

    <!-- 右：登录表单 -->
    <section class="panel">
      <form class="card" @submit.prevent="submit">
        <h1>欢迎回来</h1>
        <p class="hint">登录后继续和你的操盘 agent 探讨规则、分析个股。</p>
        <label>用户名
          <input v-model="username" placeholder="用户名" autocomplete="username" />
        </label>
        <label>密码
          <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
        </label>
        <button type="submit" :disabled="loading">{{ loading ? '登录中…' : '登 录' }}</button>
        <p class="err" v-if="error">{{ error }}</p>
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
.hero { flex: 1.1; background: linear-gradient(150deg, #18b3a3 0%, #138e9e 55%, #1b2433 100%); color: #fff; display: flex; align-items: center; justify-content: center; padding: 40px; }
.hero-in { max-width: 440px; }
.logo { font-size: 22px; font-weight: 800; letter-spacing: 0.4px; }
.slogan { font-size: 34px; line-height: 1.25; margin: 22px 0 12px; font-weight: 800; }
.sub { font-size: 14px; opacity: 0.9; line-height: 1.7; margin: 0 0 24px; }
.art { width: 100%; max-width: 360px; display: block; margin: 8px 0; }
.tag-mini { font-size: 13px; opacity: 0.85; margin-top: 4px; }

/* 右侧表单 */
.panel { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px; background: var(--bg); }
.card { width: 100%; max-width: 360px; background: var(--surface); border-radius: 16px; box-shadow: var(--shadow-md); padding: 32px 28px; display: flex; flex-direction: column; gap: 14px; }
.card h1 { margin: 0; font-size: 22px; }
.hint { color: var(--muted); font-size: 13px; margin: 0 0 6px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-soft); }
input { padding: 10px 12px; font-size: 14px; }
button { margin-top: 6px; background: var(--accent); color: #fff; border: none; border-radius: var(--radius-sm); padding: 11px; font-size: 15px; font-weight: 700; letter-spacing: 2px; transition: background 0.15s; }
button:hover:not(:disabled) { background: var(--accent-600); }
button:disabled { opacity: 0.6; cursor: not-allowed; }
.err { color: var(--danger); font-size: 13px; margin: 0; }

@media (max-width: 720px) {
  .login { flex-direction: column; }
  .hero { padding: 32px 24px; }
  .slogan { font-size: 26px; }
  .art { max-width: 280px; }
}
</style>
