import { getActive } from '../rulebook/service';
import { Gate, StockSnapshot } from '../types';

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationResult {
  trusted: boolean;
  authority: 'uploaded' | 'cross' | 'internal' | 'none';
  checks: ValidationCheck[];
  missing: string[];
  sources: StockSnapshot['sources'];
}

const UPLOADED_SOURCES = ['csv', 'tdx', 'upload'];

// Fields a gate needs present to be evaluable.
function gateFields(g: Gate): string[] {
  if (g.op === 'gt_field') return [g.field, g.ref_field || ''].filter(Boolean);
  return [g.field];
}

function isRecent(dateStr: string | undefined | null, days = 10): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr).getTime();
  if (isNaN(d)) return false;
  return Date.now() - d <= days * 24 * 60 * 60 * 1000 + 5 * 24 * 60 * 60 * 1000; // generous (weekends/holidays)
}

// Deterministic data validation: uploaded-authority -> (cross-source slot) -> internal sanity.
export function validateStock(userId: string, snapshot: StockSnapshot): ValidationResult {
  const rb = getActive(userId);
  const checks: ValidationCheck[] = [];
  const snap = snapshot as unknown as Record<string, any>;

  // required veto-gate fields present
  const vetoFields = new Set<string>();
  if (rb) for (const g of rb.gates) if (g.veto === 1) gateFields(g).forEach((f) => vetoFields.add(f));
  const missing = [...vetoFields].filter((f) => snap[f] === null || snap[f] === undefined);
  checks.push({
    name: '关键字段完整性',
    ok: missing.length === 0,
    detail: missing.length ? `缺失：${missing.join('、')}` : '所有一票否决门槛字段齐全',
  });

  // authority: uploaded quote source?
  const quoteSrc = snapshot.sources?.quote?.source || '';
  const uploaded = UPLOADED_SOURCES.includes(quoteSrc);
  checks.push({ name: '数据来源', ok: !!quoteSrc, detail: quoteSrc ? `行情来源 ${quoteSrc}${uploaded ? '（上传，最高优先）' : ''}` : '无行情数据' });

  // recency of the quote
  const qDate = snapshot.sources?.quote?.date;
  const recent = isRecent(qDate);
  checks.push({ name: '数据新鲜度', ok: recent, detail: qDate ? `行情日期 ${qDate}${recent ? '' : '（过旧）'}` : '无行情日期' });

  // light range sanity
  const rangeIssues: string[] = [];
  if (snap.pe !== null && snap.pe !== undefined && snap.pe < 0) rangeIssues.push('PE 为负');
  if (snap.close !== null && snap.close !== undefined && snap.close <= 0) rangeIssues.push('收盘价非正');
  checks.push({ name: '数值合理性', ok: rangeIssues.length === 0, detail: rangeIssues.length ? rangeIssues.join('、') : '数值在合理范围' });

  // cross-source: reserved (quote_daily stores one row per code/date; needs a 2nd source wired)
  checks.push({ name: '交叉验证', ok: true, detail: '（暂未接入第二在线源，跳过；上传数据已作最高优先基准）' });

  // Hard block on missing required fields or impossible values; staleness is surfaced as a warning, not a block.
  const trusted = missing.length === 0 && rangeIssues.length === 0;
  const authority: ValidationResult['authority'] = !quoteSrc ? 'none' : uploaded ? 'uploaded' : 'internal';

  return { trusted, authority, checks, missing, sources: snapshot.sources };
}
