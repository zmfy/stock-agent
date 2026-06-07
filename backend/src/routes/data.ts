import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { QuoteRow } from '../types';
import * as svc from '../data/service';
import * as sources from '../data/sources-service';
import { resolveSidecarBase, pingHealth, probe, probeList, probeOne } from '../data/sidecar';
import { listTitleLog, getContent } from '../data/news-log';
import { monthCalendar } from '../data/trade-calendar';

const router = Router();
router.use(authMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Map various (incl. 通达信) column names to canonical fields.
const ALIASES: Record<string, string> = {
  code: 'code', 代码: 'code', 股票代码: 'code', symbol: 'code', ts_code: 'code',
  date: 'date', 日期: 'date', 时间: 'date', trade_date: 'date',
  open: 'open', 开盘: 'open', 开盘价: 'open',
  high: 'high', 最高: 'high', 最高价: 'high',
  low: 'low', 最低: 'low', 最低价: 'low',
  close: 'close', 收盘: 'close', 收盘价: 'close',
  volume: 'volume', 成交量: 'volume', vol: 'volume',
};

function normDate(s: string): string {
  const t = s.trim().replace(/\//g, '-');
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return t;
}
function n(v: string | undefined): number | null {
  if (v === undefined) return null;
  const x = parseFloat(v.replace(/,/g, ''));
  return isFinite(x) ? x : null;
}

export function parseQuotesCsv(text: string, fallbackCode?: string): QuoteRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const header = lines[0].split(delim).map((h) => ALIASES[h.trim()] || h.trim());
  const idx = (f: string) => header.indexOf(f);
  const out: QuoteRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    const code = (idx('code') >= 0 ? cells[idx('code')]?.trim() : fallbackCode) || fallbackCode;
    const date = idx('date') >= 0 ? cells[idx('date')] : undefined;
    if (!code || !date) continue;
    out.push({
      code: code.replace(/^(sh|sz)/i, ''),
      date: normDate(date),
      open: n(cells[idx('open')]),
      high: n(cells[idx('high')]),
      low: n(cells[idx('low')]),
      close: n(cells[idx('close')]),
      volume: n(cells[idx('volume')]),
    });
  }
  return out;
}

// POST /api/data/quotes/csv — upload 通达信/行情 CSV
router.post('/quotes/csv', upload.single('file'), (req: Request, res: Response) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return errorResponse(res, 422, 'VALIDATION_ERROR', '请上传 CSV 文件');
  const rows = parseQuotesCsv(file.buffer.toString('utf8'), (req.query.code as string) || undefined);
  if (!rows.length) return errorResponse(res, 422, 'VALIDATION_ERROR', '未解析到有效行情行（需含日期/收盘列）');
  svc.cacheQuotes(rows, 'csv');
  const codes = [...new Set(rows.map((r) => r.code))];
  successResponse(res, { inserted: rows.length, codes }, '行情已导入');
});

// GET /api/data/snapshot/:code
router.get('/snapshot/:code', async (req: Request, res: Response) => {
  const snap = await svc.getStockSnapshot(req.user!.userId, req.params.code);
  successResponse(res, snap);
});

// POST /api/data/refresh  { code? }
router.post('/refresh', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const marketOk = await svc.refreshMarket(userId);
  let snapshot = null;
  if (req.body?.code) {
    await svc.refreshStock(userId, String(req.body.code)).catch(() => {});
    snapshot = await svc.getStockSnapshot(userId, String(req.body.code));
  }
  successResponse(res, { marketRefreshed: marketOk, snapshot });
});

// GET /api/data/news — cached hot financial news
router.get('/news', (_req: Request, res: Response) => {
  successResponse(res, svc.listNews());
});

// POST /api/data/news/refresh — collect hot news now
router.post('/news/refresh', async (req: Request, res: Response) => {
  const n = await svc.refreshNews(req.user!.userId);
  successResponse(res, { inserted: n, news: svc.listNews() }, n ? '已采集热点新闻' : '未取到新闻（数据源不可用或未启用 AkShare 插件）');
});

// GET /api/data/news/log?limit= — title-level collection log
router.get('/news/log', (req: Request, res: Response) => {
  successResponse(res, listTitleLog(Number(req.query.limit) || 50));
});

// GET /api/data/news/content/:id — full content for a single collected item
router.get('/news/content/:id', (req: Request, res: Response) => {
  const c = getContent(req.params.id);
  if (!c) return errorResponse(res, 404, 'NOT_FOUND', '内容已清理或不存在');
  successResponse(res, c);
});

