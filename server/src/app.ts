import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import { AppError, notFound } from './lib/errors.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import type { Ctx } from './context.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { sessionRoutes } from './routes/sessions.js';
import { agentRoutes } from './routes/agent.js';
import { dashboardRoutes, notificationRoutes, staffRoutes, settingsRoutes, auditRoutes, integrationRoutes } from './routes/misc.js';
import { ExpiryWorker } from './services/expiry.js';
import { workerRuns } from './db/schema.js';
import { desc, eq } from 'drizzle-orm';

export interface AppOptions {
  /** Disable in tests so repeated logins don't trip the limiter. */
  rateLimitEnabled?: boolean;
  /** Serve the built dashboard from this directory (single-box deployment). */
  staticDir?: string;
}

export function createApp(ctx: Ctx, options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (env.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: env.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:'],
              connectSrc: ["'self'", 'ws:', 'wss:'],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Same-origin requests (the dashboard served by this process, including over
  // the cafe LAN or a VPN) are always allowed; anything else must be listed in
  // CORS_ORIGIN. This runs before `cors` so disallowed origins never get headers.
  app.use((req, _res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch {
      /* fall through to the allow-list check */
    }
    if (env.corsOrigins.includes(origin)) return next();
    next(new AppError(403, 'CORS_DENIED', 'Origin not allowed'));
  });

  app.use(
    cors({
      origin: true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    const runs = await ctx.db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.worker, 'expiry'))
      .orderBy(desc(workerRuns.startedAt))
      .limit(1);
    const lastRun = runs[0];
    res.json({
      ok: true,
      serverTime: ctx.clock.now().toISOString(),
      timezone: 'Asia/Kolkata',
      database: env.databaseUrl.startsWith('postgres') ? 'postgres' : 'pglite',
      expiryWorker: {
        lastRunAt: lastRun?.startedAt.toISOString() ?? null,
        lastStatus: lastRun?.status ?? 'NEVER_RUN',
        lastProcessed: lastRun?.processed ?? 0,
      },
    });
  });

  app.use('/api/auth', authRoutes(ctx, { rateLimitEnabled: options.rateLimitEnabled }));
  app.use('/api/dashboard', dashboardRoutes(ctx));
  app.use('/api/devices', deviceRoutes(ctx));
  app.use('/api/sessions', sessionRoutes(ctx));
  app.use('/api/agent', agentRoutes(ctx));
  app.use('/api/notifications', notificationRoutes(ctx));
  app.use('/api/staff', staffRoutes(ctx));
  app.use('/api/settings', settingsRoutes(ctx));
  app.use('/api/audit', auditRoutes(ctx));
  app.use('/api/integrations', integrationRoutes(ctx));

  app.use('/api', (_req, _res, next) => next(notFound('API route not found')));

  const staticDir = options.staticDir ?? path.resolve(process.cwd(), '../web/dist');
  if (fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);

    if (error instanceof AppError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
      return;
    }

    const pgError = error as { code?: string; cause?: { code?: string } };
    if (pgError?.code === '23505' || pgError?.cause?.code === '23505') {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'That record already exists' } });
      return;
    }

    logger.error('unhandled_error', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong. Check the server log.' },
    });
  });

  return app;
}

export { ExpiryWorker };
