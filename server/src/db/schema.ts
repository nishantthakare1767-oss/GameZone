import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const userRoleEnum = pgEnum('user_role', ['ADMIN', 'STAFF']);
export const deviceTypeEnum = pgEnum('device_type', ['PC', 'PLAYSTATION']);
/**
 * AGENT     - a managed Windows PC running GameHub.Agent (restrictions enforced locally)
 * MANUAL    - a console the agent cannot lock; staff-assisted enforcement
 */
export const deviceControlModeEnum = pgEnum('device_control_mode', ['AGENT', 'MANUAL']);
export const accessMethodEnum = pgEnum('access_method', [
  'SHELL_REPLACE', // kiosk account whose shell is the GameHub session host
  'SESSION_LOCK', // interactive lock screen enforced by the agent
  'MANUAL', // staff-assisted, no automated restriction
]);
export const sessionStatusEnum = pgEnum('session_status', ['ACTIVE', 'EXPIRED', 'ENDED']);
export const notificationSeverityEnum = pgEnum('notification_severity', ['INFO', 'WARNING', 'CRITICAL']);
export const accessOutcomeEnum = pgEnum('access_outcome', ['PENDING', 'SUCCESS', 'FAILED']);
export const workerRunStatusEnum = pgEnum('worker_run_status', ['RUNNING', 'OK', 'ERROR']);

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    role: userRoleEnum('role').notNull().default('STAFF'),
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_username_key').on(sql`lower(${t.username})`)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    uniqueIndex('auth_sessions_token_key').on(t.tokenHash),
    index('auth_sessions_user_idx').on(t.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: deviceTypeEnum('type').notNull(),
    controlMode: deviceControlModeEnum('control_mode').notNull().default('AGENT'),
    accessMethod: accessMethodEnum('access_method').notNull().default('SHELL_REPLACE'),
    enabled: boolean('enabled').notNull().default(true),
    maintenance: boolean('maintenance').notNull().default(false),
    /** Free-form location note ("Row A", "Left corner" ...) */
    location: text('location'),
    notes: text('notes'),
    /** Overrides the cafe-wide agent grace window when set. */
    offlineGraceSeconds: integer('offline_grace_seconds'),
    agentVersion: text('agent_version'),
    agentOs: text('agent_os'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true, mode: 'date' }),
    lastSeenIp: text('last_seen_ip'),
    /** Last error reported by the device agent, cleared on a healthy heartbeat. */
    agentError: text('agent_error'),
    /** Session id whose restriction the agent still has to confirm, if any. */
    pendingRestrictionSessionId: uuid('pending_restriction_session_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('devices_name_key').on(sql`lower(${t.name})`),
    index('devices_type_idx').on(t.type),
    index('devices_archived_idx').on(t.archivedAt),
  ],
);

/** Bearer credentials for device agents. Tokens are stored hashed only. */
export const deviceCredentials = pgTable(
  'device_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    enrollmentCodeHash: text('enrollment_code_hash'),
    enrollmentExpiresAt: timestamp('enrollment_expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('device_credentials_device_idx').on(t.deviceId),
    uniqueIndex('device_credentials_token_key').on(t.tokenHash),
  ],
);

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'restrict' }),
    customerNickname: text('customer_nickname'),
    startedByUserId: uuid('started_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    plannedDurationMinutes: integer('planned_duration_minutes').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    extendedMinutes: integer('extended_minutes').notNull().default(0),
    status: sessionStatusEnum('status').notNull().default('ACTIVE'),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    endedByUserId: uuid('ended_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    endReason: text('end_reason'),
    /** Set when the expiry worker has generated its notification/audit trail. */
    expiredProcessedAt: timestamp('expired_processed_at', { withTimezone: true, mode: 'date' }),
    restrictionConfirmedAt: timestamp('restriction_confirmed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // A device can never have two live sessions. Enforced by the database.
    uniqueIndex('sessions_one_active_per_device')
      .on(t.deviceId)
      .where(sql`status = 'ACTIVE'`),
    index('sessions_expiry_idx').on(t.status, t.expiresAt),
    index('sessions_device_idx').on(t.deviceId, t.startedAt),
    index('sessions_started_at_idx').on(t.startedAt),
  ],
);

export const sessionExtensions = pgTable(
  'session_extensions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    minutes: integer('minutes').notNull(),
    previousExpiresAt: timestamp('previous_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    newExpiresAt: timestamp('new_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    addedByUserId: uuid('added_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    note: text('note'),
    /** Idempotency key supplied by the client; guarantees a retry adds no time twice. */
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('session_extensions_idempotency_key').on(t.idempotencyKey),
    index('session_extensions_session_idx').on(t.sessionId, t.createdAt),
  ],
);

export const sessionEvents = pgTable(
  'session_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorLabel: text('actor_label').notNull().default('system'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('session_events_session_idx').on(t.sessionId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Notifications / device telemetry                                    */
/* ------------------------------------------------------------------ */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    severity: notificationSeverityEnum('severity').notNull().default('INFO'),
    title: text('title').notNull(),
    message: text('message').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /** Unique per logical event so retries / worker restarts cannot duplicate it. */
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    readByUserId: uuid('read_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_key').on(t.dedupeKey),
    index('notifications_created_idx').on(t.createdAt),
    index('notifications_unread_idx').on(t.readAt),
  ],
);

export const deviceEvents = pgTable(
  'device_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('device_events_device_idx').on(t.deviceId, t.createdAt)],
);

export const accessControlEvents = pgTable(
  'access_control_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // RESTRICT | RELEASE | SYNC | SKIP
    outcome: accessOutcomeEnum('outcome').notNull().default('PENDING'),
    message: text('message'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('access_control_events_device_idx').on(t.deviceId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Audit / settings / idempotency / integrations / worker telemetry    */
/* ------------------------------------------------------------------ */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    outcome: text('outcome').notNull().default('SUCCESS'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_created_idx').on(t.createdAt),
    index('audit_logs_actor_idx').on(t.actorUserId),
    index('audit_logs_action_idx').on(t.action),
  ],
);

export const cafeSettings = pgTable('cafe_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    action: text('action').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    responseJson: jsonb('response_json'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [index('idempotency_keys_created_idx').on(t.createdAt)],
);

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  /** Non-secret configuration only; secrets live in environment variables. */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('UNVERIFIED'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const workerRuns = pgTable(
  'worker_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worker: text('worker').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    status: workerRunStatusEnum('status').notNull().default('RUNNING'),
    processed: integer('processed').notNull().default(0),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    error: text('error'),
  },
  (t) => [index('worker_runs_started_idx').on(t.worker, t.startedAt)],
);

export type User = typeof users.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SessionExtension = typeof sessionExtensions.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type CafeSetting = typeof cafeSettings.$inferSelect;
