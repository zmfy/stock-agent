import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { ROLES, getRole } from '../ai/roles';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';

export const PROFILE_ROLES = ['core', 'data', 'analysis', 'qualitative', 'review'] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

const DEFAULT_MAIN_PERSONA =
  '你是用户的主操盘 agent：经验丰富、纪律严明，严格按用户设定的核心原则判断「今天有没有资格、用哪套规则做」，不预测涨跌、不情绪化。';

function defaultPersona(role: string): string {
  if (role === 'core') return DEFAULT_MAIN_PERSONA;
  const r = getRole(role);
  return `你是主 agent 的「${r?.label ?? role}」子助手：${r?.hint ?? ''}。严格服务于主 agent 的核心原则。`;
}

interface ProfileRow {
  role: string;
  persona: string;
  generated: number;
}

export function listProfiles(userId: string): Array<{ role: string; label: string; persona: string; generated: boolean }> {
  const rows = getDb().prepare('SELECT role, persona, generated FROM agent_profiles WHERE user_id = ?').all(userId) as ProfileRow[];
  const byRole = new Map(rows.map((r) => [r.role, r]));
  return PROFILE_ROLES.map((role) => {
    const r = byRole.get(role);
    const label = role === 'core' ? '主 agent' : getRole(role)?.label ?? role;
    return { role, label, persona: r?.persona || defaultPersona(role), generated: !!r?.generated };
  });
}

export function getCorePersona(userId: string): string {
  const row = getDb().prepare("SELECT persona FROM agent_profiles WHERE user_id = ? AND role = 'core'").get(userId) as
    | { persona: string }
    | undefined;
  return row?.persona || DEFAULT_MAIN_PERSONA;
}

export function setProfile(userId: string, role: string, persona: string, generated = false): void {
  if (!(PROFILE_ROLES as readonly string[]).includes(role)) throw new Error('UNKNOWN_ROLE');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM agent_profiles WHERE user_id = ? AND role = ?').get(userId, role) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare('UPDATE agent_profiles SET persona = ?, generated = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      persona,
      generated ? 1 : 0,
      existing.id
    );
  } else {
    db.prepare('INSERT INTO agent_profiles (id, user_id, role, persona, generated) VALUES (?, ?, ?, ?, ?)').run(
      uuidv4(),
      userId,
      role,
      persona,
      generated ? 1 : 0
    );
  }
}

async function defaultAiCall(userId: string, prompt: string): Promise<string> {
  const cfg = getModelForRole(userId, 'core');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  return chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 1200);
}

// Main agent drafts the 4 sub-agent personas from its own persona + role purposes.
export async function generateSubAgents(
  userId: string,
  opts: { aiCall?: (prompt: string) => Promise<string> } = {}
): Promise<Array<{ role: string; persona: string }>> {
  const main = getCorePersona(userId);
  const subs = ROLES.filter((r) => r.key !== 'core');
  const prompt = `主 agent 的人设：${main}

请为下面 ${subs.length} 个子助手各写一段 60 字以内的中文人设，要服务于主 agent 的风格与原则：
${subs.map((r) => `- ${r.key}（${r.label}）：${r.hint}`).join('\n')}

只输出 JSON：{${subs.map((r) => `"${r.key}":"人设"`).join(',')}}`;

  const aiCall = opts.aiCall || ((p: string) => defaultAiCall(userId, p));
  const raw = await aiCall(prompt);
  let parsed: Record<string, string> = {};
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      parsed = JSON.parse(raw.slice(s, e + 1));
    } catch {
      parsed = {};
    }
  }
  const out: Array<{ role: string; persona: string }> = [];
  for (const r of subs) {
    const persona = parsed[r.key] || defaultPersona(r.key);
    setProfile(userId, r.key, persona, true);
    out.push({ role: r.key, persona });
  }
  return out;
}
