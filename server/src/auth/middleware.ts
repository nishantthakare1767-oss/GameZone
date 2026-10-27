import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import type { Actor } from '../context.js';
import { env } from '../env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { findDeviceByCredential, touchCredential } from '../services/devices.js';
import type { Device } from '../db/schema.js';
import { hashToken, resolveAuth } from './service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Actor;
      authSessionId?: string;
      device?: Device;
      deviceCredentialId?: string;
    }
  }
}

export interface AuthDeps {
  db: Db;
  clock: Clock;
}

export function readAuthToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const cookieToken = cookies?.[env.cookieName];
  return cookieToken ?? null;
}

export function requireAuth(deps: AuthDeps): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = readAuthToken(req);
      if (!token) throw unauthorized();
      const resolved = await resolveAuth(deps.db, deps.clock, token);
      if (!resolved) throw unauthorized('Session expired, please sign in again');
      req.user = resolved.user;
      req.authSessionId = resolved.authSessionId;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') {
    next(forbidden('Administrator access required'));
    return;
  }
  next();
}

export function readDeviceToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const alt = req.headers['x-device-token'];
  if (typeof alt === 'string' && alt.length > 0) return alt;
  return null;
}

/** Authenticates a device agent by its hashed bearer token. */
export function requireDevice(deps: AuthDeps): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = readDeviceToken(req);
      if (!token) throw unauthorized('Device token required');
      const found = await findDeviceByCredential(deps.db, hashToken(token));
      if (!found) throw unauthorized('Unknown or revoked device token');
      req.device = found.device;
      req.deviceCredentialId = found.credentialId;
      await touchCredential(deps.db, found.credentialId, deps.clock.now());
      next();
    } catch (error) {
      next(error);
    }
  };
}
