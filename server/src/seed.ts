import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { deviceCredentials, devices, sessionEvents, sessions, users } from './db/schema.js';
import { hashPassword } from './auth/password.js';
import { generateEnrollmentCode, generateToken, hashToken } from './auth/service.js';
import { logger } from './lib/logger.js';
import { env } from './env.js';

const DEV_PASSWORD = 'ChangeMe123!';

/**
 * Creates the first administrator if the database has no users.
 * In production the password must come from ADMIN_PASSWORD; otherwise a random
 * one is generated and printed once so the operator can sign in and change it.
 */
export async function bootstrapSeed(ctx: Ctx): Promise<void> {
  const existing = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(users);
  if (Number(existing[0]?.count ?? 0) > 0) return;

  const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
  const provided = process.env.ADMIN_PASSWORD;
  const password = provided || (env.isProduction ? randomBytes(12).toString('base64url') : DEV_PASSWORD);

  await ctx.db.insert(users).values({
    username,
    displayName: 'Cafe Administrator',
    role: 'ADMIN',
    passwordHash: await hashPassword(password),
    mustChangePassword: !provided,
    createdAt: ctx.clock.now(),
    updatedAt: ctx.clock.now(),
  });

  if (provided) {
    logger.info('seed.admin_created', { username });
  } else {
    logger.warn('seed.admin_created_generated_password', {
      username,
      password,
      message: 'Sign in and change this password immediately.',
    });
  }
}

interface SeedDevice {
  name: string;
  type: 'PC' | 'PLAYSTATION';
  location: string;
}

const SEED_DEVICES: SeedDevice[] = [
  { name: 'PC-01', type: 'PC', location: 'Row A · left' },
  { name: 'PC-02', type: 'PC', location: 'Row A · centre' },
  { name: 'PC-03', type: 'PC', location: 'Row A · right' },
  { name: 'PC-04', type: 'PC', location: 'Row B · left' },
  { name: 'PC-05', type: 'PC', location: 'Row B · centre' },
  { name: 'PC-06', type: 'PC', location: 'Row B · right' },
  { name: 'PC-07', type: 'PC', location: 'Squad room' },
  { name: 'PC-08', type: 'PC', location: 'Streaming desk' },
  { name: 'PS-01', type: 'PLAYSTATION', location: 'Console lounge' },
  { name: 'PS-02', type: 'PLAYSTATION', location: 'Console lounge' },
];

