import { Router } from 'express';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { accessControlEvents, deviceCredentials, deviceEvents, devices } from '../db/schema.js';
import { generateEnrollmentCode, generateToken, hashToken } from '../auth/service.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parseBody, pathParam } from '../lib/validate.js';
import { writeAudit } from '../services/audit.js';
import { getDeviceView, listDeviceViews } from '../services/queries.js';
import { assertNoActiveSession, listSessions } from '../services/sessions.js';
import { createNotification } from '../services/notifications.js';
import { REALTIME_EVENTS } from '../realtime.js';

const deviceCreateSchema = z.object({
  name: z.string().trim().min(2).max(40),
  type: z.enum(['PC', 'PLAYSTATION']),
  controlMode: z.enum(['AGENT', 'MANUAL']).optional(),
  accessMethod: z.enum(['SHELL_REPLACE', 'SESSION_LOCK', 'MANUAL']).optional(),
  location: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(500).nullish(),
  offlineGraceSeconds: z.number().int().min(0).max(86_400).nullish(),
  enabled: z.boolean().optional(),
});

const deviceUpdateSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  type: z.enum(['PC', 'PLAYSTATION']).optional(),
  controlMode: z.enum(['AGENT', 'MANUAL']).optional(),
  accessMethod: z.enum(['SHELL_REPLACE', 'SESSION_LOCK', 'MANUAL']).optional(),
  location: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(500).nullish(),
  offlineGraceSeconds: z.number().int().min(0).max(86_400).nullish(),
  enabled: z.boolean().optional(),
  maintenance: z.boolean().optional(),
  clearAgentError: z.boolean().optional(),
});

const maintenanceSchema = z.object({
  maintenance: z.boolean(),
  reason: z.string().trim().max(200).optional(),
});

const ENROLLMENT_TTL_MINUTES = 60;

