import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { getActive, tradeableSystems } from '../rulebook/service';
import { getStockSnapshot, listCachedCodes } from '../data/service';
import { evaluateGates } from '../analysis/rule-engine';
import { resolveSidecarBase, fetchHotSectors, fetchSectorStocks } from '../data/sidecar';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { getCorePersona, listProfiles } from '../agent/profiles-service';

const UNIVERSE_CAP = 20;

async function screenAiCall(userId: string, prompt: string, role: string): Promise<string> {
  const cfg = getModelForRole(userId, role) || getModelForRole(userId, 'core');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
  return chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 1200, acct);
}
function personaOf(userId: string, role: string): string {
  return listProfiles(userId).find((p) => p.role === role)?.persona || '';
}

// 选股的多 agent 讨论：数据员说明候选池 → 分析师按原则点评/排序 → 来财给推荐清单与理由。
// 没有可用模型时返回空串（选股结果照常返回，只是没有讨论纪要）。
export async function discussScreen(
  userId: string,
  note: string,
  results: ScreenResult[],
  aiCall: (p: string, role: string) => Promise<string>
): Promise<string> {
  const rb = getActive(userId);
  const persona = getCorePersona(userId);
  const rbText = rb ? `当前策略【${rb.version.version_label}】硬门槛：${rb.gates.map((g) => `${g.system}:${g.label}`).join('、')}。` : '';
  const top = results.slice(0, 12);
  const listText = top.length
    ? top.map((r) => `- ${r.name || r.code}(${r.code})：${r.passedSystems.length ? r.passedSystems.join('/') + ' 通过' : '未过'}，门槛 ${r.passed}/${r.total}`).join('\n')
    : '（本次无候选）';

  const dataOut = (await aiCall(
    `${personaOf(userId, 'data') || '你是数据员，只客观说明。'}\n你是选股会上的【数据员】。本次选股范围：${note}。候选与门槛通过情况：\n${listText}\n请用 2-3 条客观说明候选池来源与门槛通过概况，不下推荐结论。中文、简短。`,
    'data'
  )).trim();
  const analysisOut = (await aiCall(
    `${personaOf(userId, 'analysis') || '你是分析师，严格按原则点评。'}\n你是选股会上的【分析师】。${rbText}\n候选：\n${listText}\n数据员说明：${dataOut}\n请按当前策略点评通过门槛的标的，挑出最值得关注的并排序、给理由（数据缺失/未过门槛的不要推荐）。中文、分点、简短。`,
    'analysis'
  )).trim();
  const coreOut = (await aiCall(
    `${persona}\n你是主 agent「来财」，主持选股讨论。分析师意见：\n${analysisOut}\n请给出今日推荐清单（只从通过门槛的标的里选，没有合适的就直说今日无合适标的）+ 每只一句理由，并说明你采纳了分析师的哪条意见。中文、简短。`,
    'core'
  )).trim();

  return ['🗣 选股讨论', '', '【数据员】候选池概况：', dataOut, '', '【分析师】按原则点评：', analysisOut, '', '———', '🧠 来财推荐：', coreOut].join('\n');
}

export interface ScreenResult {
  code: string;
  name: string | null;
  passedSystems: string[];
  passed: number;
  total: number;
  failed: string[];
  reason: string;
}