// GET /api/data/trade-calendar?year=&month= — A 股交易日历（某月每天是否交易日）
router.get('/trade-calendar', (req: Request, res: Response) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  successResponse(res, { year, month, days: monthCalendar(year, month) });
});

// ---- data source management (global: any user reads, admin writes) ----
// GET /api/data/sources — global source list (seed on first access)
router.get('/sources', (_req: Request, res: Response) => {
  sources.ensureSeedGlobal();
  successResponse(res, sources.listSourcesGlobal());
});

// GET /api/data/sources/catalog — recommended sources not yet added globally
router.get('/sources/catalog', (_req: Request, res: Response) => {
  successResponse(res, sources.catalogGlobal());
});

// POST /api/data/sources { name, base_url, priority? }  — admin only
router.post('/sources', adminMiddleware, (req: Request, res: Response) => {
  const parsed = z.object({ name: z.string().min(1).max(60), base_url: z.string().url(), priority: z.number().int().optional() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '请填写名称和合法的地址(http/https)');
  const id = sources.addSourceGlobal(parsed.data);
  successResponse(res, { id }, '已添加数据源', 201);
});

// PUT /api/data/sources/:id — admin only
router.put('/sources/:id', adminMiddleware, (req: Request, res: Response) => {
  const parsed = z
    .object({ name: z.string().optional(), base_url: z.string().url().optional(), enabled: z.number().int().optional(), priority: z.number().int().optional() })
    .safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  sources.updateSourceGlobal(req.params.id, parsed.data);
  successResponse(res, null, '已更新');
});

// DELETE /api/data/sources/:id — admin only
router.delete('/sources/:id', adminMiddleware, (req: Request, res: Response) => {
  sources.deleteSourceGlobal(req.params.id);
  successResponse(res, null, '已删除');
});

// ---- stock universe (local code+name+pinyin) ----
// GET /api/data/stocks/search?q=
router.get('/stocks/search', (req: Request, res: Response) => {
  successResponse(res, svc.searchStocks(String(req.query.q || ''), 20));
});

// ---- unified job routes: /api/data/<job>/run|status|cancel|log ----
const SHARED_JOBS = new Set(['stock_universe', 'eod']);
function jobName(req: any): string | null { const j = String(req.params.job); return SHARED_JOBS.has(j) ? j : null; }

router.post('/:job/run', async (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  if (!svc.canStartJob(job)) return errorResponse(res, 409, 'JOB_LOCKED', '已有用户在更新或今日已更新');
  const u = (req as any).user;
  const startedBy = u.username ?? u.userId;
  if (job === 'stock_universe') svc.syncStockUniverse(u.userId, startedBy);
  else svc.ingestEod(u.userId, { startedBy });
  successResponse(res, { started: true });
});

router.get('/:job/status', (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  successResponse(res, svc.getSyncStatus(job) ?? { state: 'idle', last_success_at: null, cancel_requested: 0 });
});

router.post('/:job/cancel', adminMiddleware, (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  svc.requestCancel(job); successResponse(res, { requested: true });
});

router.post('/:job/force-stop', adminMiddleware, (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  svc.forceStopJob(job);
  successResponse(res, svc.getSyncStatus(job) ?? { state: 'idle', cancel_requested: 0 });
});

router.get('/:job/log', adminMiddleware, (req, res) => {
  const job = jobName(req); if (!job) return errorResponse(res, 400, 'BAD_JOB', '未知任务');
  successResponse(res, svc.getJobLog(job));
});

// GET /api/data/source — is the sidecar configured + healthy?
router.get('/source', async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  const healthy = base ? await pingHealth(base) : false;
  successResponse(res, { sidecarConfigured: !!base, base, sidecarHealthy: healthy });
});

// GET /api/data/probe/list?kind=quote — list available providers (no reachability check)
router.get('/probe/list', async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  if (!base) return successResponse(res, []);
  successResponse(res, await probeList(base, String(req.query.kind || 'quote')));
});

// GET /api/data/probe?kind=quote[&provider=] — probe each upstream provider's reachability
router.get('/probe', async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  if (!base) return successResponse(res, []);
  const kind = String(req.query.kind || 'quote');
  const provider = String(req.query.provider || '');
  successResponse(res, await probe(base, kind, provider));
});

export default router;
