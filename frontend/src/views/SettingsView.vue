<template>
  <div class="settings">
    <header class="bar">
      <h1>设置</h1>
      <router-link to="/">返回</router-link>
    </header>

    <!-- ===== 我的账号：修改密码（所有用户） ===== -->
    <section class="card">
      <h2>修改密码</h2>
      <div class="form">
        <input v-model="pwd.current" type="password" placeholder="当前密码" autocomplete="current-password" />
        <input v-model="pwd.next" type="password" placeholder="新密码" autocomplete="new-password" />
        <input v-model="pwd.confirm" type="password" placeholder="确认新密码" autocomplete="new-password" />
        <ul class="rules">
          <li v-for="r in passwordRules(pwd.next)" :key="r.label" :class="r.ok ? 'ok' : 'bad'">
            {{ r.ok ? '✓' : '✗' }} {{ r.label }}
          </li>
          <li :class="pwd.next && pwd.next === pwd.confirm ? 'ok' : 'bad'">
            {{ pwd.next && pwd.next === pwd.confirm ? '✓' : '✗' }} 两次输入一致
          </li>
        </ul>
        <button :disabled="!canChangePwd" @click="submitChangePwd">保存新密码</button>
        <p v-if="pwd.msg" :class="pwd.ok ? 'ok-msg' : 'err'">{{ pwd.msg }}</p>
      </div>
    </section>

    <!-- ===== 数据备份与重置 ===== -->
    <section class="card">
      <h2>数据备份与重置</h2>
      <div class="row">
        <button @click="doBackup" :disabled="acctBusy">立即备份当前数据</button>
        <button class="danger" @click="doReset" :disabled="acctBusy">重新运行设置向导（清空所有数据）</button>
      </div>
      <p class="warnline">⚠️ “重新运行设置向导”会<b>清空你当前的全部数据</b>：核心规则、AI 配置、能力插件、主/子 agent 及其记忆、所有对话与分析报告、早晚会、数据源等。系统会在清空前<b>自动备份一次</b>，可随时恢复。</p>
      <p v-if="acctMsg" :class="acctOk ? 'ok-msg' : 'err'">{{ acctMsg }}</p>

      <table v-if="backups.length" class="bk">
        <thead><tr><th>备份</th><th>时间</th><th>大小</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in backups" :key="b.id">
            <td>{{ b.label }}</td>
            <td class="muted">{{ b.created_at }}</td>
            <td class="muted">{{ Math.round(b.size / 1024) }} KB</td>
            <td class="ops">
              <button @click="doRestore(b)" :disabled="acctBusy">恢复</button>
              <button class="danger" @click="doDeleteBackup(b)" :disabled="acctBusy">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ===== 用户管理（仅管理员） ===== -->
    <section v-if="auth.isAdmin" class="card">
      <div class="card-head">
        <h2>用户管理</h2>
        <button @click="generateInvite" :disabled="invite.loading">生成邀请码</button>
      </div>

      <div v-if="invite.code" class="invite">
        <div>邀请码：<b>{{ invite.code }}</b><span class="muted">（{{ invite.expiry }} 过期）</span></div>
        <div class="invite-link">
          <input :value="invite.url" readonly />
          <button @click="copyInvite">复制邀请链接</button>
          <span v-if="invite.copied" class="ok-msg">已复制</span>
        </div>
      </div>

      <table class="users">
        <thead>
          <tr><th>用户名</th><th>角色</th><th>创建时间</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.username }}</td>
            <td><span :class="['tag', u.role]">{{ u.role === 'admin' ? '管理员' : '普通用户' }}</span></td>
            <td class="muted">{{ u.created_at }}</td>
            <td class="ops">
              <button v-if="u.id !== auth.user?.id" @click="toggleRole(u)">
                {{ u.role === 'admin' ? '降为普通' : '升为管理员' }}
              </button>
              <button @click="openReset(u)">重置密码</button>
              <button v-if="u.id !== auth.user?.id" class="danger" @click="removeUser(u)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 重置密码内联面板 -->
      <div v-if="reset.user" class="reset">
        <h3>重置 {{ reset.user.username }} 的密码</h3>
        <input v-model="reset.password" type="password" placeholder="新密码" autocomplete="new-password" />
        <ul class="rules">
          <li v-for="r in passwordRules(reset.password)" :key="r.label" :class="r.ok ? 'ok' : 'bad'">
            {{ r.ok ? '✓' : '✗' }} {{ r.label }}
          </li>
        </ul>
        <button :disabled="!passwordValid(reset.password)" @click="submitReset">确认重置</button>
        <button @click="reset.user = null">取消</button>
        <p v-if="reset.msg" :class="reset.ok ? 'ok-msg' : 'err'">{{ reset.msg }}</p>
      </div>

      <p v-if="adminError" class="err">{{ adminError }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue';
import { useAuthStore } from '../stores/auth';
import { settingsApi, type AdminUser } from '../api/settings';
import { accountApi, type Backup } from '../api/account';

const auth = useAuthStore();

// ---- 数据备份与重置 ----
const backups = ref<Backup[]>([]);
const acctBusy = ref(false);
const acctMsg = ref('');
const acctOk = ref(false);

async function loadBackups() {
  try { backups.value = (await accountApi.listBackups()).data.data; } catch { /* ignore */ }
}
async function doBackup() {
  acctBusy.value = true; acctMsg.value = '';
  try { await accountApi.backup(); acctOk.value = true; acctMsg.value = '已备份'; await loadBackups(); }
  catch (e: any) { acctOk.value = false; acctMsg.value = e.response?.data?.message || '备份失败'; }
  finally { acctBusy.value = false; }
}
async function doReset() {
  if (!confirm('确定要重新运行设置向导吗？这会清空你当前的全部数据（已自动备份，可恢复）。')) return;
  if (!confirm('再次确认：所有核心规则、AI 配置、agent 及记忆、对话、报告都会被清空。继续？')) return;
  acctBusy.value = true; acctMsg.value = '';
  try {
    await accountApi.reset();
    // hard navigation guarantees the wizard loads fresh from a clean state
    window.location.href = '/onboarding';
  } catch (e: any) {
    acctOk.value = false; acctMsg.value = e.response?.data?.message || '重置失败';
    acctBusy.value = false;
  }
}
async function doRestore(b: Backup) {
  if (!confirm(`从「${b.label}」恢复？当前数据会被该备份覆盖。`)) return;
  acctBusy.value = true; acctMsg.value = '';
  try { await accountApi.restore(b.id); window.location.href = '/'; }
  catch (e: any) { acctOk.value = false; acctMsg.value = e.response?.data?.message || '恢复失败'; acctBusy.value = false; }
}
async function doDeleteBackup(b: Backup) {
  if (!confirm(`删除备份「${b.label}」？`)) return;
  await accountApi.deleteBackup(b.id);
  await loadBackups();
}

// ---- shared password policy (mirrors backend strongPassword) ----
function passwordRules(p: string) {
  return [
    { label: '至少 8 位', ok: p.length >= 8 },
    { label: '含大写字母', ok: /[A-Z]/.test(p) },
    { label: '含小写字母', ok: /[a-z]/.test(p) },
    { label: '含数字', ok: /[0-9]/.test(p) },
    { label: '含特殊字符', ok: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(p) },
  ];
}
function passwordValid(p: string) {
  return passwordRules(p).every((r) => r.ok);
}

// ---- self change password ----
const pwd = reactive({ current: '', next: '', confirm: '', msg: '', ok: false });
const canChangePwd = computed(
  () => !!pwd.current && passwordValid(pwd.next) && pwd.next === pwd.confirm
);
async function submitChangePwd() {
  pwd.msg = '';
  try {
    await auth.changePassword(pwd.current, pwd.next);
    pwd.ok = true;
    pwd.msg = '密码已修改';
    pwd.current = pwd.next = pwd.confirm = '';
  } catch (e: any) {
    pwd.ok = false;
    pwd.msg = e.response?.data?.message || '修改失败';
  }
}

// ---- admin: users ----
const users = ref<AdminUser[]>([]);
const adminError = ref('');
async function loadUsers() {
  try {
    const res = await settingsApi.getUsers();
    users.value = res.data.data;
  } catch (e: any) {
    adminError.value = e.response?.data?.message || '加载用户失败';
  }
}

async function toggleRole(u: AdminUser) {
  adminError.value = '';
  const role = u.role === 'admin' ? 'user' : 'admin';
  try {
    await settingsApi.updateRole(u.id, role);
    u.role = role;
  } catch (e: any) {
    adminError.value = e.response?.data?.message || '修改角色失败';
  }
}

async function removeUser(u: AdminUser) {
  adminError.value = '';
  if (!confirm(`确定删除用户 ${u.username}？`)) return;
  try {
    await settingsApi.deleteUser(u.id);
    users.value = users.value.filter((x) => x.id !== u.id);
  } catch (e: any) {
    adminError.value = e.response?.data?.message || '删除失败';
  }
}

// ---- admin: invite ----
const invite = reactive({ loading: false, code: '', expiry: '', url: '', copied: false });
async function generateInvite() {
  invite.loading = true;
  invite.copied = false;
  try {
    const res = await settingsApi.createInvite();
    invite.code = res.data.data.code;
    invite.expiry = new Date(res.data.data.expiresAt).toLocaleDateString('zh-CN');
    invite.url = `${window.location.origin}/register?code=${invite.code}`;
  } catch (e: any) {
    adminError.value = e.response?.data?.message || '生成邀请码失败';
  } finally {
    invite.loading = false;
  }
}
function copyInvite() {
  const text = invite.url;
  const done = () => { invite.copied = true; };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } finally { document.body.removeChild(ta); }
}

