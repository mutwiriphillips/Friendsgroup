import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { errorHandler } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { membersRouter } from './routes/members.js';
import { meRouter } from './routes/me.js';
import { financeRouter } from './routes/finance.js';
import { adminRouter } from './routes/admin.js';
import { reportsRouter } from './routes/reports.js';
import { filesRouter } from './routes/files.js';
import { memberPortalRouter } from './routes/memberPortal.js';
import { mpesaAdminRouter, mpesaCallbackRouter } from './routes/mpesa.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of the app
  // Photos and ID images are fetched with the member's token and shown from blob: URLs, so img-src must allow blob:.
  app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'img-src': ["'self'", 'data:', 'blob:'] } } }));
  app.use(compression());
  app.use(cors({ origin: config.isProd ? config.appBaseUrl : true }));
  // File-carrying prefixes get a larger body limit (base64 uploads); everything else stays at 1 MB.
  const big = express.json({ limit: '12mb' });
  for (const prefix of ['/api/files', '/api/admin', '/api/me']) app.use(prefix, big);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/members', membersRouter);
  app.use('/api/mpesa', mpesaCallbackRouter);
  app.use('/api/admin/mpesa', mpesaAdminRouter);
  app.use('/api/me', meRouter);
  app.use('/api/me', memberPortalRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built React app (single web service on Render).
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
