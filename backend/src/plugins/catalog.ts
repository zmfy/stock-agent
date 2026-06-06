export type PluginKind = 'mcp' | 'skill';
export type Transport = 'stdio' | 'http';

export interface PluginDef {
  key: string;
  kind: PluginKind;
  label: string;
  description: string;
  recommended?: boolean;
  transport?: Transport; // mcp only
  defaultConfig: Record<string, unknown>;
  configHint?: string;
}

// Built-in capability catalog. Users enable + configure these per-account; they can also
// add custom plugins. The agent (Plan 5/6) reads the enabled set to connect/use them.
export const CATALOG: PluginDef[] = [
  {
    key: 'playwright',
    kind: 'mcp',
    transport: 'stdio',
    label: 'Playwright 浏览器',
    description: '让 agent 浏览网页、抓取研报/机构评级/新闻等动态页面。',
    defaultConfig: { command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} },
    configHint: 'stdio：command + args + env',
  },
  {
    key: 'akshare-data',
    kind: 'mcp',
    transport: 'http',
    label: 'AkShare A股数据源',
    description: 'A 股基本面/行情/涨停跌停数据，由内置 Python 数据服务（akshare-mcp）提供。',
    defaultConfig: { url: 'http://akshare-mcp:8000' },
    configHint: 'http：数据服务的基础地址（默认指向内置 akshare-mcp 容器）',
  },
  {
    key: 'research',
    kind: 'skill',
    label: 'Research 探索技能',
    description: '帮 agent 做需求探索与方案设计：下结论前先澄清关键前提、列出假设与不确定点。',
    defaultConfig: { clarify_before_conclusion: true, max_followup_questions: 2, list_assumptions: true },
    configHint: 'clarify_before_conclusion：下结论前先澄清关键前提；max_followup_questions：一次最多追问几个问题；list_assumptions：结论后是否列出关键假设/不确定点',
  },
  {
    key: 'memory',
    kind: 'skill',
    label: 'Memory 记忆技能',
    description: '帮 agent 长期记忆市场观察、你的操作习惯与历次教训，并在讨论时主动复用。',
    defaultConfig: {
      capture: ['市场观察', '操作习惯', '历次教训', '规则变更'],
      recall_scenes: ['早会', '个股分析', '复盘'],
      retention_days: 180,
      max_items: 200,
    },
    configHint: 'capture：记录哪些类型；recall_scenes：在哪些场景主动调用记忆；retention_days：记忆保留天数；max_items：最多记多少条',
  },
  {
    key: 'fetch',
    kind: 'mcp',
    transport: 'stdio',
    recommended: true,
    label: 'Fetch 网页抓取（推荐）',
    description: '轻量抓取静态网页内容，补充 Playwright。',
    defaultConfig: { command: 'npx', args: ['-y', 'mcp-server-fetch'], env: {} },
  },
  {
    key: 'sequential-thinking',
    kind: 'skill',
    recommended: true,
    label: '分步推理技能（推荐）',
    description: '让 agent 把复杂分析分步拆解，减少跳步出错。',
    defaultConfig: { max_steps: 6, show_steps: false, trigger: '复杂问题' },
    configHint: 'max_steps：最多拆几步；show_steps：是否在回复里展示推理步骤；trigger：触发条件（复杂问题 / 总是 / 从不）',
  },
];

export function getCatalogPlugin(key: string): PluginDef | undefined {
  return CATALOG.find((p) => p.key === key);
}
