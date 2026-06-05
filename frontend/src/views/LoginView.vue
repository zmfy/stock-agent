<template>
  <div class="login">
    <h1>股票小作手</h1>
    <form @submit.prevent="submit">
      <input v-model="username" placeholder="用户名" autocomplete="username" />
      <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" />
      <input v-if="mode === 'register'" v-model="inviteCode" placeholder="邀请码（如需要）" />
      <button type="submit">{{ mode === 'login' ? '登录' : '注册' }}</button>
      <p class="err" v-if="error">{{ error }}</p>
      <a href="#" @click.prevent="toggle">{{ mode === 'login' ? '没有账号？注册' : '已有账号？登录' }}</a>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const mode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const inviteCode = ref('');
const error = ref('');

function toggle() {
  mode.value = mode.value === 'login' ? 'register' : 'login';
  error.value = '';
}

async function submit() {
  error.value = '';
  try {
    if (mode.value === 'login') await auth.login(username.value, password.value);
    else await auth.register(username.value, password.value, inviteCode.value || undefined);
    router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.message || '操作失败';
  }
}
</script>

<style scoped>
.login { max-width: 320px; margin: 80px auto; display: flex; flex-direction: column; }
form { display: flex; flex-direction: column; gap: 8px; }
.err { color: #c00; }
</style>
