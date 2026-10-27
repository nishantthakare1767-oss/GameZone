import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Ctx, Actor } from '../context.js';
import type { Db } from '../db/index.js';
import { devices, sessionEvents, sessionExtensions, sessions, users } from '../db/schema.js';
import type { Device } from '../db/schema.js';
import { addMinutes } from '../lib/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { writeAudit } from './audit.js';
import { REALTIME_EVENTS } from '../realtime.js';
import { createNotification } from './notifications.js';
import type { SessionStatus, SessionView } from '../types.js';
import type { SettingsShape } from './settings.js';
import { computeConnectivity } from './devices.js';

const startedByUser = alias(users, 'started_by_user');
const endedByUser = alias(users, 'ended_by_user');

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === UNIQUE_VIOLATION || e?.cause?.code === UNIQUE_VIOLATION;
}

export interface SessionRow {
  session: typeof sessions.$inferSelect;
  deviceName: string;
  deviceType: Device['type'];
  deviceControlMode: Device['controlMode'];
  startedByName: string;
  endedByName: string | null;
}

export function sessionQuery(db: Db) {
  return db
    .select({
      session: sessions,
      deviceName: devices.name,
      deviceType: devices.type,
      deviceControlMode: devices.controlMode,
      startedByName: startedByUser.displayName,
      endedByName: endedByUser.displayName,
    })
    .from(sessions)
    .innerJoin(devices, eq(devices.id, sessions.deviceId))
    .innerJoin(startedByUser, eq(startedByUser.id, sessions.startedByUserId))
    .leftJoin(endedByUser, eq(endedByUser.id, sessions.endedByUserId));
}

export function toSessionView(row: SessionRow, settings: SettingsShape, now: Date): SessionView {
  const s = row.session;
  const expiresMs = s.expiresAt.getTime();
  const startedMs = s.startedAt.getTime();
  const nowMs = now.getTime();
  const remainingSeconds = Math.round((expiresMs - nowMs) / 1000);
  const total = Math.max(expiresMs - startedMs, 1);
  const progress = Math.min(Math.max((nowMs - startedMs) / total, 0), 1);

  return {
    id: s.id,
    deviceId: s.deviceId,
    deviceName: row.deviceName,
    deviceType: row.deviceType,
    customerNickname: s.customerNickname,
    startedAt: s.startedAt.toISOString(),
    plannedDurationMinutes: s.plannedDurationMinutes,
    expiresAt: s.expiresAt.toISOString(),
    extendedMinutes: s.extendedMinutes,
    status: s.status as SessionStatus,
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    endReason: s.endReason,
    startedBy: { id: s.startedByUserId, displayName: row.startedByName },
    endedBy: s.endedByUserId ? { id: s.endedByUserId, displayName: row.endedByName ?? 'Unknown' } : null,
    remainingSeconds,
    progress,
    restrictionConfirmedAt: s.restrictionConfirmedAt ? s.restrictionConfirmedAt.toISOString() : null,
    // Consoles (and any MANUAL device) have no verified remote lock: staff must act.
    requiresStaffEnforcement: row.deviceControlMode === 'MANUAL',
  };
}

export async function getSessionRow(db: Db, sessionId: string): Promise<SessionRow | null> {
  const rows = await sessionQuery(db).where(eq(sessions.id, sessionId)).limit(1);
  return rows[0] ?? null;
}

export async function getSessionView(ctx: Ctx, sessionId: string): Promise<SessionView> {
  const row = await getSessionRow(ctx.db, sessionId);
  if (!row) throw notFound('Session not found');
  return toSessionView(row, await ctx.settings.get(), ctx.clock.now());
}

export interface CreateSessionInput {
  deviceId: string;
  durationMinutes: number;
  customerNickname?: string | null;
}

