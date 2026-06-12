import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { successResponse } from '../utils/response';
import { resolveSidecarBase, pingHealth } from '../data/sidecar';
import { getMarketStatus } from '../data/market-status';
import { SidecarState } from '../data/alerts';

const router = Router();
router.use(authMiddleware);

router.get('/status', async (req: Request, res: Response) => {
  const base = resolveSidecarBase(req.user!.userId);
  let sidecar: SidecarState;
  if (!base) sidecar = 'unconfigured';
  else sidecar = (await pingHealth(base)) ? 'ok' : 'down';
  successResponse(res, getMarketStatus(Date.now(), sidecar));
});

export default router;
