import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { deviceEvents, devices, sessionEvents, sessions, workerRuns } from '../db/schema.js';
import { addSeconds } from '../lib/clock.js';
import { logger } from '../lib/logger.js';
import { REALTIME_EVENTS } from '../realtime.js';
import { writeAudit } from './audit.js';
import { createNotification } from './notifications.js';

export interface ExpiryRunResult {
  expired: number;
  warnings: number;
  offline: number;
  errors: number;
}

interface ExpiredRow {
  id: string;
  device_id: string;
  expires_at: string | Date;
  customer_nickname: string | null;
}

/**
 * Server-authoritative expiry.
 *
 * Every decision comes from the database: a single conditional UPDATE claims
 * each overdue session, so a restart, a crash, a second worker or a duplicate
 * timer can never expire the same session twice. Notifications carry a unique
 * dedupe key as a second safety net.
 */
export class ExpiryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId = crypto.randomUUID();

  constructor(private readonly ctx: Ctx) {}

  async runOnce(nowInput?: Date): Promise<ExpiryRunResult> {
    const now = nowInput ?? this.ctx.clock.now();
    const settings = await this.ctx.settings.get();
    const result: ExpiryRunResult = { expired: 0, warnings: 0, offline: 0, errors: 0 };

    const runRows = await this.ctx.db
      .insert(workerRuns)
      .values({ worker: 'expiry', startedAt: now, status: 'RUNNING' })
      .returning({ id: workerRuns.id });
    const runId = runRows[0]?.id;

    try {
      result.expired = await this.expireDueSessions(now, settings.agentGraceSeconds);
      result.warnings = await this.raiseExpiryWarnings(now, settings);
      result.offline = await this.detectOfflineDevices(now, settings.deviceOfflineAfterSeconds);

      if (runId) {
        await this.ctx.db
          .update(workerRuns)
          .set({
            status: 'OK',
            finishedAt: this.ctx.clock.now(),
            processed: result.expired + result.warnings + result.offline,
            detail: { ...result },
          })
          .where(eq(workerRuns.id, runId));
      }
    } catch (error) {
      result.errors += 1;
      logger.error('expiry.worker_failed', { error: String(error) });
      if (runId) {
        await this.ctx.db
          .update(workerRuns)
          .set({
            status: 'ERROR',
            finishedAt: this.ctx.clock.now(),
            error: error instanceof Error ? error.message : String(error),
            detail: { ...result },
          })
          .where(eq(workerRuns.id, runId));
      }
    }

    return result;
  }

  /** Marks overdue sessions EXPIRED. Safe to call concurrently or after a crash. */
  private async expireDueSessions(now: Date, graceSeconds: number): Promise<number> {
    const claim = await this.ctx.db.execute(sql`
      update sessions
         set status = 'EXPIRED',
             ended_at = expires_at,
             end_reason = 'AUTO_EXPIRED',
             expired_processed_at = ${now},
             updated_at = ${now}
       where status = 'ACTIVE'
         and expires_at <= ${now}
         and id in (
           select id from sessions
            where status = 'ACTIVE' and expires_at <= ${now}
            order by expires_at asc
            limit 50
         )
      returning id, device_id, expires_at, customer_nickname
    `);

    const rows = (claim as unknown as { rows: ExpiredRow[] }).rows ?? [];
    if (rows.length === 0) return 0;

    const deviceRows = await this.ctx.db.select().from(devices);
    const deviceById = new Map(deviceRows.map((d) => [d.id, d]));

    for (const row of rows) {
      const device = deviceById.get(row.device_id);
      const deviceName = device?.name ?? 'Unknown device';
      const requiresAgent = device?.controlMode === 'AGENT';

      if (requiresAgent && device) {
        await this.ctx.db
          .update(devices)
          .set({ pendingRestrictionSessionId: row.id, updatedAt: now })
          .where(eq(devices.id, device.id));
      }

      await this.ctx.db.insert(deviceEvents).values({
        deviceId: row.device_id,
        type: 'SESSION_EXPIRED',
        message: `Session expired at ${new Date(row.expires_at).toISOString()}`,
        detail: {
          sessionId: row.id,
          enforcement: requiresAgent ? 'AGENT' : 'STAFF_ASSISTED',
          graceSeconds,
        } as never,
        createdAt: now,
      });

      await this.ctx.db.insert(sessionEvents).values({
        sessionId: row.id,
        type: 'EXPIRED',
        actorUserId: null,
        actorLabel: 'system',
        detail: { enforcement: requiresAgent ? 'AGENT' : 'STAFF_ASSISTED' } as never,
        createdAt: now,
      });

      await createNotification(this.ctx.db, this.ctx.clock, this.ctx.realtime, {
        kind: 'SESSION_EXPIRED',
        severity: requiresAgent ? 'WARNING' : 'CRITICAL',
        title: `${deviceName} session expired`,
        message: requiresAgent
          ? 'Time limit reached. The device agent will apply the access restriction.'
          : 'Time limit reached. Console has no verified remote lock — staff must enforce manually.',
        deviceId: row.device_id,
        sessionId: row.id,
        dedupeKey: `session-expired:${row.id}`,
      });

      if (!requiresAgent) {
        await createNotification(this.ctx.db, this.ctx.clock, this.ctx.realtime, {
          kind: 'STAFF_ASSIST_REQUIRED',
          severity: 'WARNING',
          title: `${deviceName} needs staff attention`,
          message: 'This device cannot be locked remotely. Please end play and clear the station.',
          deviceId: row.device_id,
          sessionId: row.id,
          dedupeKey: `staff-assist:${row.id}`,
        });
      }

      await writeAudit(this.ctx.db, this.ctx.clock, {
        actorLabel: 'system',
        action: 'SESSION_EXPIRED',
        targetType: 'session',
        targetId: row.id,
        detail: { deviceId: row.device_id, enforcement: requiresAgent ? 'AGENT' : 'STAFF_ASSISTED' },
      });

      this.ctx.realtime.emit(REALTIME_EVENTS.sessionChanged, {
        action: 'expired',
        sessionId: row.id,
        deviceId: row.device_id,
      });
      this.ctx.realtime.emit(REALTIME_EVENTS.devicesChanged, { deviceId: row.device_id });
    }

    logger.info('expiry.sessions_expired', { count: rows.length });
    return rows.length;
  }

  /** 5-minute and 1-minute warnings, deduped per session and threshold. */
  private async raiseExpiryWarnings(
    now: Date,
    settings: Awaited<ReturnType<Ctx['settings']['get']>>,
  ): Promise<number> {
    let created = 0;
    const thresholds: { minutes: number; kind: 'SESSION_EXPIRING_SOON' | 'SESSION_EXPIRING_1_MIN'; tag: string }[] = [
      { minutes: settings.expiringSoonMinutes, kind: 'SESSION_EXPIRING_SOON', tag: 'soon' },
      { minutes: settings.expiringWarningMinutes, kind: 'SESSION_EXPIRING_1_MIN', tag: 'final' },
    ];

    for (const threshold of thresholds) {
      const windowEnd = addSeconds(now, threshold.minutes * 60);
      const due = await this.ctx.db
        .select({
          id: sessions.id,
          deviceId: sessions.deviceId,
          expiresAt: sessions.expiresAt,
          deviceName: devices.name,
          controlMode: devices.controlMode,
        })
        .from(sessions)
        .innerJoin(devices, eq(devices.id, sessions.deviceId))
        .where(
          and(
            eq(sessions.status, 'ACTIVE'),
            sql`${sessions.expiresAt} > ${now}`,
            sql`${sessions.expiresAt} <= ${windowEnd}`,
          ),
        )
        .limit(50);

      for (const row of due) {
        const notification = await createNotification(this.ctx.db, this.ctx.clock, this.ctx.realtime, {
          kind: threshold.kind,
          severity: threshold.tag === 'final' ? 'CRITICAL' : 'WARNING',
          title: `${row.deviceName}: ${threshold.minutes} minute${threshold.minutes === 1 ? '' : 's'} left`,
          message:
            row.controlMode === 'MANUAL'
              ? 'Staff-assisted console: prepare to end the session on time.'
              : 'The device will be restricted automatically when the timer reaches zero.',
          deviceId: row.deviceId,
          sessionId: row.id,
          dedupeKey: `expiry-warning:${threshold.tag}:${row.id}`,
        });
        if (notification) created += 1;
      }
    }
    return created;
  }

  /** Devices whose agent stopped checking in. One alert per outage episode. */
  private async detectOfflineDevices(now: Date, offlineAfterSeconds: number): Promise<number> {
    const cutoff = addSeconds(now, -offlineAfterSeconds);
    const stale = await this.ctx.db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.controlMode, 'AGENT'),
          eq(devices.enabled, true),
          isNull(devices.archivedAt),
          lt(devices.lastHeartbeatAt, cutoff),
        ),
      )
      .limit(100);

    let created = 0;
    for (const device of stale) {
      const episodeKey = device.lastHeartbeatAt
        ? device.lastHeartbeatAt.getTime().toString()
        : 'never';
      const notification = await createNotification(this.ctx.db, this.ctx.clock, this.ctx.realtime, {
        kind: 'AGENT_DISCONNECTED',
        severity: 'WARNING',
        title: `${device.name} is offline`,
        message: device.lastHeartbeatAt
          ? `No heartbeat since ${device.lastHeartbeatAt.toISOString()}.`
          : 'This agent has never connected.',
        deviceId: device.id,
        dedupeKey: `device-offline:${device.id}:${episodeKey}`,
      });
      if (!notification) continue;
      created += 1;
      await this.ctx.db.insert(deviceEvents).values({
        deviceId: device.id,
        type: 'DISCONNECTED',
        message: 'Heartbeat missing past the offline threshold',
        detail: { lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() ?? null } as never,
        createdAt: now,
      });
      await writeAudit(this.ctx.db, this.ctx.clock, {
        actorLabel: 'system',
        action: 'DEVICE_OFFLINE',
        targetType: 'device',
        targetId: device.id,
      });
    }
    return created;
  }

  start(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce()
        .catch((error) => logger.error('expiry.tick_failed', { error: String(error) }))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get workerInstanceId() {
    return this.workerId;
  }
}
