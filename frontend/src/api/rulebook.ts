import api from './client';

export interface Gate {
  id: string;
  version_id: string;
  system: 'A' | 'B';
  gate_key: string;
  label: string;
  field: string;
  op: string;
  threshold: number | null;
  threshold2: number | null;
  ref_field: string | null;
  unit: string;
  veto: number;
  teach: string;
  sort_order: number;
}

export interface SoftRule {
  id: string;
  version_id: string;
  system: 'A' | 'B';
  text: string;
  teach: string;
}

export interface RulebookVersion {
  id: string;
  user_id: string;
  version_label: string;
  persona: string;
  position_rules: string;
  note: string;
  author: string;
  parent_version_id: string | null;
  is_active: number;
  created_at: string;
}

export interface FullRulebook {
  version: RulebookVersion;
  gates: Gate[];
  softRules: SoftRule[];
  positionRules: Record<string, any>;
}

export interface RulebookDiff {
  personaChanged: boolean;
  gates: {
    added: string[];
    removed: string[];
    changed: { gate_key: string; from: any; to: any }[];
  };
  softRules: { added: string[]; removed: string[] };
  positionRulesChangedKeys: string[];
}

export interface NewVersionPayload {
  versionLabel: string;
  persona: string;
  note?: string;
  parentVersionId?: string | null;
  gates: Array<Omit<Gate, 'id' | 'version_id' | 'sort_order'>>;
  softRules: Array<Pick<SoftRule, 'system' | 'text' | 'teach'>>;
  positionRules: Record<string, any>;
}

export interface TemplateMeta {
  key: string;
  label: string;
  description: string;
  versionLabel: string;
  gateCount: number;
}

export const rulebookApi = {
  getActive: () => api.get<{ data: FullRulebook | null }>('/rulebook/active'),
  getTemplates: () => api.get<{ data: TemplateMeta[] }>('/rulebook/templates'),
  init: (template?: string) => api.post<{ data: FullRulebook }>('/rulebook/init', { template }),
  listVersions: () => api.get<{ data: RulebookVersion[] }>('/rulebook/versions'),
  getVersion: (id: string) => api.get<{ data: FullRulebook }>(`/rulebook/versions/${id}`),
  createVersion: (payload: NewVersionPayload) => api.post<{ data: FullRulebook }>('/rulebook/versions', payload),
  activate: (id: string) => api.post(`/rulebook/versions/${id}/activate`),
  clearActive: () => api.post('/rulebook/clear-active'),
  diff: (id: string, against?: string) =>
    api.get<{ data: RulebookDiff }>(`/rulebook/versions/${id}/diff${against ? `?against=${against}` : ''}`),
  applyTemplate: (template: string) => api.post<{ data: FullRulebook }>('/rulebook/apply-template', { template }),
  composePreview: (keys: string[]) =>
    api.post<{ data: { conflict: boolean; conflictFields: string[]; systems: Array<{ letter: string; key: string; label: string; gateCount: number }>; versionLabel: string } }>('/rulebook/compose-preview', { keys }),
  applyCompose: (keys: string[], sessionId?: string) => api.post<{ data: FullRulebook }>('/rulebook/apply-compose', { keys, sessionId }),
  propose: (body: { instruction?: string; sessionId?: string }) =>
    api.post<{ data: ProposeResult }>('/rulebook/propose', body),
  apply: (versionLabel: string, proposal: any, sessionId?: string) =>
    api.post<{ data: FullRulebook }>('/rulebook/apply', { versionLabel, proposal, sessionId }),
  synthesize: (sessionId: string) =>
    api.post<{ data: SynthesizeResult }>('/rulebook/synthesize', { sessionId }),
};

export interface ProposeResult {
  proposal: any;
  delta: {
    personaChanged: boolean;
    gates: { added: string[]; removed: string[]; changed: { gate_key: string; from: any; to: any }[] };
    softRules: { added: string[]; removed: string[] };
    positionRulesChangedKeys: string[];
  };
  magnitude: 'major' | 'minor';
  currentLabel: string;
  suggestedLabel: string;
}

// 从访谈对话从零合成的整套当前策略（无 delta，走完整预览）
export interface SynthesizeResult {
  proposal: ProposeResult['proposal'];
  suggestedLabel: string;
  fromScratch: true;
}
