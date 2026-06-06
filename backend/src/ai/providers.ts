export type ApiStyle = 'openai' | 'anthropic' | 'ollama';

export interface ProviderDef {
  name: string;
  label: string;
  apiStyle: ApiStyle;
  needsApiKey: boolean;
  defaultBaseUrl: string;
  baseUrlEditable: boolean;
  models: string[];
  allowCustomModel: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  {
    name: 'deepseek', label: 'DeepSeek', apiStyle: 'openai', needsApiKey: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1', baseUrlEditable: true,
    models: ['deepseek-chat', 'deepseek-reasoner'], allowCustomModel: true,
  },
  {
    name: 'qwen', label: '通义千问（阿里云）', apiStyle: 'openai', needsApiKey: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', baseUrlEditable: true,
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'], allowCustomModel: true,
  },
  {
    name: 'openai', label: 'OpenAI / ChatGPT', apiStyle: 'openai', needsApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1', baseUrlEditable: true,
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'], allowCustomModel: true,
  },
  {
    name: 'claude', label: 'Anthropic Claude', apiStyle: 'anthropic', needsApiKey: true,
    defaultBaseUrl: 'https://api.anthropic.com', baseUrlEditable: true,
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], allowCustomModel: true,
  },
  {
    name: 'minimax', label: 'MiniMax', apiStyle: 'openai', needsApiKey: true,
    defaultBaseUrl: 'https://api.minimaxi.com/v1', baseUrlEditable: true,
    models: ['MiniMax-M2', 'abab6.5s-chat'], allowCustomModel: true,
  },
  {
    name: 'ollama', label: 'Ollama 本地模型', apiStyle: 'ollama', needsApiKey: false,
    defaultBaseUrl: 'http://localhost:11434', baseUrlEditable: true,
    models: ['qwen2.5', 'llama3.1', 'deepseek-r1'], allowCustomModel: true,
  },
];

export function getProvider(name: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.name === name);
}
