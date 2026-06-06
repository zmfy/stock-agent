<template>
  <div class="register">
    <h1>注册 · 股票小作手</h1>
    <p class="hint">注册需要邀请码。没有邀请码请联系管理员。</p>
    <form @submit.prevent="submit">
      <input v-model="username" placeholder="用户名（≥3位）" autocomplete="username" />
      <input v-model="nickname" placeholder="昵称（可选，用于显示）" maxlength="30" />
      <input v-model="password" type="password" placeholder="密码（≥6位）" autocomplete="new-password" />
      <input v-model="inviteCode" placeholder="邀请码" />

      <div class="disclaimer">
        <h3>《免责声明》</h3>
        <p>1. 本系统（股票小作手）是个人投资研究的<b>辅助工具</b>，其分析、研判、选股、早/晚会等内容均由 AI 依据你设定的规则与公开数据自动生成，<b>仅供学习与研究参考，不构成任何投资建议、要约或承诺</b>。</p>
        <p>2. 证券市场有风险，投资须谨慎。你依据本系统任何内容做出的买卖决策及由此产生的盈亏与损失，<b>均由你本人独立承担</b>，本系统及其开发者、运营者<b>不承担任何责任</b>。</p>
        <p>3. 系统所用数据可能存在延迟、缺失或错误，AI 生成内容亦可能出错，<b>不保证准确、完整或及时</b>，请自行核实。</p>
        <p>4. 请遵守所在地法律法规，理性投资、量力而行。</p>
      </div>

      <label class="agree">
        <input type="checkbox" v-model="agreed" />
        我已阅读并同意以上《免责声明》
      </label>

      <button type="submit" :disabled="!agreed">注册</button>
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
const nickname = ref('');
const password = ref('');
const inviteCode = ref('');
const agreed = ref(false);
const error = ref('');

onMounted(() => {
  const c = route.query.code;
  if (typeof c === 'string') inviteCode.value = c;
});

async function submit() {
  error.value = '';
  if (!agreed.value) {
    error.value = '请先阅读并同意《免责声明》';
    return;
  }
  try {
    await auth.register(username.value, password.value, inviteCode.value || undefined, nickname.value || undefined, true);
    router.push('/');
  } catch (e: any) {
    error.value = e.response?.data?.message || '注册失败';
  }
}
</script>

<style scoped>
.register { max-width: 420px; margin: 48px auto; display: flex; flex-direction: column; padding: 0 16px; }
form { display: flex; flex-direction: column; gap: 10px; }
.hint { color: #888; }
.disclaimer { background: #fbf6ef; border: 1px solid #e7ddd0; border-radius: 8px; padding: 10px 12px; max-height: 200px; overflow-y: auto; font-size: 12px; line-height: 1.7; color: #5b5043; }
.disclaimer h3 { margin: 0 0 6px; font-size: 14px; color: #4a3b2a; }
.disclaimer p { margin: 4px 0; }
.agree { display: flex; align-items: center; gap: 6px; font-size: 13px; }
button { background: #e5484d; color: #fff; border: none; border-radius: 7px; padding: 10px; font-weight: 700; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.err { color: #c00; }
</style>
