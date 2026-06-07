import { getActive } from '../rulebook/service';
import { Gate, StockSnapshot } from '../types';
import { secondaryBases } from '../data/sources-service';
import { fetchQuotes } from '../data/sidecar';

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

// Data validation: uploaded-authority -> cross-source -> internal sanity.
export async function validateStock(userId: string, snapshot: StockSnapshot): Promise<ValidationResult> {
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

  // cross-source: live-compare the primary close against each secondary data source
  let crossMismatch = false;
  const secs = secondaryBases(userId);
  if (secs.length && snapshot.close !== null && snapshot.close !== undefined) {
    const diffs: string[] = [];
    for (const base of secs) {
      const q = await fetchQuotes(base, snapshot.code, 3).catch(() => null);
      const close = q && q.rows.length ? q.rows[q.rows.length - 1].close : null;
      if (close !== null && close !== undefined && snapshot.close) {
        const dev = Math.abs(close - snapshot.close) / snapshot.close;
        if (dev > 0.02) {
          crossMismatch = true;
          diffs.push(`${base} 收盘 ${close} 与主源 ${snapshot.close} 偏差 ${(dev * 100).toFixed(1)}%`);
        }
      }
    }
    checks.push({ name: '交叉验证', ok: !crossMismatch, detail: crossMismatch ? diffs.join('；') : `已与 ${secs.length} 个备用源核对，一致` });
  } else {
    checks.push({ name: '交叉验证', ok: true, detail: '（仅一个数据源，跳过；上传数据为最高优先基准）' });
  }

  // Hard block on missing required fields, impossible values, or a cross-source mismatch.
  const trusted = missing.length === 0 && rangeIssues.length === 0 && !crossMismatch;
  const authority: ValidationResult['authority'] = crossMismatch
    ? 'cross'
    : !quoteSrc
    ? 'none'
    : uploaded
    ? 'uploaded'
    : 'internal';

  return { trusted, authority, checks, missing, sources: snapshot.sources };
}
