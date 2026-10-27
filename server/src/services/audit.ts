import type { Db } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { logger } from '../lib/logger.js';

export interface AuditInput {
  actorUserId?: string | null;
  actorLabel: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

export async function writeAudit(db: Db, clock: Clock, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: input.actorUserId ?? null,
      actorLabel: input.actorLabel,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      outcome: input.outcome ?? 'SUCCESS',
      detail: (input.detail ?? null) as never,
      ip: input.ip ?? null,
      createdAt: clock.now(),
    });
  } catch (error) {
    // Auditing must never take down the request path, but it must be visible.
    logger.error('audit.write_failed', { action: input.action, error: String(error) });
  }
}
