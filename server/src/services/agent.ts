import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import {
  accessControlEvents,
  deviceEvents,
  devices,
  sessionEvents,
  sessions,
} from '../db/schema.js';
import type { Device } from '../db/schema.js';
import { writeAudit } from './audit.js';
import { createNotification } from './notifications.js';
import { REALTIME_EVENTS } from '../realtime.js';
import type { AgentAuthorization } from '../types.js';

/**
 * The single source of truth a device agent is allowed to trust.
 * Everything is derived from server state and the server clock.
 */
export async function buildAuthorization(
  ctx: Ctx,
  device: Device,
): Promise<AgentAuthorization> {
  const now = ctx.clock.now();
  const settings = await ctx.settings.get();
  const graceSeconds = device.offlineGraceSeconds ?? settings.agentGraceSeconds;
  const base = {
    deviceId: device.id,
    serverTime: now.toISOString(),
    graceSeconds,
    accessMethod: device.accessMethod,
  };

  if (device.archivedAt || !device.enabled) {
    return {
      ...base,
      state: 'DISABLED',
      session: null,
      reason: 'This device is disabled. Please contact the front desk.',
    };
  }
  if (device.maintenance) {
    return {
      ...base,
      state: 'MAINTENANCE',
      session: null,
      reason: 'This station is under maintenance.',
    };
  }

  const rows = await ctx.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.deviceId, device.id), eq(sessions.status, 'ACTIVE')))
    .limit(1);
  const session = rows[0];

  if (!session) {
    return { ...base, state: 'NO_SESSION', session: null, reason: 'No active session on this device.' };
  }

  if (session.expiresAt.getTime() <= now.getTime()) {
    return {
      ...base,
      state: 'EXPIRED',
      session: {
        id: session.id,
        expiresAt: session.expiresAt.toISOString(),
        customerNickname: session.customerNickname,
        startedAt: session.startedAt.toISOString(),
      },
      reason: 'Session time is over.',
    };
  }

  return {
    ...base,
    state: 'AUTHORIZED',
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      customerNickname: session.customerNickname,
      startedAt: session.startedAt.toISOString(),
    },
    reason: 'Session active.',
  };
}

export interface AgentEventInput {
  type: string;
  action?: 'RESTRICT' | 'RELEASE' | 'SYNC' | 'SKIP';
  outcome?: 'SUCCESS' | 'FAILED' | 'PENDING';
  sessionId?: string | null;
  message?: string | null;
}

const RESTRICTION_TYPES = new Set([
  'RESTRICTION_APPLIED',
  'RESTRICTION_FAILED',
  'RESTRICTION_RELEASED',
  'RECOVERY_ENTERED',
  'RECOVERY_CLEARED',
]);

