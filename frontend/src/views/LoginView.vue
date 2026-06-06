<template>
  <div class="login">
    <h1>股票小作手</h1>
    <form @submit.prevent="submit">
      <input v-model="username" placeholder="用户名" autocomplete="username" />
      <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
      <button type="submit">登录</button>
      <p class="err" v-if="error">{{ error }}</p>
    </form>
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

async function submit() {
  error.value = '';
  try {
    await auth.login(username.value, password.value);
    router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.message || '登录失败';
  }
}
</script>

<style scoped>
.login { max-width: 320px; margin: 80px auto; display: flex; flex-direction: column; }
form { display: flex; flex-direction: column; gap: 8px; }
.err { color: #c00; }
</style>
