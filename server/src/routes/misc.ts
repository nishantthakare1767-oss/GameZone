import { Router } from 'express';
import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { auditLogs, devices, integrations, notifications, users } from '../db/schema.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parseBody, pathParam } from '../lib/validate.js';
import { checkPasswordPolicy, hashPassword } from '../auth/password.js';
import { revokeAllForUser } from '../auth/service.js';
import { dashboardSummary, recentActivity } from '../services/queries.js';
import { SETTING_KEYS, SETTING_DEFAULTS } from '../services/settings.js';
import { listIntegrations } from '../integrations/playstation.js';
import { writeAudit } from '../services/audit.js';
import { REALTIME_EVENTS } from '../realtime.js';

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export function dashboardRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/summary', async (_req, res) => {
    res.json(await dashboardSummary(ctx));
  });

  router.get('/activity', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    res.json({ items: await recentActivity(ctx, limit) });
  });

  return router;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export function notificationRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const unreadOnly = req.query.unreadOnly === 'true';

    const where = unreadOnly ? isNull(notifications.readAt) : undefined;
    const [rows, unread, total] = await Promise.all([
      ctx.db
        .select({ notification: notifications, deviceName: devices.name })
        .from(notifications)
        .leftJoin(devices, eq(devices.id, notifications.deviceId))
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
        .offset(offset),
      ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(isNull(notifications.readAt)),
      ctx.db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(where),
    ]);

    res.json({
      items: rows.map((row) => ({
        id: row.notification.id,
        kind: row.notification.kind,
        severity: row.notification.severity,
        title: row.notification.title,
        message: row.notification.message,
        deviceId: row.notification.deviceId,
        deviceName: row.deviceName,
        sessionId: row.notification.sessionId,
        createdAt: row.notification.createdAt.toISOString(),
        readAt: row.notification.readAt ? row.notification.readAt.toISOString() : null,
      })),
      unreadCount: Number(unread[0]?.count ?? 0),
      total: Number(total[0]?.count ?? 0),
      limit,
      offset,
    });
  });

  router.post('/:id/read', async (req, res) => {
    const now = ctx.clock.now();
    const updated = await ctx.db
      .update(notifications)
      .set({ readAt: now, readByUserId: req.user!.id })
      .where(and(eq(notifications.id, pathParam(req, "id")), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    if (!updated[0]) {
      const exists = await ctx.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.id, pathParam(req, "id")))
        .limit(1);
      if (!exists[0]) throw notFound('Notification not found');
    }
    res.json({ ok: true });
  });

  router.post('/read-all', async (req, res) => {
    const now = ctx.clock.now();
    const updated = await ctx.db
      .update(notifications)
      .set({ readAt: now, readByUserId: req.user!.id })
      .where(isNull(notifications.readAt))
      .returning({ id: notifications.id });
    res.json({ ok: true, count: updated.length });
  });

  return router;
}

/* ------------------------------------------------------------------ */
/* Staff                                                               */
/* ------------------------------------------------------------------ */

const staffCreateSchema = z.object({
  username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore'),
  displayName: z.string().trim().min(2).max(60),
  role: z.enum(['ADMIN', 'STAFF']),
  password: z.string().min(10).max(200),
});

const staffUpdateSchema = z.object({
  displayName: z.string().trim().min(2).max(60).optional(),
  role: z.enum(['ADMIN', 'STAFF']).optional(),
  isActive: z.boolean().optional(),
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(10).max(200),
});

