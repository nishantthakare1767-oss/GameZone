import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { deviceCredentials, devices, sessionEvents, sessions, users } from '../db/schema.js';
import { buildDeviceView } from './devices.js';
import { sessionQuery, toSessionView } from './sessions.js';
import type { ActivityItem, DashboardSummary, DeviceView, SessionView } from '../types.js';

export async function listDeviceViews(
  ctx: Ctx,
  options: { includeArchived?: boolean } = {},
): Promise<DeviceView[]> {
  const settings = await ctx.settings.get();
  const now = ctx.clock.now();

  const deviceRows = await ctx.db
    .select()
    .from(devices)
    .where(options.includeArchived ? undefined : isNull(devices.archivedAt))
    .orderBy(devices.name);

  if (deviceRows.length === 0) return [];
  const ids = deviceRows.map((d) => d.id);

  const [activeRows, latestRows, credentialRows] = await Promise.all([
    sessionQuery(ctx.db).where(and(inArray(sessions.deviceId, ids), eq(sessions.status, 'ACTIVE'))),
    sessionQuery(ctx.db)
      .where(inArray(sessions.deviceId, ids))
      .orderBy(desc(sessions.startedAt))
      .limit(1000),
    ctx.db
      .select({ deviceId: deviceCredentials.deviceId })
      .from(deviceCredentials)
      .where(and(inArray(deviceCredentials.deviceId, ids), isNull(deviceCredentials.revokedAt))),
  ]);

  const activeByDevice = new Map<string, SessionView>();
  for (const row of activeRows) {
    activeByDevice.set(row.session.deviceId, toSessionView(row, settings, now));
  }

  const latestByDevice = new Map<string, SessionView>();
  for (const row of latestRows) {
    if (!latestByDevice.has(row.session.deviceId)) {
      latestByDevice.set(row.session.deviceId, toSessionView(row, settings, now));
    }
  }

  const withCredential = new Set(credentialRows.map((r) => r.deviceId));

  return deviceRows.map((device) =>
    buildDeviceView({
      device,
      activeSession: activeByDevice.get(device.id) ?? null,
      latestSession: latestByDevice.get(device.id) ?? null,
      hasActiveCredential: withCredential.has(device.id),
      settings,
      now,
    }),
  );
}

export async function getDeviceView(
  ctx: Ctx,
  deviceId: string,
): Promise<DeviceView | null> {
  const views = await listDeviceViews(ctx, { includeArchived: true });
  return views.find((v) => v.id === deviceId) ?? null;
}

export async function listActiveSessionViews(ctx: Ctx): Promise<SessionView[]> {
  const settings = await ctx.settings.get();
  const now = ctx.clock.now();
  const rows = await sessionQuery(ctx.db)
    .where(eq(sessions.status, 'ACTIVE'))
    .orderBy(sessions.expiresAt);
  return rows.map((r) => toSessionView(r, settings, now));
}

export async function recentActivity(ctx: Ctx, limit = 15): Promise<ActivityItem[]> {
  const rows = await ctx.db
    .select({
      event: sessionEvents,
      deviceId: sessions.deviceId,
      deviceName: devices.name,
      actorName: users.displayName,
    })
    .from(sessionEvents)
    .innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
    .innerJoin(devices, eq(devices.id, sessions.deviceId))
    .leftJoin(users, eq(users.id, sessionEvents.actorUserId))
    .orderBy(desc(sessionEvents.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.event.id,
    at: row.event.createdAt.toISOString(),
    type: row.event.type,
    actorLabel: row.actorName ?? row.event.actorLabel,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    sessionId: row.event.sessionId,
    message: describeEvent(row.event.type, row.event.detail as Record<string, unknown> | null),
    severity: severityForEvent(row.event.type),
  }));
}

function severityForEvent(type: string): ActivityItem['severity'] {
  if (type === 'EXPIRED' || type === 'RESTRICTED') return 'WARNING';
  if (type === 'ACCESS_RESTRICTION_FAILED') return 'CRITICAL';
  return 'INFO';
}

function describeEvent(type: string, detail: Record<string, unknown> | null): string {
  switch (type) {
    case 'STARTED':
      return `Session started for ${String(detail?.durationMinutes ?? '?')} minutes`;
    case 'EXTENDED':
      return `Session extended by ${String(detail?.minutes ?? '?')} minutes`;
    case 'REACTIVATED':
      return `Expired session reactivated with ${String(detail?.minutes ?? '?')} extra minutes`;
    case 'ENDED':
      return `Session ended: ${String(detail?.reason ?? 'no reason recorded')}`;
    case 'EXPIRED':
      return 'Session expired — time limit reached';
    case 'RESTRICTED':
      return 'Access restriction applied by the device agent';
    case 'RESTORED':
      return 'Access restored for a new session';
    case 'ACCESS_RESTRICTION_FAILED':
      return 'Device agent could not apply the restriction';
    default:
      return type.replaceAll('_', ' ').toLowerCase();
  }
}

export async function dashboardSummary(ctx: Ctx): Promise<DashboardSummary> {
  const [deviceViews, activeSessions, activity] = await Promise.all([
    listDeviceViews(ctx),
    listActiveSessionViews(ctx),
    recentActivity(ctx, 12),
  ]);

  const count = (predicate: (v: DeviceView) => boolean) => deviceViews.filter(predicate).length;
  const settings = await ctx.settings.get();
  const now = ctx.clock.now();
  const expiringSoon = activeSessions.filter(
    (s) => s.remainingSeconds > 0 && s.remainingSeconds <= settings.expiringSoonMinutes * 60,
  );

  return {
    serverTime: now.toISOString(),
    totals: {
      devices: deviceViews.length,
      pcs: count((d) => d.type === 'PC'),
      consoles: count((d) => d.type === 'PLAYSTATION'),
      available: count((d) => d.status === 'AVAILABLE'),
      active: count((d) => d.status === 'ACTIVE'),
      expiringSoon: count((d) => d.status === 'EXPIRING_SOON'),
      expired: count((d) => d.status === 'EXPIRED'),
      restricted: count((d) => d.status === 'RESTRICTED'),
      offline: count((d) => d.connectivity === 'OFFLINE'),
      maintenance: count((d) => d.status === 'MAINTENANCE'),
      errors: count((d) => d.status === 'ERROR'),
      disabled: count((d) => d.status === 'DISABLED'),
    },
    activeSessions,
    recentActivity: activity,
  };
}
