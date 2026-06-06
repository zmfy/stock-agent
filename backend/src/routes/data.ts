import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { QuoteRow } from '../types';
import * as svc from '../data/service';
import * as sources from '../data/sources-service';
import { resolveSidecarBase, pingHealth } from '../data/sidecar';

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

// ---- data source management ----
// GET /api/data/sources — recommended (built-in) + custom sources, priority order
router.get('/sources', (req: Request, res: Response) => {
  successResponse(res, sources.listSources(req.user!.userId));
});

// GET /api/data/sources/catalog — recommended sources not yet added
router.get('/sources/catalog', (req: Request, res: Response) => {
  successResponse(res, sources.catalog(req.user!.userId));
});

// POST /api/data/sources { name, baseUrl, priority? }
router.post('/sources', (req: Request, res: Response) => {
  const parsed = z.object({ name: z.string().min(1).max(60), baseUrl: z.string().url(), priority: z.number().int().optional() }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '请填写名称和合法的地址(http/https)');
  sources.addSource(req.user!.userId, parsed.data);
  successResponse(res, null, '已添加数据源', 201);
});

// PUT /api/data/sources/:id
router.put('/sources/:id', (req: Request, res: Response) => {
  const parsed = z
    .object({ name: z.string().optional(), baseUrl: z.string().url().optional(), enabled: z.boolean().optional(), priority: z.number().int().optional() })
    .safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  try {
    sources.updateSource(req.user!.userId, req.params.id, parsed.data);
    successResponse(res, null, '已更新');
  } catch {
    errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '数据源不存在');
  }
});

// DELETE /api/data/sources/:id
router.delete('/sources/:id', (req: Request, res: Response) => {
  try {
    sources.deleteSource(req.user!.userId, req.params.id);
    successResponse(res, null, '已删除');
  } catch (e: any) {
    if (e.message === 'BUILTIN') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '内置数据源不可删除（可停用）');
    errorResponse(res, 400, 'BUSINESS_CONFLICT', '删除失败');
  }
});

// ---- stock universe (local code+name+pinyin) ----
// GET /api/data/stocks/search?q=
router.get('/stocks/search', (req: Request, res: Response) => {
  successResponse(res, svc.searchStocks(String(req.query.q || ''), 20));
});

// GET /api/data/stocks/sync-status — background sync progress + local count
router.get('/stocks/sync-status', (_req: Request, res: Response) => {
  successResponse(res, { ...(svc.getSyncStatus() || { state: 'idle' }), count: svc.countStocks() });
});

// POST /api/data/stocks/sync — start an incremental background sync (returns immediately)
router.post('/stocks/sync', (req: Request, res: Response) => {
  void svc.syncStockUniverse(req.user!.userId); // fire-and-forget
  successResponse(res, null, '已在后台开始同步股票库');
});

// ---- EOD batch ingestion (本地行情库) ----
// GET /api/data/eod/status — progress of the daily-quote ingestion job
router.get('/eod/status', (_req: Request, res: Response) => {
  successResponse(res, svc.getSyncStatus('eod') || { state: 'idle' });
});

// POST /api/data/eod/ingest { days?, codes? } — start a background pull (returns immediately)
router.post('/eod/ingest', (req: Request, res: Response) => {
  const parsed = z
    .object({ days: z.number().int().min(1).max(2000).optional(), codes: z.array(z.string()).optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '参数校验失败');
  void svc.ingestEod(req.user!.userId, parsed.data); // fire-and-forget
  successResponse(res, null, '已在后台开始拉取行情数据');
});

// GET /api/data/source — is the sidecar configured + healthy?
router.get('/source', async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  const healthy = base ? await pingHealth(base) : false;
  successResponse(res, { sidecarConfigured: !!base, base, sidecarHealthy: healthy });
});

export default router;
