import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { env } from './env.js';
import type { Ctx } from './context.js';
import { resolveAuth } from './auth/service.js';
import { createSocketRealtime } from './realtime.js';
import { logger } from './lib/logger.js';

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=');
      if (index === -1) return [part.trim(), ''];
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }),
  );
}

export function attachRealtime(httpServer: HttpServer, ctx: Ctx) {
  const io = new SocketServer(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    path: '/socket.io',
    serveClient: false,
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token =
        (socket.handshake.auth?.token as string | undefined) ?? cookies[env.cookieName] ?? null;
      if (!token) return next(new Error('unauthorized'));
      const resolved = await resolveAuth(ctx.db, ctx.clock, token);
      if (!resolved) return next(new Error('unauthorized'));
      socket.data.user = resolved.user;
      next();
    } catch (error) {
      logger.warn('socket.auth_failed', { error: String(error) });
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join('dashboard');
    socket.emit('connected', { serverTime: ctx.clock.now().toISOString() });
  });

  return { io, bus: createSocketRealtime(io) };
}