export async function createSession(
  ctx: Ctx,
  input: CreateSessionInput,
  actor: Actor,
  ip?: string,
): Promise<SessionView> {
  const settings = await ctx.settings.get();
  const now = ctx.clock.now();

  if (!Number.isInteger(input.durationMinutes)) throw badRequest('Duration must be whole minutes');
  if (input.durationMinutes < settings.minSessionMinutes || input.durationMinutes > settings.maxSessionMinutes) {
    throw badRequest(
      `Duration must be between ${settings.minSessionMinutes} and ${settings.maxSessionMinutes} minutes`,
    );
  }
  const nickname = input.customerNickname?.trim() || null;
  if (nickname && nickname.length > 40) throw badRequest('Customer nickname is too long (max 40)');

  let created: { id: string; deviceId: string } | null = null;

  try {
    created = await ctx.db.transaction(async (tx) => {
      // Locking the device row serialises concurrent start requests for it.
      const deviceRows = await tx
        .select()
        .from(devices)
        .where(eq(devices.id, input.deviceId))
        .for('update');
      const device = deviceRows[0];
      if (!device) throw notFound('Device not found');
      if (device.archivedAt) throw conflict('DEVICE_ARCHIVED', 'This device has been archived');
      if (!device.enabled) throw conflict('DEVICE_DISABLED', 'This device is disabled');
      if (device.maintenance) throw conflict('DEVICE_MAINTENANCE', 'Device is in maintenance');

      if (settings.blockOfflineDeviceSessions && device.controlMode === 'AGENT') {
        const connectivity = computeConnectivity(device, settings, now);
        if (connectivity !== 'ONLINE') {
          throw conflict('DEVICE_OFFLINE', 'Device agent is offline; sessions are blocked by policy');
        }
      }

      const existing = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.deviceId, device.id), eq(sessions.status, 'ACTIVE')))
        .limit(1);
      if (existing[0]) {
        throw conflict('DEVICE_BUSY', 'This device already has an active session');
      }

      const inserted = await tx
        .insert(sessions)
        .values({
          deviceId: device.id,
          customerNickname: nickname,
          startedByUserId: actor.id,
          startedAt: now,
          plannedDurationMinutes: input.durationMinutes,
          expiresAt: addMinutes(now, input.durationMinutes),
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: sessions.id, deviceId: sessions.deviceId });

      const row = inserted[0]!;
      await tx.insert(sessionEvents).values({
        sessionId: row.id,
        type: 'STARTED',
        actorUserId: actor.id,
        actorLabel: actor.displayName,
        detail: { durationMinutes: input.durationMinutes, customerNickname: nickname },
        createdAt: now,
      });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('DEVICE_BUSY', 'This device already has an active session');
    }
    throw error;
  }

  await writeAudit(ctx.db, ctx.clock, {
    actorUserId: actor.id,
    actorLabel: actor.displayName,
    action: 'SESSION_START',
    targetType: 'session',
    targetId: created.id,
    detail: { deviceId: created.deviceId, durationMinutes: input.durationMinutes },
    ip,
  });

  ctx.realtime.emit(REALTIME_EVENTS.sessionChanged, {
    action: 'started',
    sessionId: created.id,
    deviceId: created.deviceId,
  });
  ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: created.deviceId });

  return getSessionView(ctx, created.id);
}

export interface ExtendSessionInput {
  sessionId: string;
  minutes: number;
  idempotencyKey: string;
  reactivate?: boolean;
  note?: string | null;
}

export interface ExtendResult {
  session: SessionView;
  replayed: boolean;
  reactivated: boolean;
}

