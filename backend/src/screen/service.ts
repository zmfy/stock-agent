import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getActive } from '../rulebook/service';
import { getStockSnapshot, listCachedCodes } from '../data/service';
import { evaluateGates } from '../analysis/rule-engine';
import { resolveSidecarBase, fetchHotSectors, fetchSectorStocks } from '../data/sidecar';

const UNIVERSE_CAP = 20;

export interface ScreenResult {
  code: string;
  name: string | null;
  aPass: boolean;
  bPass: boolean;
  passed: number;
  total: number;
  failed: string[];
}

export async function screenCode(userId: string, code: string): Promise<ScreenResult> {
  const rb = getActive(userId);
  if (!rb) throw new Error('NO_RULEBOOK');
  const snap = await getStockSnapshot(userId, code);
  const ev = evaluateGates(snap, rb.gates);
  const aVetoGates = ev.gateResults.filter((g) => g.system === 'A' && g.veto === 1);
  const bVetoGates = ev.gateResults.filter((g) => g.system === 'B' && g.veto === 1);
  // strict: selected only if every veto gate actually PASSES (data-missing -> not selected)
  const aPass = aVetoGates.length > 0 && aVetoGates.every((g) => g.status === 'pass');
  const bPass = bVetoGates.length > 0 && bVetoGates.every((g) => g.status === 'pass');
  const passed = ev.gateResults.filter((g) => g.status === 'pass').length;
  const failed = ev.gateResults.filter((g) => g.status === 'fail').map((g) => g.gate_key);
  return { code, name: snap.name, aPass, bPass, passed, total: ev.gateResults.length, failed };
}

export async function screenCodes(userId: string, codes: string[]): Promise<ScreenResult[]> {
  const unique = [...new Set(codes)].slice(0, UNIVERSE_CAP);
  const out: ScreenResult[] = [];
  for (const code of unique) {
    try {
      out.push(await screenCode(userId, code));
    } catch {
      /* skip a code that errors */
    }
  }
  // qualifying (A or B pass) first, then by passed-gate count
  return out.sort((a, b) => Number(b.aPass || b.bPass) - Number(a.aPass || a.bPass) || b.passed - a.passed);
}

export async function resolveUniverse(
  userId: string,
  opts: { codes?: string[]; top?: number } = {}
): Promise<{ codes: string[]; note: string }> {
  if (opts.codes && opts.codes.length) return { codes: opts.codes, note: '指定股票' };
  const base = resolveSidecarBase(userId);
  if (base) {
    const sectors = await fetchHotSectors(base, opts.top || 5);
    if (sectors && sectors.length) {
      const codes: string[] = [];
      for (const s of sectors) {
        const cons = await fetchSectorStocks(base, s);
        if (cons) codes.push(...cons);
        if (codes.length >= UNIVERSE_CAP) break;
      }
      if (codes.length) return { codes: codes.slice(0, UNIVERSE_CAP), note: `热门板块：${sectors.join('、')}` };
    }
  }
  const cached = listCachedCodes();
  return { codes: cached, note: cached.length ? '（板块数据不可用，回退到已缓存股票池）' : '（暂无可选股票，请先在「数据」上传/刷新或配置数据源）' };
}

export async function runScreen(userId: string, opts: { codes?: string[]; top?: number } = {}): Promise<{ note: string; results: ScreenResult[] }> {
  if (!getActive(userId)) throw new Error('NO_RULEBOOK');
  const { codes, note } = await resolveUniverse(userId, opts);
  const results = await screenCodes(userId, codes);
  const db = getDb();
  db.prepare('INSERT INTO screenings (id, user_id, source_note, results) VALUES (?, ?, ?, ?)').run(uuidv4(), userId, note, JSON.stringify(results));
  return { note, results };
}

export function getLatest(userId: string): { note: string; results: ScreenResult[]; created_at: string } | null {
  const row = getDb()
    .prepare('SELECT source_note, results, created_at FROM screenings WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(userId) as { source_note: string; results: string; created_at: string } | undefined;
  if (!row) return null;
  let results: ScreenResult[] = [];
  try {
    results = JSON.parse(row.results);
  } catch {
    results = [];
  }
  return { note: row.source_note, results, created_at: row.created_at };
}
