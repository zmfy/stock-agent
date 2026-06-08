import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth';
import { successResponse, errorResponse } from '../utils/response';
import { runAnalysis } from '../analysis/orchestrator';
import { listReports, getReport, getLatestReportByCode } from '../analysis/report-service';

const router = Router();
router.use(authMiddleware);

// POST /api/analysis/run { code }
router.post('/run', async (req: Request, res: Response) => {
  const parsed = z.object({ code: z.string().min(1).max(20) }).safeParse(req.body);
  if (!parsed.success) return errorResponse(res, 422, 'VALIDATION_ERROR', '请提供股票代码');
  try {
    const report = await runAnalysis(req.user!.userId, parsed.data.code.trim());
    successResponse(res, report, '分析完成', 201);
  } catch (e: any) {
    // 注：无核心原则时 runAnalysis 不再抛 NO_RULEBOOK，改走通用分析兜底（见 orchestrator）。
    if (e.message === 'NO_MODEL') return errorResponse(res, 400, 'BUSINESS_CONFLICT', '请先在「AI 模型」配置并启用一个可用模型');
    if (e.message === 'DATA_UNTRUSTED') {
      const v = (e as any).validation;
      const miss = v?.missing?.length ? `缺失字段：${v.missing.join('、')}。` : '';
      return errorResponse(res, 400, 'DATA_UNTRUSTED', `数据未通过校验，已阻断分析。${miss}请在「数据」上传该股行情或刷新数据源后重试。`);
    }
    return errorResponse(res, 502, 'UPSTREAM_ERROR', `分析失败：${e.message || '未知错误'}`);
  }
});

// GET /api/analysis/reports
router.get('/reports', (req: Request, res: Response) => {
  successResponse(res, listReports(req.user!.userId));
});

// GET /api/analysis/reports/by-code/:code — latest report for a stock (for 完整报告 直达)
router.get('/reports/by-code/:code', (req: Request, res: Response) => {
  const report = getLatestReportByCode(req.user!.userId, req.params.code);
  if (!report) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '该股票还没有分析报告');
  successResponse(res, report);
});

// GET /api/analysis/reports/:id
router.get('/reports/:id', (req: Request, res: Response) => {
  const report = getReport(req.user!.userId, req.params.id);
  if (!report) return errorResponse(res, 404, 'RESOURCE_NOT_FOUND', '报告不存在');
  successResponse(res, report);
});

export default router;