/** Development-only demo data. Never runs in production. */
export async function seedDevelopment(ctx: Ctx): Promise<{ enrollmentCodes: Record<string, string> }> {
  if (env.isProduction) throw new Error('Refusing to seed development data in production');

  const now = ctx.clock.now();
  // Demo accounts are upserted individually: bootstrapSeed may already have
  // created the administrator before the demo seed runs.
  const demoUsers = [
    { username: 'admin', displayName: 'Cafe Administrator', role: 'ADMIN' as const },
    { username: 'riya', displayName: 'Riya (Front desk)', role: 'STAFF' as const },
    { username: 'arjun', displayName: 'Arjun (Floor)', role: 'STAFF' as const },
  ];

  const existingUsers = await ctx.db.select().from(users);
  for (const demo of demoUsers) {
    if (existingUsers.some((u) => u.username.toLowerCase() === demo.username)) continue;
    await ctx.db.insert(users).values({
      username: demo.username,
      displayName: demo.displayName,
      role: demo.role,
      passwordHash: await hashPassword(DEV_PASSWORD),
      createdAt: now,
      updatedAt: now,
    });
  }

  const allUsers = await ctx.db.select().from(users);
  const admin = allUsers.find((u) => u.role === 'ADMIN')!;
  const riya = allUsers.find((u) => u.username === 'riya')!;
  const arjun = allUsers.find((u) => u.username === 'arjun')!;

  const existingDevices = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(devices);
  let deviceRows = await ctx.db.select().from(devices);

  const enrollmentCodes: Record<string, string> = {};

  if (Number(existingDevices[0]?.count ?? 0) === 0) {
    const inserted = await ctx.db
      .insert(devices)
      .values(
        SEED_DEVICES.map((d) => ({
          name: d.name,
          type: d.type,
          controlMode: d.type === 'PC' ? ('AGENT' as const) : ('MANUAL' as const),
          accessMethod: d.type === 'PC' ? ('SHELL_REPLACE' as const) : ('MANUAL' as const),
          location: d.location,
          notes: d.type === 'PLAYSTATION' ? 'Console lounge — staff-assisted enforcement' : null,
          lastHeartbeatAt: d.type === 'PC' ? new Date(now.getTime() - 12_000) : null,
          agentVersion: d.type === 'PC' ? '1.0.0' : null,
          agentOs: d.type === 'PC' ? 'Windows 11 23H2' : null,
          createdByUserId: admin.id,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();
    deviceRows = inserted;

    for (const device of inserted.filter((d) => d.controlMode === 'AGENT')) {
      const code = generateEnrollmentCode();
      enrollmentCodes[device.name] = code;
      await ctx.db.insert(deviceCredentials).values({
        deviceId: device.id,
        tokenHash: hashToken(`pending:${generateToken(16)}`),
        tokenPrefix: 'pending',
        enrollmentCodeHash: hashToken(code),
        enrollmentExpiresAt: new Date(now.getTime() + 24 * 3_600_000),
        createdAt: now,
      });
    }
  }

  const deviceByName = new Map(deviceRows.map((d) => [d.name, d]));

  const existingSessions = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(sessions);
  if (Number(existingSessions[0]?.count ?? 0) === 0) {
    const mk = (
      name: string,
      opts: {
        by: typeof riya;
        startMinutesAgo: number;
        duration: number;
        nickname: string | null;
        status: 'ACTIVE' | 'ENDED' | 'EXPIRED';
        endedReason?: string;
      },
    ) => {
      const device = deviceByName.get(name)!;
      const startedAt = new Date(now.getTime() - opts.startMinutesAgo * 60_000);
      return {
        deviceId: device.id,
        customerNickname: opts.nickname,
        startedByUserId: opts.by.id,
        startedAt,
        plannedDurationMinutes: opts.duration,
        expiresAt: new Date(startedAt.getTime() + opts.duration * 60_000),
        extendedMinutes: 0,
        status: opts.status,
        endedAt:
          opts.status === 'ACTIVE'
            ? null
            : new Date(startedAt.getTime() + opts.duration * 60_000),
        endedByUserId: opts.status === 'ENDED' ? opts.by.id : null,
        endReason: opts.endedReason ?? null,
        createdAt: startedAt,
        updatedAt: startedAt,
      };
    };

    const rows = await ctx.db
      .insert(sessions)
      .values([
        mk('PC-02', { by: riya, startMinutesAgo: 42, duration: 120, nickname: 'Shadow', status: 'ACTIVE' }),
        mk('PC-05', { by: arjun, startMinutesAgo: 88, duration: 90, nickname: 'Nova', status: 'ACTIVE' }),
        mk('PC-07', { by: riya, startMinutesAgo: 118, duration: 120, nickname: 'Kaz', status: 'ACTIVE' }),
        mk('PS-01', { by: arjun, startMinutesAgo: 55, duration: 60, nickname: 'Rex', status: 'ACTIVE' }),
        mk('PC-01', { by: riya, startMinutesAgo: 260, duration: 60, nickname: 'Ace', status: 'ENDED', endedReason: 'Customer left early' }),
        mk('PC-03', { by: arjun, startMinutesAgo: 420, duration: 90, nickname: 'Pixel', status: 'ENDED', endedReason: 'Time completed' }),
        mk('PC-04', { by: riya, startMinutesAgo: 600, duration: 120, nickname: null, status: 'EXPIRED' }),
        mk('PS-02', { by: arjun, startMinutesAgo: 700, duration: 60, nickname: 'Blaze', status: 'ENDED', endedReason: 'Console reassigned' }),
      ])
      .returning();

    await ctx.db.insert(sessionEvents).values(
      rows.flatMap((row) => {
        const base = {
          sessionId: row.id,
          actorLabel: riya.displayName,
          createdAt: row.startedAt,
        };
        const events: {
          sessionId: string;
          type: string;
          actorUserId: string | null;
          actorLabel: string;
          detail: never;
          createdAt: Date;
        }[] = [
          {
            sessionId: row.id,
            type: 'STARTED',
            actorUserId: row.startedByUserId,
            actorLabel: riya.displayName,
            detail: { durationMinutes: row.plannedDurationMinutes } as never,
            createdAt: row.startedAt,
          },
        ];
        if (row.status === 'ENDED') {
          events.push({
            sessionId: row.id,
            type: 'ENDED',
            actorUserId: row.endedByUserId,
            actorLabel: arjun.displayName,
            detail: { reason: row.endReason } as never,
            createdAt: row.endedAt ?? row.startedAt,
          });
        }
        if (row.status === 'EXPIRED') {
          events.push({
            sessionId: row.id,
            type: 'EXPIRED',
            actorUserId: null,
            actorLabel: 'system',
            detail: { enforcement: 'AGENT' } as never,
            createdAt: row.expiresAt,
          });
        }
        void base;
        return events;
      }),
    );
  }

  await ctx.settings.update({ cafeName: 'Neon Arena · GameHub' }, admin.id);

  const staffCount = allUsers.filter((u) => u.role === 'STAFF').length;
  logger.info('seed.development_complete', {
    devices: deviceRows.length,
    staff: staffCount,
  });

  return { enrollmentCodes };
}

async function runCli() {
  const { createDatabase } = await import('./db/index.js');
  const { systemClock } = await import('./lib/clock.js');
  const { SettingsService } = await import('./services/settings.js');
  const { noopRealtime } = await import('./realtime.js');
  const { ensureDefaultIntegrations } = await import('./integrations/playstation.js');

  const database = await createDatabase();
  const ctx: Ctx = {
    db: database.db,
    clock: systemClock,
    realtime: noopRealtime,
    settings: new SettingsService(database.db, systemClock),
  };

  await ensureDefaultIntegrations(ctx);
  if (process.argv.includes('--bootstrap-only')) {
    await bootstrapSeed(ctx);
    logger.info('seed.bootstrap_complete');
  } else {
    await bootstrapSeed(ctx);
    const { enrollmentCodes } = await seedDevelopment(ctx);
    logger.info('seed.devices', { enrollmentCodes });
    logger.info('seed.credentials', {
      admin: `admin / ${DEV_PASSWORD}`,
      staff: [`riya / ${DEV_PASSWORD}`, `arjun / ${DEV_PASSWORD}`],
    });
  }
  await database.close();
  process.exit(0);
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('/seed.ts');
if (isDirectRun) {
  runCli().catch((error) => {
    logger.error('seed.failed', { error: error instanceof Error ? error.stack : String(error) });
    process.exit(1);
  });
}
