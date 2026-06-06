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

  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/rulebook', rulebookRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/plugins', pluginRoutes);
  app.use('/api/data', dataRoutes);
  app.use('/api/analysis', analysisRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/meetings', meetingsRoutes);
  app.use('/api/screen', screenRoutes);

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
  createApp().listen(PORT, () => {
    console.log(`[stock-agent] backend listening on :${PORT}`);
    startNightlyCron();
    startMeetingsCron();
  });
}
