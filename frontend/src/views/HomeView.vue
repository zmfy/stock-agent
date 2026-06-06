<template>
  <div class="home">
    <h1>股票小作手</h1>
    <p v-if="auth.user">欢迎，{{ auth.user.username }}（{{ auth.user.role }}）</p>
    <nav class="nav">
      <router-link to="/rulebook">核心规则</router-link>
      <router-link to="/ai">AI 模型</router-link>
      <router-link to="/plugins">能力插件</router-link>
      <router-link to="/settings">设置 / 修改密码</router-link>
      <button @click="logout">登出</button>
    </nav>
    <p class="hint">规则管理、选股分析等功能将在后续计划中加入。</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

onMounted(() => {
  if (!auth.user) auth.fetchMe().catch(() => {});
});

function logout() {
  auth.logout();
  router.push('/login');
}
</script>

<style scoped>
.home { max-width: 640px; margin: 40px auto; }
.hint { color: #888; }
</style>
