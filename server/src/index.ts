import http from 'node:http';
import { createDatabase } from './db/index.js';
import { env } from './env.js';
import { systemClock } from './lib/clock.js';
import { logger } from './lib/logger.js';
import { SettingsService } from './services/settings.js';
import { createApp } from './app.js';
import { attachRealtime } from './socket.js';
import { noopRealtime, type RealtimeBus, REALTIME_EVENTS } from './realtime.js';
import { ExpiryWorker } from './services/expiry.js';
import { ensureDefaultIntegrations } from './integrations/playstation.js';
import { createNotification } from './services/notifications.js';
import type { Ctx } from './context.js';
import { bootstrapSeed } from './seed.js';

async function main() {
  const database = await createDatabase();
  const clock = systemClock;
  const settings = new SettingsService(database.db, clock);

  // A stable indirection so the services can hold the bus before sockets exist.
  let bus: RealtimeBus = noopRealtime;
  const realtime: RealtimeBus = { emit: (event, payload) => bus.emit(event, payload) };

  const ctx: Ctx = { db: database.db, clock, realtime, settings };

  await ensureDefaultIntegrations(ctx);
  await bootstrapSeed(ctx);

  const app = createApp(ctx);
  const server = http.createServer(app);
  const { io, bus: socketBus } = attachRealtime(server, ctx);
  bus = socketBus;

  const worker = new ExpiryWorker(ctx);

  server.listen(env.port, () => {
    const address = server.address();
    logger.info('server.listening', {
      port: typeof address === 'object' && address ? address.port : env.port,
      database: database.kind,
      env: env.nodeEnv,
      worker: env.runWorkers,
    });
  });

  // Recovery: whatever happened while the process was down is settled now.
  const recovery = await worker.runOnce();
  if (recovery.expired > 0) {
    await createNotification(ctx.db, clock, realtime, {
      kind: 'SERVER_RECOVERY',
      severity: 'WARNING',
      title: 'Server recovered overdue sessions',
      message: `${recovery.expired} session(s) expired while the server was offline and were processed on startup.`,
      dedupeKey: `recovery:${new Date().setSeconds(0, 0)}`,
    });
  }
  realtime.emit(REALTIME_EVENTS.workerRun, recovery);

  if (env.runWorkers) worker.start(env.expiryScanIntervalMs);

  const shutdown = async (signal: string) => {
    logger.info('server.shutdown', { signal });
    worker.stop();
    io.close();
    server.close();
    await database.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { reason: String(reason) });
  });
}

main().catch((error) => {
  logger.error('server.start_failed', { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
