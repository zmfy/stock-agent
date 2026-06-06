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
    description: 'A 股基本面/行情/涨停跌停数据，由内置 Python 数据服务提供（Plan 5 接入）。',
    defaultConfig: { url: 'http://akshare-mcp:8000/sse' },
    configHint: 'http：MCP 服务的 SSE/HTTP 地址',
  },
  {
    key: 'research',
    kind: 'skill',
    label: 'Research 探索技能',
    description: '帮 agent 做需求探索与方案设计（对标 superpowers 理念）。',
    defaultConfig: {},
  },
  {
    key: 'memory',
    kind: 'skill',
    label: 'Memory 记忆技能',
    description: '帮 agent 长期记忆市场观察、你的操作习惯与历次教训（对标 agentmemory）。',
    defaultConfig: {},
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
    defaultConfig: {},
  },
];

export function getCatalogPlugin(key: string): PluginDef | undefined {
  return CATALOG.find((p) => p.key === key);
}