export function staffRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (_req, res) => {
    const rows = await ctx.db.select().from(users).orderBy(asc(users.displayName));
    res.json({
      items: rows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
        createdAt: u.createdAt.toISOString(),
      })),
    });
  });

  router.post('/', requireAdmin, async (req, res) => {
    const body = parseBody(staffCreateSchema, req.body);
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw badRequest(policy.message ?? 'Password does not meet the policy');

    const existing = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${body.username.toLowerCase()}`)
      .limit(1);
    if (existing[0]) throw conflict('USERNAME_TAKEN', 'That username is already in use');

    const inserted = await ctx.db
      .insert(users)
      .values({
        username: body.username,
        displayName: body.displayName,
        role: body.role,
        passwordHash: await hashPassword(body.password),
        mustChangePassword: true,
        createdAt: ctx.clock.now(),
        updatedAt: ctx.clock.now(),
      })
      .returning({ id: users.id });

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: req.user!.id,
      actorLabel: req.user!.displayName,
      action: 'STAFF_CREATE',
      targetType: 'user',
      targetId: inserted[0]!.id,
      detail: { username: body.username, role: body.role },
      ip: req.ip ?? null,
    });

    res.status(201).json({ id: inserted[0]!.id });
  });

  router.patch('/:id', requireAdmin, async (req, res) => {
    const body = parseBody(staffUpdateSchema, req.body);
    const actor = req.user!;
    const rows = await ctx.db.select().from(users).where(eq(users.id, pathParam(req, "id"))).limit(1);
    const user = rows[0];
    if (!user) throw notFound('User not found');

    if (user.id === actor.id && body.isActive === false) {
      throw badRequest('You cannot deactivate your own account');
    }
    if (user.role === 'ADMIN' && (body.role === 'STAFF' || body.isActive === false)) {
      const admins = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.role, 'ADMIN'), eq(users.isActive, true)));
      if (Number(admins[0]?.count ?? 0) <= 1) {
        throw badRequest('At least one active administrator is required');
      }
    }

    await ctx.db
      .update(users)
      .set({
        displayName: body.displayName ?? user.displayName,
        role: body.role ?? user.role,
        isActive: body.isActive ?? user.isActive,
        updatedAt: ctx.clock.now(),
      })
      .where(eq(users.id, user.id));

    if (body.isActive === false) {
      await revokeAllForUser(ctx.db, ctx.clock, user.id);
    }

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: 'STAFF_UPDATE',
      targetType: 'user',
      targetId: user.id,
      detail: { ...body },
      ip: req.ip ?? null,
    });

    res.json({ ok: true });
  });

  router.post('/:id/reset-password', requireAdmin, async (req, res) => {
    const body = parseBody(resetPasswordSchema, req.body);
    const policy = checkPasswordPolicy(body.newPassword);
    if (!policy.ok) throw badRequest(policy.message ?? 'Password does not meet the policy');

    const rows = await ctx.db.select().from(users).where(eq(users.id, pathParam(req, "id"))).limit(1);
    if (!rows[0]) throw notFound('User not found');

    await ctx.db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: true,
        updatedAt: ctx.clock.now(),
      })
      .where(eq(users.id, pathParam(req, "id")));
    await revokeAllForUser(ctx.db, ctx.clock, pathParam(req, "id"));

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: req.user!.id,
      actorLabel: req.user!.displayName,
      action: 'STAFF_PASSWORD_RESET',
      targetType: 'user',
      targetId: pathParam(req, "id"),
      ip: req.ip ?? null,
    });

    res.json({ ok: true });
  });

  return router;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const settingsPatchSchema = z
  .object({
    cafeName: z.string().trim().min(2).max(60).optional(),
    timezone: z.literal('Asia/Kolkata').optional(),
    sessionDurations: z.array(z.number().int().min(5).max(720)).min(1).max(8).optional(),
    minSessionMinutes: z.number().int().min(1).max(720).optional(),
    maxSessionMinutes: z.number().int().min(5).max(1440).optional(),
    maxExtensionMinutes: z.number().int().min(5).max(720).optional(),
    expiringSoonMinutes: z.number().int().min(1).max(60).optional(),
    expiringWarningMinutes: z.number().int().min(1).max(30).optional(),
    deviceOfflineAfterSeconds: z.number().int().min(15).max(3600).optional(),
    agentGraceSeconds: z.number().int().min(0).max(86_400).optional(),
    allowExtensionAfterExpiry: z.boolean().optional(),
    soundNotifications: z.boolean().optional(),
    blockOfflineDeviceSessions: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'No settings supplied');

export function settingsRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (_req, res) => {
    const settings = await ctx.settings.get();
    res.json({
      settings,
      defaults: SETTING_DEFAULTS,
      editableKeys: SETTING_KEYS,
      serverTime: ctx.clock.now().toISOString(),
      timezone: 'Asia/Kolkata',
    });
  });

  router.patch('/', requireAdmin, async (req, res) => {
    const body = parseBody(settingsPatchSchema, req.body);
    const settings = await ctx.settings.update(body, req.user!.id);
    if (settings.minSessionMinutes > settings.maxSessionMinutes) {
      // Keep the stored values consistent.
      await ctx.settings.update(
        { minSessionMinutes: SETTING_DEFAULTS.minSessionMinutes },
        req.user!.id,
      );
      throw badRequest('Minimum session length cannot exceed the maximum');
    }

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: req.user!.id,
      actorLabel: req.user!.displayName,
      action: 'SETTINGS_UPDATE',
      targetType: 'settings',
      detail: { ...body },
      ip: req.ip ?? null,
    });
    ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, {});

    res.json({ settings: await ctx.settings.get() });
  });

  return router;
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

const auditQuerySchema = z.object({
  action: z.string().trim().max(60).optional(),
  actorId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function auditRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx), requireAdmin);

  router.get('/', async (req, res) => {
    const query = parseBody(auditQuerySchema, req.query);
    const conditions: SQL[] = [];
    if (query.action) conditions.push(sql`${auditLogs.action} ilike ${`%${query.action}%`}`);
    if (query.actorId) conditions.push(eq(auditLogs.actorUserId, query.actorId));
    if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(auditLogs.createdAt, new Date(query.to)));
    const where = conditions.length ? and(...conditions) : undefined;

    const [rows, total] = await Promise.all([
      ctx.db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(query.limit ?? 100)
        .offset(query.offset ?? 0),
      ctx.db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(where),
    ]);

    res.json({
      items: rows.map((row) => ({
        id: row.id,
        actorLabel: row.actorLabel,
        actorUserId: row.actorUserId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        outcome: row.outcome,
        detail: row.detail,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      total: Number(total[0]?.count ?? 0),
    });
  });

  return router;
}

/* ------------------------------------------------------------------ */
/* Integrations                                                        */
/* ------------------------------------------------------------------ */

const integrationPatchSchema = z.object({
  enabled: z.boolean().optional(),
  adapter: z.enum(['manual-staff-enforcement', 'http-bridge']).optional(),
  baseUrl: z.string().url().max(300).optional(),
});

export function integrationRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (_req, res) => {
    res.json({ items: await listIntegrations(ctx) });
  });

  router.patch('/:id', requireAdmin, async (req, res) => {
    const body = parseBody(integrationPatchSchema, req.body);
    const rows = await ctx.db.select().from(integrations).where(eq(integrations.id, pathParam(req, "id"))).limit(1);
    const row = rows[0];
    if (!row) throw notFound('Integration not found');

    const config = { ...(row.config as Record<string, unknown>) };
    if (body.adapter) config.adapter = body.adapter;
    if (body.baseUrl) config.baseUrl = body.baseUrl;

    const status =
      (config.adapter as string) === 'http-bridge' ? 'UNVERIFIED' : 'MANUAL_ENFORCEMENT';

    await ctx.db
      .update(integrations)
      .set({
        enabled: body.enabled ?? row.enabled,
        config,
        status,
        updatedAt: ctx.clock.now(),
      })
      .where(eq(integrations.id, row.id));

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: req.user!.id,
      actorLabel: req.user!.displayName,
      action: 'INTEGRATION_UPDATE',
      targetType: 'integration',
      targetId: row.id,
      detail: { ...body, status },
      ip: req.ip ?? null,
    });

    res.json({ items: await listIntegrations(ctx) });
  });

  return router;
}
