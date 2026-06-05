<template>
  <div class="home">
    <h1>股票小作手</h1>
    <p v-if="auth.user">欢迎，{{ auth.user.username }}（{{ auth.user.role }}）</p>
    <button @click="logout">登出</button>
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