/** Records what the device agent reports and returns whether state changed. */
export async function recordAgentEvents(
  ctx: Ctx,
  device: Device,
  events: AgentEventInput[],
): Promise<{ restricted: string[]; failed: string[] }> {
  const now = ctx.clock.now();
  const settings = await ctx.settings.get();
  const restricted: string[] = [];
  const failed: string[] = [];

  for (const event of events.slice(0, 50)) {
    const type = event.type.toUpperCase().slice(0, 40);
    const outcome = event.outcome ?? (type.endsWith('FAILED') ? 'FAILED' : 'SUCCESS');

    if (RESTRICTION_TYPES.has(type)) {
      await ctx.db.insert(accessControlEvents).values({
        deviceId: device.id,
        sessionId: event.sessionId ?? null,
        action: event.action ?? (type.includes('RELEASE') ? 'RELEASE' : type.includes('SYNC') ? 'SYNC' : 'RESTRICT'),
        outcome,
        message: event.message ?? null,
        detail: { type } as never,
        createdAt: now,
      });
    }

    await ctx.db.insert(deviceEvents).values({
      deviceId: device.id,
      type,
      message: event.message ?? null,
      detail: { sessionId: event.sessionId ?? null, outcome } as never,
      createdAt: now,
    });

    if (type === 'RESTRICTION_APPLIED' && event.sessionId) {
      const sessionRows = await ctx.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, event.sessionId))
        .limit(1);
      const session = sessionRows[0];
      if (session && !session.restrictionConfirmedAt) {
        await ctx.db
          .update(sessions)
          .set({ restrictionConfirmedAt: now, updatedAt: now })
          .where(eq(sessions.id, session.id));
        await ctx.db.insert(sessionEvents).values({
          sessionId: session.id,
          type: 'RESTRICTED',
          actorLabel: 'device agent',
          detail: { deviceId: device.id, method: device.accessMethod } as never,
          createdAt: now,
        });
        await ctx.db
          .update(devices)
          .set({ pendingRestrictionSessionId: null, agentError: null, updatedAt: now })
          .where(eq(devices.id, device.id));

        await createNotification(ctx.db, ctx.clock, ctx.realtime, {
          kind: 'ACCESS_RESTRICTED',
          title: `${device.name} restricted`,
          message: 'The station is locked until staff start the next session.',
          deviceId: device.id,
          sessionId: session.id,
          dedupeKey: `restricted:${session.id}`,
        });
        await writeAudit(ctx.db, ctx.clock, {
          actorLabel: 'device agent',
          action: 'ACCESS_RESTRICTED',
          targetType: 'device',
          targetId: device.id,
          detail: { sessionId: session.id, method: device.accessMethod },
        });
        restricted.push(session.id);
      }
    }

    if (type === 'RESTRICTION_FAILED') {
      failed.push(event.sessionId ?? device.id);
      await ctx.db
        .update(devices)
        .set({ agentError: event.message ?? 'Access restriction failed', updatedAt: now })
        .where(eq(devices.id, device.id));
      await createNotification(ctx.db, ctx.clock, ctx.realtime, {
        kind: 'ACCESS_RESTRICTION_FAILED',
        severity: 'CRITICAL',
        title: `${device.name}: restriction failed`,
        message:
          event.message ??
          'The agent could not apply the lock. Send staff to the station and check the agent log.',
        deviceId: device.id,
        sessionId: event.sessionId ?? null,
        // One alert per session attempt window.
        dedupeKey: `restriction-failed:${device.id}:${event.sessionId ?? 'none'}:${Math.floor(
          now.getTime() / 60_000,
        )}`,
      });
      await writeAudit(ctx.db, ctx.clock, {
        actorLabel: 'device agent',
        action: 'ACCESS_RESTRICTION_FAILED',
        targetType: 'device',
        targetId: device.id,
        outcome: 'FAILURE',
        detail: { sessionId: event.sessionId ?? null, message: event.message ?? null },
      });
    }

    if (type === 'SYNC_OK' || type === 'RECOVERY_CLEARED') {
      await ctx.db
        .update(devices)
        .set({ agentError: null, updatedAt: now })
        .where(eq(devices.id, device.id));
    }

    void settings;
  }

  ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: device.id });
  return { restricted, failed };
}

export async function markReconnected(ctx: Ctx, device: Device, wasOffline: boolean) {
  if (!wasOffline) return;
  const now = ctx.clock.now();

  await ctx.db.insert(deviceEvents).values({
    deviceId: device.id,
    type: 'RECONNECTED',
    message: 'Agent resumed heartbeats',
    createdAt: now,
  });
  await createNotification(ctx.db, ctx.clock, ctx.realtime, {
    kind: 'AGENT_RECONNECTED',
    title: `${device.name} is back online`,
    message: 'Agent heartbeats resumed. Session state has been reconciled.',
    deviceId: device.id,
    dedupeKey: `device-reconnect:${device.id}:${now.getTime()}`,
  });
  await writeAudit(ctx.db, ctx.clock, {
    actorLabel: 'device agent',
    action: 'DEVICE_RECONNECTED',
    targetType: 'device',
    targetId: device.id,
  });
}

/** Clears a pending restriction after an authorised extension or new session. */
export async function clearPendingRestriction(ctx: Ctx, deviceId: string) {
  await ctx.db
    .update(devices)
    .set({ pendingRestrictionSessionId: null, updatedAt: ctx.clock.now() })
    .where(and(eq(devices.id, deviceId), isNull(devices.archivedAt)));
}