export function deviceRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    res.json({ items: await listDeviceViews(ctx, { includeArchived }) });
  });

  router.get('/:id', async (req, res) => {
    const view = await getDeviceView(ctx, pathParam(req, "id"));
    if (!view) throw notFound('Device not found');
    res.json(view);
  });

  router.post('/', requireAdmin, async (req, res) => {
    const body = parseBody(deviceCreateSchema, req.body);
    const actor = req.user!;
    const now = ctx.clock.now();

    const duplicate = await ctx.db
      .select({ id: devices.id })
      .from(devices)
      .where(sql`lower(${devices.name}) = ${body.name.toLowerCase()}`)
      .limit(1);
    if (duplicate[0]) throw conflict('DEVICE_NAME_TAKEN', 'A device with that name already exists');

    const type = body.type;
    const controlMode = body.controlMode ?? (type === 'PLAYSTATION' ? 'MANUAL' : 'AGENT');
    const accessMethod = body.accessMethod ?? (controlMode === 'MANUAL' ? 'MANUAL' : 'SHELL_REPLACE');

    const inserted = await ctx.db
      .insert(devices)
      .values({
        name: body.name,
        type,
        controlMode,
        accessMethod,
        location: body.location ?? null,
        notes: body.notes ?? null,
        offlineGraceSeconds: body.offlineGraceSeconds ?? null,
        enabled: body.enabled ?? true,
        createdByUserId: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const device = inserted[0]!;

    // PC devices get a one-time enrollment code so the agent can claim a token.
    let enrollmentCode: string | null = null;
    if (controlMode === 'AGENT') {
      enrollmentCode = generateEnrollmentCode();
      await ctx.db.insert(deviceCredentials).values({
        deviceId: device.id,
        // Placeholder hash; replaced when the agent registers.
        tokenHash: hashToken(`pending:${generateToken(16)}`),
        tokenPrefix: 'pending',
        enrollmentCodeHash: hashToken(enrollmentCode),
        enrollmentExpiresAt: new Date(now.getTime() + ENROLLMENT_TTL_MINUTES * 60_000),
        createdAt: now,
      });
    }

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: 'DEVICE_CREATE',
      targetType: 'device',
      targetId: device.id,
      detail: { name: device.name, type, controlMode },
      ip: req.ip ?? null,
    });
    ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: device.id });

    res.status(201).json({
      device: await getDeviceView(ctx, device.id),
      enrollmentCode,
      enrollmentExpiresAt: enrollmentCode
        ? new Date(now.getTime() + ENROLLMENT_TTL_MINUTES * 60_000).toISOString()
        : null,
    });
  });

  router.patch('/:id', requireAdmin, async (req, res) => {
    const body = parseBody(deviceUpdateSchema, req.body);
    const actor = req.user!;
    const now = ctx.clock.now();

    const existingRows = await ctx.db.select().from(devices).where(eq(devices.id, pathParam(req, "id"))).limit(1);
    const existing = existingRows[0];
    if (!existing) throw notFound('Device not found');

    if (body.name && body.name.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await ctx.db
        .select({ id: devices.id })
        .from(devices)
        .where(sql`lower(${devices.name}) = ${body.name.toLowerCase()}`)
        .limit(1);
      if (duplicate[0]) throw conflict('DEVICE_NAME_TAKEN', 'A device with that name already exists');
    }

    const { clearAgentError, ...patch } = body;
    const controlMode = patch.controlMode ?? existing.controlMode;
    const accessMethod =
      patch.accessMethod ?? (controlMode === 'MANUAL' ? 'MANUAL' : existing.accessMethod);

    await ctx.db
      .update(devices)
      .set({
        ...patch,
        location: patch.location === undefined ? existing.location : patch.location,
        notes: patch.notes === undefined ? existing.notes : patch.notes,
        offlineGraceSeconds:
          patch.offlineGraceSeconds === undefined ? existing.offlineGraceSeconds : patch.offlineGraceSeconds,
        controlMode,
        accessMethod,
        agentError: clearAgentError ? null : existing.agentError,
        updatedAt: now,
      })
      .where(eq(devices.id, existing.id));

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: 'DEVICE_UPDATE',
      targetType: 'device',
      targetId: existing.id,
      detail: { changes: Object.keys(patch) },
      ip: req.ip ?? null,
    });
    ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: existing.id });

    res.json({ device: await getDeviceView(ctx, existing.id) });
  });

  router.post('/:id/maintenance', requireAdmin, async (req, res) => {
    const body = parseBody(maintenanceSchema, req.body);
    const actor = req.user!;
    const now = ctx.clock.now();

    const rows = await ctx.db.select().from(devices).where(eq(devices.id, pathParam(req, "id"))).limit(1);
    const device = rows[0];
    if (!device) throw notFound('Device not found');

    if (body.maintenance) await assertNoActiveSession(ctx.db, device.id);

    await ctx.db
      .update(devices)
      .set({ maintenance: body.maintenance, updatedAt: now })
      .where(eq(devices.id, device.id));

    await ctx.db.insert(deviceEvents).values({
      deviceId: device.id,
      type: body.maintenance ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF',
      message: body.reason ?? null,
      createdAt: now,
    });

    await createNotification(ctx.db, ctx.clock, ctx.realtime, {
      kind: 'DEVICE_MAINTENANCE',
      title: `${device.name} ${body.maintenance ? 'entered maintenance' : 'left maintenance'}`,
      message: body.reason ?? `Changed by ${actor.displayName}`,
      deviceId: device.id,
      dedupeKey: `maintenance:${device.id}:${now.getTime()}`,
    });

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: body.maintenance ? 'DEVICE_MAINTENANCE_ON' : 'DEVICE_MAINTENANCE_OFF',
      targetType: 'device',
      targetId: device.id,
      detail: { reason: body.reason ?? null },
      ip: req.ip ?? null,
    });
    ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: device.id });

    res.json({ device: await getDeviceView(ctx, device.id) });
  });

  /** Soft delete: history must survive. Refuses while a session is live. */
  router.post('/:id/archive', requireAdmin, async (req, res) => {
    const actor = req.user!;
    const now = ctx.clock.now();
    const rows = await ctx.db.select().from(devices).where(eq(devices.id, pathParam(req, "id"))).limit(1);
    const device = rows[0];
    if (!device) throw notFound('Device not found');

    await assertNoActiveSession(ctx.db, device.id);

    await ctx.db
      .update(devices)
      .set({ archivedAt: now, enabled: false, updatedAt: now })
      .where(eq(devices.id, device.id));
    await ctx.db
      .update(deviceCredentials)
      .set({ revokedAt: now })
      .where(and(eq(deviceCredentials.deviceId, device.id), isNull(deviceCredentials.revokedAt)));

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: 'DEVICE_ARCHIVE',
      targetType: 'device',
      targetId: device.id,
      detail: { name: device.name },
      ip: req.ip ?? null,
    });
    ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: device.id });

    res.json({ ok: true });
  });

  router.post('/:id/restore', requireAdmin, async (req, res) => {
    const actor = req.user!;
    const now = ctx.clock.now();
    await ctx.db
      .update(devices)
      .set({ archivedAt: null, enabled: true, updatedAt: now })
      .where(eq(devices.id, pathParam(req, "id")));

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: 'DEVICE_RESTORE',
      targetType: 'device',
      targetId: pathParam(req, "id"),
      ip: req.ip ?? null,
    });
    ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: pathParam(req, "id") });
    res.json({ device: await getDeviceView(ctx, pathParam(req, "id")) });
  });

  /** Issues a fresh one-time enrollment code and revokes the old device token. */
  router.post('/:id/enrollment', requireAdmin, async (req, res) => {
    const actor = req.user!;
    const now = ctx.clock.now();
    const rows = await ctx.db.select().from(devices).where(eq(devices.id, pathParam(req, "id"))).limit(1);
    const device = rows[0];
    if (!device) throw notFound('Device not found');
    if (device.controlMode !== 'AGENT') {
      throw badRequest('Only agent-managed devices use enrollment codes');
    }

    await ctx.db
      .update(deviceCredentials)
      .set({ revokedAt: now })
      .where(and(eq(deviceCredentials.deviceId, device.id), isNull(deviceCredentials.revokedAt)));

    const code = generateEnrollmentCode();
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MINUTES * 60_000);
    await ctx.db.insert(deviceCredentials).values({
      deviceId: device.id,
      tokenHash: hashToken(`pending:${generateToken(16)}`),
      tokenPrefix: 'pending',
      enrollmentCodeHash: hashToken(code),
      enrollmentExpiresAt: expiresAt,
      createdAt: now,
    });

    await writeAudit(ctx.db, ctx.clock, {
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      action: 'DEVICE_ENROLLMENT_ISSUE',
      targetType: 'device',
      targetId: device.id,
      ip: req.ip ?? null,
    });

    res.json({ enrollmentCode: code, enrollmentExpiresAt: expiresAt.toISOString() });
  });

  router.get('/:id/history', async (req, res) => {
    const rows = await ctx.db.select().from(devices).where(eq(devices.id, pathParam(req, "id"))).limit(1);
    const device = rows[0];
    if (!device) throw notFound('Device not found');

    const [sessionsPage, events, accessEvents] = await Promise.all([
      listSessions(ctx, { deviceId: device.id, limit: 50 }),
      ctx.db
        .select()
        .from(deviceEvents)
        .where(eq(deviceEvents.deviceId, device.id))
        .orderBy(desc(deviceEvents.createdAt))
        .limit(50),
      ctx.db
        .select()
        .from(accessControlEvents)
        .where(eq(accessControlEvents.deviceId, device.id))
        .orderBy(desc(accessControlEvents.createdAt))
        .limit(50),
    ]);

    res.json({
      sessions: sessionsPage.items,
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        message: e.message,
        detail: e.detail,
        at: e.createdAt.toISOString(),
      })),
      accessEvents: accessEvents.map((e) => ({
        id: e.id,
        action: e.action,
        outcome: e.outcome,
        message: e.message,
        at: e.createdAt.toISOString(),
      })),
    });
  });

  return router;
}
