<template>
  <div class="register">
    <h1>注册 · 股票小作手</h1>
    <p class="hint">注册需要邀请码。没有邀请码请联系管理员。</p>
    <form @submit.prevent="submit">
      <input v-model="username" placeholder="用户名（≥3位）" autocomplete="username" />
      <input v-model="password" type="password" placeholder="密码（≥6位）" autocomplete="new-password" />
      <input v-model="inviteCode" placeholder="邀请码" />
      <button type="submit">注册</button>
      <p class="err" v-if="error">{{ error }}</p>
      <router-link to="/login">返回登录</router-link>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const inviteCode = ref('');
const error = ref('');

// Prefill the code when arriving via an invite link: /register?code=xxxx
onMounted(() => {
  const c = route.query.code;
  if (typeof c === 'string') inviteCode.value = c;
});

async function submit() {
  error.value = '';
  try {
    await auth.register(username.value, password.value, inviteCode.value || undefined);
    router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.message || '注册失败';
  }
}
</script>

<style scoped>
.register { max-width: 320px; margin: 80px auto; display: flex; flex-direction: column; }
form { display: flex; flex-direction: column; gap: 8px; }
.hint { color: #888; }
.err { color: #c00; }
</style>