// ---- admin: reset another user's password ----
const reset = reactive({ user: null as AdminUser | null, password: '', msg: '', ok: false });
function openReset(u: AdminUser) {
  reset.user = u;
  reset.password = '';
  reset.msg = '';
}
async function submitReset() {
  if (!reset.user) return;
  reset.msg = '';
  try {
    await settingsApi.resetPassword(reset.user.id, reset.password);
    reset.ok = true;
    reset.msg = '密码已重置';
    reset.password = '';
  } catch (e: any) {
    reset.ok = false;
    reset.msg = e.response?.data?.message || '重置失败';
  }
}

onMounted(async () => {
  if (!auth.user) {
    try { await auth.fetchMe(); } catch { /* ignore */ }
  }
  if (auth.isAdmin) await loadUsers();
  await loadBackups();
});
</script>

<style scoped>
.settings { max-width: 760px; margin: 32px auto; padding: 0 16px; }
.bar { display: flex; justify-content: space-between; align-items: baseline; }
.card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px; margin-top: 16px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.warnline { background: #fff7e6; border: 1px solid #ffe0a3; border-radius: 6px; padding: 8px 10px; font-size: 12px; color: #8a5a00; }
.bk { width: 100%; border-collapse: collapse; margin-top: 8px; }
.bk th, .bk td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; font-size: 13px; }
.bk .ops { display: flex; gap: 6px; }
.muted { color: #999; font-size: 12px; }
.card-head { display: flex; justify-content: space-between; align-items: center; }
.form { display: flex; flex-direction: column; gap: 8px; max-width: 320px; }
.rules { list-style: none; padding: 0; margin: 4px 0; font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
.rules .ok { color: #2a8a2a; }
.rules .bad { color: #aaa; }
.err { color: #c00; }
.ok-msg { color: #2a8a2a; }
.muted { color: #999; font-size: 12px; }
.invite { background: #f7f7f7; padding: 10px; border-radius: 6px; margin: 10px 0; }
.invite-link { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.invite-link input { flex: 1; }
.users { width: 100%; border-collapse: collapse; margin-top: 10px; }
.users th, .users td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 14px; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { padding: 1px 8px; border-radius: 10px; font-size: 12px; }
.tag.admin { background: #fde2e2; color: #c0392b; }
.tag.user { background: #e8eef7; color: #34699a; }
.danger { color: #c00; }
.reset { margin-top: 12px; padding: 12px; border: 1px dashed #ccc; border-radius: 6px; max-width: 320px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
