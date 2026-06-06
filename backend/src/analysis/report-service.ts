import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';

export interface ReportInput {
  userId: string;
  stockCode: string;
  stockName: string | null;
  rulebookVersionId: string | null;
  dataDate: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  snapshot: unknown;
  gateResults: unknown;
  softFindings: unknown;
  aConclusion: string;
  bConclusion: string;
  exceptionChannel: string | null;
  positionSuggestion: string;
  oneLiner: string;
  teachNotes: unknown;
  rawAiResponse: string;
}

export function saveReport(r: ReportInput): string {
  const id = uuidv4();
  getDb()
    .prepare(
      `INSERT INTO reports (id, user_id, stock_code, stock_name, rulebook_version_id, data_date,
        ai_provider, ai_model, snapshot, gate_results, soft_findings, a_conclusion, b_conclusion,
        exception_channel, position_suggestion, one_liner, teach_notes, raw_ai_response)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, r.userId, r.stockCode, r.stockName, r.rulebookVersionId, r.dataDate,
      r.aiProvider, r.aiModel, JSON.stringify(r.snapshot), JSON.stringify(r.gateResults),
      JSON.stringify(r.softFindings ?? []), r.aConclusion, r.bConclusion, r.exceptionChannel,
      r.positionSuggestion, r.oneLiner, JSON.stringify(r.teachNotes ?? []), r.rawAiResponse
    );
  return id;
}

function hydrate(row: any) {
  if (!row) return null;
  const j = (s: string | null) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  return {
    ...row,
    snapshot: j(row.snapshot),
    gate_results: j(row.gate_results),
    soft_findings: j(row.soft_findings),
    teach_notes: j(row.teach_notes),
  };
}

export function listReports(userId: string): any[] {
  return getDb()
    .prepare(
      `SELECT id, stock_code, stock_name, one_liner, ai_provider, ai_model, rulebook_version_id, data_date, created_at
       FROM reports WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId);
}

export function getReport(userId: string, id: string): any | null {
  const row = getDb().prepare('SELECT * FROM reports WHERE id = ? AND user_id = ?').get(id, userId);
  return hydrate(row);
}
