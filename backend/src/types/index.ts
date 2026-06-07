export interface ApiResponse<T = unknown> {
  success: boolean;
  code: string;
  message?: string;
  data?: T;
  meta?: { requestId: string; timestamp: string };
}

export interface JwtPayload {
  userId: string;
  role: 'admin' | 'user';
}

export interface User {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: string;
}

export interface QuoteRow {
  code: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

// Per-stock data snapshot consumed by the rule-engine (field names align with gate.field).
export interface StockSnapshot {
  code: string;
  name: string | null;
  date: string;
  roe_ttm: number | null;
  pe: number | null;
  pb: number | null;
  ps: number | null;
  net_profit: number | null;
  turnover_rate: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  year_high: number | null;
  close: number | null;
  limit_up_count: number | null;
  limit_down_count: number | null;
  sse_ma20_slope: number | null;
  _missing: string[];
  sources?: {
    quote: { source: string; date: string; fetched_at: string } | null;
    fundamentals: { source: string; date: string; fetched_at: string } | null;
    market: { source: string; date: string; fetched_at: string } | null;
    sidecarBase: string | null;
  };
  realtime?: { price: number; time: string; source: string | null } | null;
}

export interface GateResult {
  gate_key: string;
  label: string;
  system: string;
  field: string;
  op: string;
  threshold: number | null;
  threshold2: number | null;
  ref_field: string | null;
  unit: string;
  veto: number;
  actual: number | null;
  status: 'pass' | 'fail' | 'unknown';
  teach: string;
}

export interface SystemVerdict {
  system: string;
  passed: boolean;
  failed: string[];
}

export interface GateEvaluation {
  gateResults: GateResult[];
  systems: SystemVerdict[]; // per-system veto verdict (A/B/C…)
  aVeto: { passed: boolean; failed: string[] };
  bEmotion: { passed: boolean; failed: string[] };
}

export type GateOp = '>=' | '>' | '<=' | '<' | 'between' | 'gt_field';

export interface Gate {
  id: string;
  version_id: string;
  system: string; // 'A' | 'B' | 'C' ... (multi-system rulebooks)
  gate_key: string;
  label: string;
  field: string;
  op: GateOp;
  threshold: number | null;
  threshold2: number | null;
  ref_field: string | null;
  unit: string;
  veto: number; // 1 = 一票否决, 0 = 质量项
  exception_channel: string | null; // JSON
  teach: string;
  sort_order: number;
}

export interface SoftRule {
  id: string;
  version_id: string;
  system: string;
  text: string;
  teach: string;
  sort_order: number;
}

export interface RulebookVersion {
  id: string;
  user_id: string;
  version_label: string;
  persona: string;
  position_rules: string; // JSON
  note: string;
  author: 'user' | 'agent';
  parent_version_id: string | null;
  is_active: number;
  created_at: string;
}

// A version joined with its child rows and parsed position_rules — what the API/UI consume.
export interface FullRulebook {
  version: RulebookVersion;
  gates: Gate[];
  softRules: SoftRule[];
  positionRules: Record<string, unknown>;
}

// Express request augmentation so req.user is typed everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
