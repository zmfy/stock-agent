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

export type GateOp = '>=' | '>' | '<=' | '<' | 'between' | 'gt_field';

export interface Gate {
  id: string;
  version_id: string;
  system: 'A' | 'B';
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
  system: 'A' | 'B';
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
