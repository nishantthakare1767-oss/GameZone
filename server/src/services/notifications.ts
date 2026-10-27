import type { Db } from '../db/index.js';
import { notifications, type Notification } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import type { RealtimeBus } from '../realtime.js';
import { REALTIME_EVENTS } from '../realtime.js';

export type NotificationKind =
  | 'SESSION_EXPIRING_SOON'
  | 'SESSION_EXPIRING_1_MIN'
  | 'SESSION_EXPIRED'
  | 'SESSION_EXTENDED'
  | 'DEVICE_OFFLINE'
  | 'AGENT_DISCONNECTED'
  | 'AGENT_RECONNECTED'
  | 'ACCESS_RESTRICTION_FAILED'
  | 'ACCESS_RESTRICTED'
  | 'ACCESS_RESTORED'
  | 'EXTENSION_FAILED'
  | 'DEVICE_MAINTENANCE'
  | 'SERVER_RECOVERY'
  | 'SYNC_FAILED'
  | 'SESSION_ENDED'
  | 'SESSION_STARTED'
  | 'STAFF_ASSIST_REQUIRED';

export interface CreateNotificationInput {
  kind: NotificationKind;
  title: string;
  message: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  deviceId?: string | null;
  sessionId?: string | null;
  /** Unique per logical event. Retries and worker restarts cannot duplicate it. */
  dedupeKey: string;
}

/**
 * Inserts a notification unless one with the same dedupe key already exists.
 * Returns null for duplicates so callers can skip side effects such as sounds.
 */
export async function createNotification(
  db: Db,
  clock: Clock,
  realtime: RealtimeBus,
  input: CreateNotificationInput,
): Promise<Notification | null> {
  const inserted = await db
    .insert(notifications)
    .values({
      kind: input.kind,
      title: input.title,
      message: input.message,
      severity: input.severity ?? 'INFO',
      deviceId: input.deviceId ?? null,
      sessionId: input.sessionId ?? null,
      dedupeKey: input.dedupeKey,
      createdAt: clock.now(),
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning();

  const row = inserted[0];
  if (!row) return null;
  realtime.emit(REALTIME_EVENTS.notificationNew, row);
  return row;
}
