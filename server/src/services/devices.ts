import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { deviceCredentials, devices } from '../db/schema.js';
import type { Device } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import type { SettingsShape } from './settings.js';
import type {
  ConnectivityStatus,
  DeviceView,
  OperationalStatus,
  SessionView,
} from '../types.js';

export const STATUS_LABELS: Record<OperationalStatus, string> = {
  AVAILABLE: 'Available',
  ACTIVE: 'In session',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Session expired',
  RESTRICTED: 'Restricted',
  MAINTENANCE: 'Maintenance',
  ERROR: 'Agent error',
  DISABLED: 'Disabled',
};

export function computeConnectivity(
  device: Pick<Device, 'controlMode' | 'lastHeartbeatAt'>,
  settings: SettingsShape,
  now: Date,
): ConnectivityStatus {
  if (device.controlMode === 'MANUAL') return 'MANUAL';
  if (!device.lastHeartbeatAt) return 'NEVER_CONNECTED';
  const ageSeconds = (now.getTime() - device.lastHeartbeatAt.getTime()) / 1000;
  return ageSeconds > settings.deviceOfflineAfterSeconds ? 'OFFLINE' : 'ONLINE';
}

export function computeOperationalStatus(
  device: Device,
  activeSession: SessionView | null,
  latestSession: SessionView | null,
  settings: SettingsShape,
  now: Date,
): { status: OperationalStatus; restrictionPending: boolean } {
  const restrictionPending = Boolean(device.pendingRestrictionSessionId);

  if (device.archivedAt || !device.enabled) {
    return { status: 'DISABLED', restrictionPending };
  }
  if (device.maintenance) {
    return { status: 'MAINTENANCE', restrictionPending };
  }

  if (activeSession) {
    const remainingMs = new Date(activeSession.expiresAt).getTime() - now.getTime();
    if (remainingMs <= 0) return { status: 'EXPIRED', restrictionPending };
    if (remainingMs <= settings.expiringSoonMinutes * 60_000) {
      return { status: 'EXPIRING_SOON', restrictionPending };
    }
    return { status: 'ACTIVE', restrictionPending };
  }

  if (device.agentError) {
    return { status: 'ERROR', restrictionPending };
  }

  if (latestSession && latestSession.status !== 'ACTIVE') {
    if (latestSession.restrictionConfirmedAt) return { status: 'RESTRICTED', restrictionPending };
    if (latestSession.status === 'EXPIRED') return { status: 'EXPIRED', restrictionPending };
  }

  if (restrictionPending) return { status: 'RESTRICTED', restrictionPending };

  return { status: 'AVAILABLE', restrictionPending };
}


/**
 * Builds device views. `sessions` are passed in already shaped by the session
 * service so the two views always agree on remaining time.
 */
export function buildDeviceView(params: {
  device: Device;
  activeSession: SessionView | null;
  latestSession: SessionView | null;
  hasActiveCredential: boolean;
  settings: SettingsShape;
  now: Date;
}): DeviceView {
  const { device, activeSession, latestSession, hasActiveCredential, settings, now } = params;
  const connectivity = computeConnectivity(device, settings, now);
  const { status, restrictionPending } = computeOperationalStatus(
    device,
    activeSession,
    latestSession,
    settings,
    now,
  );

  return {
    id: device.id,
    name: device.name,
    type: device.type,
    controlMode: device.controlMode,
    accessMethod: device.accessMethod,
    enabled: device.enabled,
    maintenance: device.maintenance,
    archivedAt: device.archivedAt ? device.archivedAt.toISOString() : null,
    location: device.location,
    notes: device.notes,
    agentVersion: device.agentVersion,
    agentOs: device.agentOs,
    agentError: device.agentError,
    lastHeartbeatAt: device.lastHeartbeatAt ? device.lastHeartbeatAt.toISOString() : null,
    lastSeenIp: device.lastSeenIp,
    connectivity,
    status,
    statusLabel: STATUS_LABELS[status],
    session: activeSession,
    restrictionPending,
    requiresStaffEnforcement: device.controlMode === 'MANUAL',
    hasActiveCredential,
    offlineGraceSeconds: device.offlineGraceSeconds ?? settings.agentGraceSeconds,
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString(),
  };
}

export async function findDeviceByCredential(
  db: Db,
  tokenHash: string,
): Promise<{ device: Device; credentialId: string } | null> {
  const rows = await db
    .select({ device: devices, credentialId: deviceCredentials.id })
    .from(deviceCredentials)
    .innerJoin(devices, eq(devices.id, deviceCredentials.deviceId))
    .where(
      and(
        eq(deviceCredentials.tokenHash, tokenHash),
        isNull(deviceCredentials.revokedAt),
        isNull(devices.archivedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { device: row.device, credentialId: row.credentialId };
}

export async function touchCredential(db: Db, credentialId: string, now: Date) {
  await db
    .update(deviceCredentials)
    .set({ lastUsedAt: now })
    .where(eq(deviceCredentials.id, credentialId));
}

export async function countDevicesByType(db: Db) {
  const rows = await db
    .select({ type: devices.type, count: sql<number>`count(*)::int` })
    .from(devices)
    .where(isNull(devices.archivedAt))
    .groupBy(devices.type);
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.type, Number(row.count));
  return map;
}

export async function recentDevices(db: Db, limit = 200) {
  return db
    .select()
    .from(devices)
    .where(isNull(devices.archivedAt))
    .orderBy(desc(devices.createdAt))
    .limit(limit);
}
