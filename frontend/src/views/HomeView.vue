<template>
  <div class="home">
    <h1>股票小作手</h1>
    <p v-if="auth.user">欢迎，{{ auth.user.username }}（{{ auth.user.role }}）</p>
    <nav class="nav">
      <router-link to="/rulebook">核心规则</router-link>
      <router-link to="/ai">AI 模型</router-link>
      <router-link to="/settings">设置 / 修改密码</router-link>
      <button @click="logout">登出</button>
    </nav>

    <!-- 正在使用的插件（只读概览） + 调整入口 -->
    <section class="plugins-card">
      <div class="pc-head">
        <h3>正在使用的能力插件</h3>
        <router-link class="adjust" to="/plugins">调整插件</router-link>
      </div>
      <p class="muted" v-if="!enabled.length">加载中…</p>
      <div class="tags" v-else>
        <span v-for="p in enabled" :key="p.key" class="tag" :class="p.kind">{{ p.label }}</span>
      </div>
      <p class="muted small">默认已为你装好常用插件。一般无需改动；懂的用户可点「调整插件」增减。</p>
    </section>

    <p class="hint">规则管理、选股分析等功能将在后续计划中加入。</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { pluginsApi, type PluginView } from '../api/plugins';

const auth = useAuthStore();
const router = useRouter();
const enabled = ref<PluginView[]>([]);

onMounted(async () => {
  if (!auth.user) auth.fetchMe().catch(() => {});
  try {
    const list = (await pluginsApi.list()).data.data;
    enabled.value = list.filter((p) => p.enabled);
  } catch {
    /* ignore */
  }
});

function logout() {
  auth.logout();
  router.push('/login');
}
</script>

<style scoped>
.home { max-width: 640px; margin: 40px auto; padding: 0 16px; }
.nav { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.plugins-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; margin: 20px 0; }
.pc-head { display: flex; justify-content: space-between; align-items: center; }
.pc-head h3 { margin: 0; font-size: 15px; }
.adjust { font-size: 13px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.tag { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #eef; color: #446; }
.tag.skill { background: #eef7ee; color: #2a8a2a; }
.muted { color: #999; }
.small { font-size: 12px; }
.hint { color: #888; }
</style>