export async function screenCode(userId: string, code: string): Promise<ScreenResult> {
  const rb = getActive(userId);
  if (!rb) throw new Error('NO_RULEBOOK');
  const snap = await getStockSnapshot(userId, code);
  const ev = evaluateGates(snap, rb.gates);
  const tradeable = tradeableSystems(rb.positionRules);
  const passedSystems = tradeable.filter((sys) => {
    const veto = ev.gateResults.filter((g) => g.system === sys && g.veto === 1);
    return veto.length > 0 && veto.every((g) => g.status === 'pass');
  });
  const passed = ev.gateResults.filter((g) => g.status === 'pass').length;
  const failed = ev.gateResults.filter((g) => g.status === 'fail').map((g) => g.gate_key);
  let reason: string;
  if (passedSystems.length) {
    const sys = passedSystems[0];
    const passedLabels = ev.gateResults.filter((g) => g.system === sys && g.status === 'pass').map((g) => g.label);
    reason = `入选（${passedSystems.join('、')} 系统）：通过 ${passedLabels.join('、') || '（无明确门槛）'}`;
  } else {
    const blockers = ev.gateResults.filter((g) => g.veto === 1 && g.status !== 'pass').map((g) => `${g.label}${g.status === 'unknown' ? '(数据缺失)' : '(未达标)'}`);
    reason = `未入选：${blockers.join('、') || '无符合系统'}`;
  }
  return { code, name: snap.name, passedSystems, passed, total: ev.gateResults.length, failed, reason };
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
  // qualifying (passedSystems non-empty) first, then by passed-gate count
  return out.sort((a, b) => (b.passedSystems.length ? 1 : 0) - (a.passedSystems.length ? 1 : 0) || b.passed - a.passed);
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

export async function runScreen(
  userId: string,
  opts: { codes?: string[]; top?: number; aiCall?: (p: string, role: string) => Promise<string> } = {}
): Promise<{ note: string; results: ScreenResult[]; discussion: string }> {
  if (!getActive(userId)) throw new Error('NO_RULEBOOK');
  const { codes, note } = await resolveUniverse(userId, opts);
  const results = await screenCodes(userId, codes);
  const aiCall = opts.aiCall || ((p: string, role: string) => screenAiCall(userId, p, role));
  let discussion = '';
  try {
    discussion = await discussScreen(userId, note, results, aiCall);
  } catch {
    discussion = ''; // 没配模型等情况：照常返回结果，只是没有讨论纪要
  }
  const db = getDb();
  db.prepare('INSERT INTO screenings (id, user_id, source_note, results, discussion) VALUES (?, ?, ?, ?, ?)').run(uuidv4(), userId, note, JSON.stringify(results), discussion);
  return { note, results, discussion };
}

// 兼容历史记录:旧版用 aPass/bPass,新版用 passedSystems[]。统一成 passedSystems 后再交给前端。
function normalizeResult(x: any): ScreenResult {
  if (Array.isArray(x?.passedSystems)) return x as ScreenResult;
  const passedSystems: string[] = [];
  if (x?.aPass) passedSystems.push('A');
  if (x?.bPass) passedSystems.push('B');
  return { ...x, passedSystems };
}

export function getLatest(userId: string): { note: string; results: ScreenResult[]; discussion: string; created_at: string } | null {
  const row = getDb()
    .prepare('SELECT source_note, results, discussion, created_at FROM screenings WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(userId) as { source_note: string; results: string; discussion: string | null; created_at: string } | undefined;
  if (!row) return null;
  let results: ScreenResult[] = [];
  try {
    results = (JSON.parse(row.results) as any[]).map(normalizeResult);
  } catch {
    results = [];
  }
  return { note: row.source_note, results, discussion: row.discussion || '', created_at: row.created_at };
}

export function getHistory(userId: string, limit = 20): Array<{ created_at: string; note: string; picks: Array<{ code: string; name: string | null; reason: string }> }> {
  const rows = getDb().prepare('SELECT source_note, results, created_at FROM screenings WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as Array<{ source_note: string; results: string; created_at: string }>;
  return rows.map((r) => {
    let parsed: ScreenResult[] = [];
    try { parsed = JSON.parse(r.results); } catch { /* ignore */ }
    const picks = parsed.filter((x) => (x.passedSystems?.length) || (x as any).aPass || (x as any).bPass).map((x) => ({ code: x.code, name: x.name, reason: x.reason || '' }));
    return { created_at: r.created_at, note: r.source_note, picks };
  });
}
