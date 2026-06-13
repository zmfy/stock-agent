// 策略生成的共享上下文助手：大盘/板块/规则文本、AI 调用、可生成用户名单、北京日历日。
// （原寄居在 meetings/service.ts，随旧早晚会引擎下线后迁出为中性模块。）
import { getDb } from '../db';
import { getActive } from '../rulebook/service';
import { getLatestMarket } from '../data/service';
import { resolveSidecarBase, fetchHotSectors } from '../data/sidecar';
import { getModelForRole } from '../ai/service';
import { getProvider } from '../ai/providers';
import { chat } from '../ai/manager';
import { lastTradingDayBefore } from '../data/trade-calendar';

export function today(): string {
  // 北京日历日 YYYY-MM-DD（DB 仍存 UTC；此处用于「当天」键，需按北京日界）
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export function marketText(): { text: string; data: any } {
  const m = getLatestMarket();
  if (!m) return { text: '（暂无大盘数据，数据源不可达；请在「数据」页测速选用通达信服务器后重试，勿臆造点位）', data: null };
  const slope = m.sse_ma20_slope;
  const trend = slope === null ? '未知' : slope > 0 ? '向上' : slope < 0 ? '向下' : '走平';
  // 新鲜度：早于「应有的最近交易日」则明确告知陈旧，避免把旧数据当今日。
  const expected = lastTradingDayBefore(today());
  const stale = m.date < expected ? `\n⚠️ 这是截至 ${m.date} 的数据，未取到最新交易日(${expected})；数据源暂不可达，请按此说明，勿当作今日最新。` : '';
  return {
    text: `大盘情绪（${m.date}）：涨停 ${m.limit_up_count ?? '?'} 家、跌停 ${m.limit_down_count ?? '?'} 家、上证20日线斜率 ${slope ?? '?'}（趋势${trend}）。${stale}`,
    data: m,
  };
}

export async function sectorText(userId: string): Promise<{ text: string; sectors: string[] }> {
  const base = resolveSidecarBase(userId);
  let sectors: string[] = [];
  if (base) sectors = (await fetchHotSectors(base, 6).catch(() => null)) || [];
  const text = sectors.length ? `近期热门板块（按涨幅排序）：${sectors.join('、')}。` : '（暂无板块热度数据）';
  return { text, sectors };
}

export function rulebookText(userId: string): string {
  const rb = getActive(userId);
  if (!rb) return '（用户尚未设定当前策略）';
  const gates = rb.gates.map((g) => `${g.system}:${g.label}`).join('、');
  return `当前策略【${rb.version.version_label}】硬门槛：${gates}。`;
}

export async function defaultAiCall(userId: string, prompt: string, role: string): Promise<string> {
  const cfg = getModelForRole(userId, role) || getModelForRole(userId, 'core');
  if (!cfg) throw new Error('NO_MODEL');
  const style = getProvider(cfg.provider)?.apiStyle || 'openai';
  const acct = cfg.scope === 'shared' && cfg.ownerConfigId ? { userId, configId: cfg.ownerConfigId } : undefined;
  return chat(style, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey }, prompt, 1200, acct);
}

// 可自动生成策略的用户：有当前策略(rulebook) + 可用的 core 模型。
export function eligibleUserIds(): string[] {
  const users = getDb().prepare('SELECT id FROM users').all() as { id: string }[];
  return users.filter((u) => getActive(u.id) && getModelForRole(u.id, 'core')).map((u) => u.id);
}
