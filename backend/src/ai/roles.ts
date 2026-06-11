export type Tier = 'strong' | 'balanced' | 'fast';

export interface RoleDef {
  key: string;
  label: string;
  prefer: Tier; // what kind of model auto-routing prefers for this task
  hint: string;
}

// Task roles. 'core' is the agent's main brain and the fallback for everything else.
export const ROLES: RoleDef[] = [
  { key: 'core', label: '核心助手（主脑/结论/教学）', prefer: 'strong', hint: 'agent 的主脑，下最终结论、做教学' },
  { key: 'data', label: '后台数据取得/解析', prefer: 'fast', hint: '量大不烧脑，用快/便宜的模型' },
  { key: 'analysis', label: '数据分析（跑规则+下判断）', prefer: 'strong', hint: '按当前策略分析、出结论，用强模型' },
  { key: 'qualitative', label: '软料归纳（研报/新闻提炼）', prefer: 'balanced', hint: '把抓回的研报/新闻提炼成要点' },
  { key: 'review', label: '复盘总结', prefer: 'strong', hint: '根据战绩复盘、提议规则优化' },
  { key: 'validation', label: '数据校验', prefer: 'fast', hint: '核验每天取得的数据：上传优先、交叉验证、合理性检查' },
];

export function getRole(key: string): RoleDef | undefined {
  return ROLES.find((r) => r.key === key);
}

// Rough capability tiers for known models (auto-routing only; user can always pin manually).
const TIER: Record<string, Tier> = {
  'deepseek-reasoner': 'strong',
  'deepseek-chat': 'fast',
  'qwen-max': 'strong',
  'qwen-plus': 'balanced',
  'qwen-turbo': 'fast',
  'qwen-long': 'balanced',
  'gpt-4o': 'strong',
  'gpt-4o-mini': 'fast',
  'o3-mini': 'strong',
  'claude-opus-4-8': 'strong',
  'claude-sonnet-4-6': 'strong',
  'claude-haiku-4-5-20251001': 'fast',
  'MiniMax-M2': 'strong',
  'abab6.5s-chat': 'fast',
};

export function tierOf(model: string): Tier {
  return TIER[model] || 'balanced';
}

// Order to search the enabled pool for a given preference.
export function searchOrder(prefer: Tier): Tier[] {
  if (prefer === 'fast') return ['fast', 'balanced', 'strong'];
  if (prefer === 'strong') return ['strong', 'balanced', 'fast'];
  return ['balanced', 'strong', 'fast'];
}
