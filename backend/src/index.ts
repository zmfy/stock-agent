import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { getDb } from './db';
import authRoutes from './routes/auth';
import settingsRoutes from './routes/settings';
import rulebookRoutes from './routes/rulebook';
import aiRoutes from './routes/ai';
import pluginRoutes from './routes/plugins';
import dataRoutes from './routes/data';
import analysisRoutes from './routes/analysis';
import agentRoutes from './routes/agent';
import chatRoutes from './routes/chat';
import meetingsRoutes from './routes/meetings';
import screenRoutes from './routes/screen';
import accountRoutes from './routes/account';

export function createApp(): express.Express {
  const app = express();

  // Ensure DB is initialized.
  getDb();

  // COOP / Origin-Agent-Cluster only apply on HTTPS or localhost; over plain-HTTP LAN
  // access (e.g. http://<wsl-ip>:3000) browsers ignore them and log warnings — drop them.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginOpenerPolicy: false,
      originAgentCluster: false,
    })
  );
  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl) {
    app.use(cors({ origin: frontendUrl, credentials: true }));
  }

  const publicDir = path.join(__dirname, '../public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: { success: false, code: 'RATE_LIMIT', message: '请求过于频繁，请稍后再试' },
  });

  // Throttle LLM-triggering endpoints per IP so a client can't hammer the model (cost + 429 防护).
  const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'test' ? 100000 : Number(process.env.AI_ROUTE_RATE_MAX) || 40,
    message: { success: false, code: 'RATE_LIMIT', message: 'AI 调用过于频繁，请稍后再试' },
  });

  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/rulebook', rulebookRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/plugins', pluginRoutes);
  app.use('/api/data', dataRoutes);
  app.use('/api/analysis', aiLimiter, analysisRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/chat', aiLimiter, chatRoutes);
  app.use('/api/meetings', aiLimiter, meetingsRoutes);
  app.use('/api/screen', aiLimiter, screenRoutes);
  app.use('/api/account', accountRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/*', (_req, res) => {
    res.status(404).json({ success: false, code: 'RESOURCE_NOT_FOUND', message: '接口不存在' });
  });

  app.get('*', (_req, res) => {
    const indexPath = path.join(__dirname, '../public/index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).json({ success: false, code: 'NOT_FOUND', message: '前端尚未构建' });
  });

  return app;
}

// Only start a listener when run directly (not when imported by tests).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startNightlyCron } = require('./cron/nightly');
  const { startMeetingsCron } = require('./cron/meetings');
  const { startSharedDataCron } = require('./cron/shared-data');
  createApp().listen(PORT, () => {
    console.log(`[stock-agent] backend listening on :${PORT}`);
    startNightlyCron();
    startMeetingsCron();
    startSharedDataCron();
    // 启动后同步一次交易日历（失败则 isTradingDay 走周末兜底）。
    const { syncTradeCalendar } = require('./data/trade-calendar');
    const { getDb } = require('./db');
    const admin = getDb().prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (admin) syncTradeCalendar(admin.id).catch(() => {});
    // 重新应用持久化的通达信服务器选择（扛 sidecar 重启）
    const sidecarMod = require('./data/sidecar');
    const { getTdxServerSetting } = require('./data/service');
    if (admin) {
      const sv = getTdxServerSetting();
      if (sv) {
        const [a, p] = sv.split(':');
        const adminId = admin.id;
        // 健壮重推：等 sidecar healthy → 推送 → GET 校验生效 → 重试(最多 ~2 分钟)。
        // 旧版只 fire-and-forget 一次且吞错，常输给 sidecar 启动竞态 → 服务器没推上去 →
        // sidecar 走 bestip(本网络连不通)→ 静默降级到新浪/百度。务必确认推成功。
        (async () => {
          for (let i = 0; i < 24; i++) {
            const base = sidecarMod.resolveSidecarBase(adminId);
            if (base && (await sidecarMod.pingHealth(base).catch(() => false))) {
              try {
                await sidecarMod.tdxSetServer(base, a, Number(p));
                const live = await sidecarMod.tdxGetServerLive(base);
                if (live && live.addr === a && Number(live.port) === Number(p)) {
                  console.log(`[startup] TDX 服务器已应用到 sidecar：${sv}`);
                  return;
                }
              } catch {
                /* retry */
              }
            }
            await new Promise((r) => setTimeout(r, 5000));
          }
          console.warn(`[startup] 未能把 TDX 服务器 ${sv} 应用到 sidecar（已重试 ~2 分钟），将走兜底源`);
        })();
      }
    }
  });
}