export async function extendSession(
  ctx: Ctx,
  input: ExtendSessionInput,
  actor: Actor,
  ip?: string,
): Promise<ExtendResult> {
  const settings = await ctx.settings.get();
  const now = ctx.clock.now();

  if (!Number.isInteger(input.minutes) || input.minutes <= 0) {
    throw badRequest('Extension must be a positive whole number of minutes');
  }
  if (input.minutes > settings.maxExtensionMinutes) {
    throw badRequest(`Extensions are limited to ${settings.maxExtensionMinutes} minutes`);
  }
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
    throw badRequest('A valid idempotency key is required');
  }

  type Outcome =
    | { kind: 'replay'; sessionId: string }
    | { kind: 'extended'; sessionId: string; deviceId: string; reactivated: boolean; extensionId: string };

  let outcome: Outcome;
  try {
    outcome = await ctx.db.transaction(async (tx): Promise<Outcome> => {
      const replay = await tx
        .select({ sessionId: sessionExtensions.sessionId })
        .from(sessionExtensions)
        .where(eq(sessionExtensions.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (replay[0]) return { kind: 'replay', sessionId: replay[0].sessionId };

      const rows = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .for('update');
      const session = rows[0];
      if (!session) throw notFound('Session not found');

      if (session.status === 'ENDED') {
        throw conflict('SESSION_ENDED', 'This session has already ended and cannot be extended');
      }

      let previousExpiry = session.expiresAt;
      let reactivated = false;

      if (session.status === 'EXPIRED' || previousExpiry.getTime() <= now.getTime()) {
        if (!settings.allowExtensionAfterExpiry) {
          throw conflict('EXTENSION_AFTER_EXPIRY_DISABLED', 'Extensions after expiry are disabled');
        }
        if (!input.reactivate) {
          throw conflict(
            'REACTIVATION_REQUIRED',
            'This session has expired. Confirm reactivation to grant more time.',
          );
        }
        reactivated = true;
        // Time restarts from now: expired play time is never credited back.
        previousExpiry = now;
      }

      const newExpiry = addMinutes(new Date(Math.max(previousExpiry.getTime(), now.getTime())), input.minutes);

      await tx
        .update(sessions)
        .set({
          expiresAt: newExpiry,
          extendedMinutes: session.extendedMinutes + input.minutes,
          status: 'ACTIVE',
          endedAt: null,
          endReason: null,
          endedByUserId: null,
          updatedAt: now,
        })
        .where(eq(sessions.id, session.id));

      const extensionRows = await tx
        .insert(sessionExtensions)
        .values({
          sessionId: session.id,
          minutes: input.minutes,
          previousExpiresAt: previousExpiry,
          newExpiresAt: newExpiry,
          addedByUserId: actor.id,
          note: input.note ?? null,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
        })
        .returning({ id: sessionExtensions.id });

      await tx.insert(sessionEvents).values({
        sessionId: session.id,
        type: reactivated ? 'REACTIVATED' : 'EXTENDED',
        actorUserId: actor.id,
        actorLabel: actor.displayName,
        detail: {
          minutes: input.minutes,
          newExpiresAt: newExpiry.toISOString(),
          reactivated,
        },
        createdAt: now,
      });

      await tx
        .update(devices)
        .set({ pendingRestrictionSessionId: null, updatedAt: now })
        .where(eq(devices.id, session.deviceId));

      return {
        kind: 'extended',
        sessionId: session.id,
        deviceId: session.deviceId,
        reactivated,
        extensionId: extensionRows[0]!.id,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Concurrent duplicate submission: the first one won, replay its result.
      const replay = await ctx.db
        .select({ sessionId: sessionExtensions.sessionId })
        .from(sessionExtensions)
        .where(eq(sessionExtensions.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (replay[0]) {
        return {
          session: await getSessionView(ctx, replay[0].sessionId),
          replayed: true,
          reactivated: false,
        };
      }
    }
    throw error;
  }

  if (outcome.kind === 'replay') {
    return {
      session: await getSessionView(ctx, outcome.sessionId),
      replayed: true,
      reactivated: false,
    };
  }

  await writeAudit(ctx.db, ctx.clock, {
    actorUserId: actor.id,
    actorLabel: actor.displayName,
    action: outcome.reactivated ? 'SESSION_REACTIVATE' : 'SESSION_EXTEND',
    targetType: 'session',
    targetId: outcome.sessionId,
    detail: { minutes: input.minutes, deviceId: outcome.deviceId },
    ip,
  });

  const view = await getSessionView(ctx, outcome.sessionId);
  await createNotification(ctx.db, ctx.clock, ctx.realtime, {
    kind: 'SESSION_EXTENDED',
    severity: 'INFO',
    title: `${view.deviceName} extended`,
    message: `${input.minutes} minutes added by ${actor.displayName}. New expiry ${new Date(
      view.expiresAt,
    ).toISOString()}.`,
    deviceId: outcome.deviceId,
    sessionId: outcome.sessionId,
    // One alert per extension, never a duplicate per retry.
    dedupeKey: `extended:${outcome.extensionId}`,
  });

  ctx.realtime.emit(REALTIME_EVENTS.sessionChanged, {
    action: 'extended',
    sessionId: outcome.sessionId,
    deviceId: outcome.deviceId,
  });
  ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: outcome.deviceId });

  return { session: view, replayed: false, reactivated: outcome.reactivated };
}

export interface EndSessionInput {
  sessionId: string;
  reason: string;
}

export async function endSession(
  ctx: Ctx,
  input: EndSessionInput,
  actor: Actor,
  ip?: string,
): Promise<SessionView> {
  const now = ctx.clock.now();
  const reason = input.reason?.trim();
  if (!reason) throw badRequest('A reason is required to end a session');
  if (reason.length > 200) throw badRequest('Reason is too long (max 200 characters)');

  const result = await ctx.db.transaction(async (tx) => {
    const rows = await tx.select().from(sessions).where(eq(sessions.id, input.sessionId)).for('update');
    const session = rows[0];
    if (!session) throw notFound('Session not found');
    if (session.status === 'ENDED') {
      throw conflict('SESSION_ENDED', 'This session has already been ended');
    }
    if (session.status === 'EXPIRED') {
      throw conflict('SESSION_EXPIRED', 'This session already expired; start a new session instead');
    }

    await tx
      .update(sessions)
      .set({
        status: 'ENDED',
        endedAt: now,
        endedByUserId: actor.id,
        endReason: reason,
        updatedAt: now,
      })
      .where(eq(sessions.id, session.id));

    await tx.insert(sessionEvents).values({
      sessionId: session.id,
      type: 'ENDED',
      actorUserId: actor.id,
      actorLabel: actor.displayName,
      detail: { reason },
      createdAt: now,
    });

    await tx
      .update(devices)
      .set({ pendingRestrictionSessionId: null, updatedAt: now })
      .where(eq(devices.id, session.deviceId));

    return session;
  });

  await writeAudit(ctx.db, ctx.clock, {
    actorUserId: actor.id,
    actorLabel: actor.displayName,
    action: 'SESSION_END',
    targetType: 'session',
    targetId: result.id,
    detail: { reason, deviceId: result.deviceId },
    ip,
  });

  ctx.realtime.emit(REALTIME_EVENTS.sessionChanged, {
    action: 'ended',
    sessionId: result.id,
    deviceId: result.deviceId,
  });
  ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: result.deviceId });

  return getSessionView(ctx, result.id);
}

export interface SessionListFilter {
  deviceId?: string;
  status?: SessionStatus;
  staffId?: string;
  from?: Date;
  to?: Date;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listSessions(ctx: Ctx, filter: SessionListFilter) {
  const settings = await ctx.settings.get();
  const now = ctx.clock.now();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const conditions: SQL[] = [];
  if (filter.deviceId) conditions.push(eq(sessions.deviceId, filter.deviceId));
  if (filter.status) conditions.push(eq(sessions.status, filter.status));
  if (filter.staffId) conditions.push(eq(sessions.startedByUserId, filter.staffId));
  if (filter.from) conditions.push(gte(sessions.startedAt, filter.from));
  if (filter.to) conditions.push(lte(sessions.startedAt, filter.to));
  if (filter.search) {
    const term = `%${filter.search.toLowerCase()}%`;
    const matches = or(
      sql`lower(${devices.name}) like ${term}`,
      sql`lower(coalesce(${sessions.customerNickname}, '')) like ${term}`,
    );
    if (matches) conditions.push(matches);
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await sessionQuery(ctx.db)
    .where(where)
    .orderBy(desc(sessions.startedAt))
    .limit(limit)
    .offset(offset);

  const totalRows = await ctx.db
    .select({ total: sql<number>`count(*)::int` })
    .from(sessions)
    .innerJoin(devices, eq(devices.id, sessions.deviceId))
    .where(where);

  return {
    items: rows.map((r) => toSessionView(r, settings, now)),
    total: Number(totalRows[0]?.total ?? 0),
    limit,
    offset,
  };
}

export async function getSessionEvents(db: Db, sessionId: string) {
  return db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.createdAt));
}

export async function getSessionExtensions(db: Db, sessionId: string) {
  const rows = await db
    .select({
      extension: sessionExtensions,
      addedByName: users.displayName,
    })
    .from(sessionExtensions)
    .innerJoin(users, eq(users.id, sessionExtensions.addedByUserId))
    .where(eq(sessionExtensions.sessionId, sessionId))
    .orderBy(asc(sessionExtensions.createdAt));
  return rows.map((r) => ({
    id: r.extension.id,
    minutes: r.extension.minutes,
    previousExpiresAt: r.extension.previousExpiresAt.toISOString(),
    newExpiresAt: r.extension.newExpiresAt.toISOString(),
    addedBy: r.addedByName,
    note: r.extension.note,
    createdAt: r.extension.createdAt.toISOString(),
  }));
}

export async function activeSessionIds(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.status, 'ACTIVE'))
    .orderBy(desc(sessions.expiresAt))
    .limit(500);
  return rows.map((r) => r.id);
}

export async function sessionIdsForDevice(db: Db, deviceIds: string[]) {
  if (deviceIds.length === 0) return [];
  return db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.deviceId, deviceIds));
}

/** Guard used by destructive device operations. */
export async function assertNoActiveSession(db: Db, deviceId: string) {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.deviceId, deviceId), eq(sessions.status, 'ACTIVE')))
    .limit(1);
  if (rows[0]) {
    throw conflict('DEVICE_HAS_ACTIVE_SESSION', 'Resolve the active session before removing this device');
  }
}

export function assertCanManage(actor: Actor, action: string) {
  if (actor.role !== 'ADMIN') throw forbidden(`Only administrators can ${action}`);
}
