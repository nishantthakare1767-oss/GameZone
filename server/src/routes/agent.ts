import { Router } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { deviceCredentials, devices } from '../db/schema.js';
import { generateToken, hashToken } from '../auth/service.js';
import { requireDevice } from '../auth/middleware.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { buildAuthorization, markReconnected, recordAgentEvents } from '../services/agent.js';
import { computeConnectivity } from '../services/devices.js';
import { writeAudit } from '../services/audit.js';
import { REALTIME_EVENTS } from '../realtime.js';

const registerSchema = z.object({
  deviceId: z.string().uuid(),
  enrollmentCode: z.string().trim().min(8).max(40),
  agentVersion: z.string().trim().max(40).optional(),
  os: z.string().trim().max(120).optional(),
});

const heartbeatSchema = z.object({
  agentVersion: z.string().trim().max(40).optional(),
  os: z.string().trim().max(120).optional(),
  accessState: z.enum(['AUTHORIZED', 'RESTRICTED', 'RECOVERY', 'IDLE']).optional(),
  pendingRestrictionSessionId: z.string().uuid().nullish(),
});

const eventsSchema = z.object({
  events: z
    .array(
      z.object({
        type: z.string().trim().min(2).max(40),
        action: z.enum(['RESTRICT', 'RELEASE', 'SYNC', 'SKIP']).optional(),
        outcome: z.enum(['SUCCESS', 'FAILED', 'PENDING']).optional(),
        sessionId: z.string().uuid().nullish(),
        message: z.string().trim().max(500).nullish(),
      }),
    )
    .max(50),
});

export function agentRoutes(ctx: Ctx) {
  const router = Router();

  /** One-time enrollment: an admin-issued code is exchanged for a device token. */
  router.post('/register', async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    const now = ctx.clock.now();

    const rows = await ctx.db
      .select()
      .from(devices)
      .where(eq(devices.id, body.deviceId))
      .limit(1);
    const device = rows[0];
    if (!device) throw notFound('Device not found');
    if (device.archivedAt) throw conflict('DEVICE_ARCHIVED', 'This device has been archived');
    if (device.controlMode !== 'AGENT') {
      throw badRequest('This device is not managed by an agent');
    }

    const credentialRows = await ctx.db
      .select()
      .from(deviceCredentials)
      .where(
        and(
          eq(deviceCredentials.deviceId, device.id),
          eq(deviceCredentials.enrollmentCodeHash, hashToken(body.enrollmentCode)),
          isNull(deviceCredentials.revokedAt),
          gt(deviceCredentials.enrollmentExpiresAt, now),
        ),
      )
      .limit(1);
    const credential = credentialRows[0];
    if (!credential) throw unauthorized('Invalid or expired enrollment code');

    const token = generateToken(32);
    await ctx.db
      .update(deviceCredentials)
      .set({
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, 6),
        enrollmentCodeHash: null,
        enrollmentExpiresAt: null,
        rotatedAt: now,
      })
      .where(eq(deviceCredentials.id, credential.id));

    await ctx.db
      .update(devices)
      .set({
        agentVersion: body.agentVersion ?? device.agentVersion,
        agentOs: body.os ?? device.agentOs,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(devices.id, device.id));

    await writeAudit(ctx.db, ctx.clock, {
      actorLabel: `device:${device.name}`,
      action: 'DEVICE_ENROLL',
      targetType: 'device',
      targetId: device.id,
      detail: { agentVersion: body.agentVersion ?? null },
      ip: req.ip ?? null,
    });
    ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: device.id });

    res.status(201).json({
      deviceToken: token,
      device: { id: device.id, name: device.name, type: device.type, accessMethod: device.accessMethod },
      serverTime: now.toISOString(),
    });
  });

  router.use(requireDevice(ctx));

  router.post('/heartbeat', async (req, res) => {
    const body = parseBody(heartbeatSchema, req.body);
    const device = req.device!;
    const now = ctx.clock.now();
    const settings = await ctx.settings.get();
    const wasOffline = computeConnectivity(device, settings, now) === 'OFFLINE';

    await ctx.db
      .update(devices)
      .set({
        lastHeartbeatAt: now,
        lastSeenIp: req.ip ?? device.lastSeenIp,
        agentVersion: body.agentVersion ?? device.agentVersion,
        agentOs: body.os ?? device.agentOs,
        updatedAt: now,
      })
      .where(eq(devices.id, device.id));

    if (wasOffline) await markReconnected(ctx, device, true);

    ctx.realtime.emit(REALTIME_EVENTS.deviceHeartbeat, { deviceId: device.id, at: now.toISOString() });

    const refreshed = (
      await ctx.db.select().from(devices).where(eq(devices.id, device.id)).limit(1)
    )[0]!;

    res.json({
      authorization: await buildAuthorization(ctx, refreshed),
      pendingRestrictionSessionId: refreshed.pendingRestrictionSessionId,
      serverTime: now.toISOString(),
    });
  });

  router.get('/session-state', async (req, res) => {
    const device = req.device!;
    const refreshed = (
      await ctx.db.select().from(devices).where(eq(devices.id, device.id)).limit(1)
    )[0]!;
    res.json({
      authorization: await buildAuthorization(ctx, refreshed),
      pendingRestrictionSessionId: refreshed.pendingRestrictionSessionId,
      serverTime: ctx.clock.now().toISOString(),
    });
  });

  router.post('/events', async (req, res) => {
    const body = parseBody(eventsSchema, req.body);
    const device = req.device!;
    const result = await recordAgentEvents(ctx, device, body.events);
    res.json({ accepted: body.events.length, ...result });
  });

  return router;
}
