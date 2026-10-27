import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { env } from '../env.js';
import { users } from '../db/schema.js';
import { badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { authenticate, hashToken, resolveAuth, revokeAuth } from '../auth/service.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../auth/password.js';
import { readAuthToken, requireAuth } from '../auth/middleware.js';
import { writeAudit } from '../services/audit.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});

export function authRoutes(ctx: Ctx, options: { rateLimitEnabled?: boolean } = {}) {
  const router = Router();

  if (options.rateLimitEnabled !== false) {
    router.use(
      '/login',
      rateLimit({
        windowMs: 60_000,
        limit: env.loginRateLimit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again in a minute.' } },
      }),
    );
  }

  router.post('/login', async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const ip = req.ip ?? null;

    const result = await authenticate(ctx.db, ctx.clock, {
      username: body.username,
      password: body.password,
      userAgent: req.headers['user-agent'] ?? null,
      ip,
      ttlHours: env.sessionTtlHours,
    });

    if (!result) {
      await writeAudit(ctx.db, ctx.clock, {
        actorLabel: body.username,
        action: 'AUTH_LOGIN',
        outcome: 'DENIED',
        detail: { reason: 'invalid_credentials' },
        ip,
      });
      throw unauthorized('Incorrect username or password');
    }

    res.cookie(env.cookieName, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.cookieSecure,
      expires: result.expiresAt,
      path: '/',
    });

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: result.user.id,
      actorLabel: result.user.displayName,
      action: 'AUTH_LOGIN',
      targetType: 'user',
      targetId: result.user.id,
      ip,
    });

    res.json({ user: result.user, expiresAt: result.expiresAt.toISOString() });
  });

  router.post('/logout', async (req, res) => {
    const token = readAuthToken(req);
    if (token) {
      const resolved = await resolveAuth(ctx.db, ctx.clock, token);
      await revokeAuth(ctx.db, ctx.clock, token);
      if (resolved) {
        await writeAudit(ctx.db, ctx.clock, {
          actorUserId: resolved.user.id,
          actorLabel: resolved.user.displayName,
          action: 'AUTH_LOGOUT',
          ip: req.ip ?? null,
        });
      }
    }
    res.clearCookie(env.cookieName, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(ctx), async (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/password', requireAuth(ctx), async (req, res) => {
    const body = parseBody(changePasswordSchema, req.body);
    const actor = req.user!;

    const rows = await ctx.db.select().from(users).where(eq(users.id, actor.id)).limit(1);
    const user = rows[0];
    if (!user) throw unauthorized();

    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) {
      await writeAudit(ctx.db, ctx.clock, {
        actorUserId: actor.id,
        actorLabel: actor.displayName,
        action: 'AUTH_PASSWORD_CHANGE',
        outcome: 'DENIED',
        ip: req.ip ?? null,
      });
      throw forbidden('Current password is incorrect');
    }

    const policy = checkPasswordPolicy(body.newPassword);
    if (!policy.ok) throw badRequest(policy.message ?? 'Password does not meet the policy');

    await ctx.db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: false,
        updatedAt: ctx.clock.now(),
      })
      .where(eq(users.id, actor.id));

    // Invalidate every other session for this account.
    const currentToken = readAuthToken(req);
    const { revokeAllForUser } = await import('../auth/service.js');
    await revokeAllForUser(ctx.db, ctx.clock, actor.id);
    if (currentToken) {
      // Keep the current session usable by re-issuing nothing: just note the logout below.
      void hashToken(currentToken);
    }

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: 'AUTH_PASSWORD_CHANGE',
      targetType: 'user',
      targetId: actor.id,
      ip: req.ip ?? null,
    });

    res.json({ ok: true, message: 'Password updated. Please sign in again.' });
  });

  return router;
}
