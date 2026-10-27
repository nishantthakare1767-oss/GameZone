import request from 'supertest';
import type { Express } from 'express';
import { createDatabase, type Database, type Db } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createFakeClock, type FakeClock } from '../src/lib/clock.js';
import { createRecordingRealtime } from '../src/realtime.js';
import { SettingsService } from '../src/services/settings.js';
import { ensureDefaultIntegrations } from '../src/integrations/playstation.js';
import { ExpiryWorker } from '../src/services/expiry.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/password.js';
import type { Actor, Ctx } from '../src/context.js';

export const ADMIN_PASSWORD = 'AdminPass123!';
export const STAFF_PASSWORD = 'StaffPass123!';

export interface Harness {
  app: Express;
  ctx: Ctx;
  db: Db;
  database: Database;
  clock: FakeClock;
  realtime: ReturnType<typeof createRecordingRealtime>;
  worker: ExpiryWorker;
  admin: Actor;
  staff: Actor;
  adminCookie: string;
  staffCookie: string;
  close(): Promise<void>;
}

export async function createHarness(
  options: { startAt?: Date } = {},
): Promise<Harness> {
  const database = await createDatabase({ url: 'memory://' });
  const clock = createFakeClock(options.startAt ?? new Date('2026-03-01T04:00:00.000Z'));
  const realtime = createRecordingRealtime();
  const settings = new SettingsService(database.db, clock);
  const ctx: Ctx = { db: database.db, clock, realtime, settings };

  await ensureDefaultIntegrations(ctx);

  const inserted = await database.db
    .insert(users)
    .values([
      {
        username: 'admin',
        displayName: 'Admin User',
        role: 'ADMIN',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
      {
        username: 'staff',
        displayName: 'Staff User',
        role: 'STAFF',
        passwordHash: await hashPassword(STAFF_PASSWORD),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    ])
    .returning();

  const adminRow = inserted.find((u) => u.role === 'ADMIN')!;
  const staffRow = inserted.find((u) => u.role === 'STAFF')!;

  const app = createApp(ctx, { rateLimitEnabled: false });

  const adminCookie = await login(app, 'admin', ADMIN_PASSWORD);
  const staffCookie = await login(app, 'staff', STAFF_PASSWORD);

  const worker = new ExpiryWorker(ctx);

  return {
    app,
    ctx,
    db: database.db,
    database,
    clock,
    realtime,
    worker,
    admin: {
      id: adminRow.id,
      username: adminRow.username,
      displayName: adminRow.displayName,
      role: 'ADMIN',
    },
    staff: {
      id: staffRow.id,
      username: staffRow.username,
      displayName: staffRow.displayName,
      role: 'STAFF',
    },
    adminCookie,
    staffCookie,
    close: async () => {
      await database.close();
    },
  };
}

export async function login(app: Express, username: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const cookie = res.headers['set-cookie'];
  const raw = Array.isArray(cookie) ? cookie[0] : cookie;
  if (!raw) throw new Error('No session cookie returned');
  return raw.split(';')[0]!;
}

export function as(cookie: string) {
  return {
    get: (app: Express, url: string) => request(app).get(url).set('Cookie', cookie),
    post: (app: Express, url: string, body?: unknown) =>
      request(app).post(url).set('Cookie', cookie).send(body as object),
    patch: (app: Express, url: string, body?: unknown) =>
      request(app).patch(url).set('Cookie', cookie).send(body as object),
  };
}

export async function createDevice(
  h: Harness,
  overrides: {
    name?: string;
    type?: 'PC' | 'PLAYSTATION';
    controlMode?: 'AGENT' | 'MANUAL';
    cookie?: string;
  } = {},
): Promise<{ id: string; name: string; enrollmentCode: string | null; controlMode: string }> {
  const res = await as(overrides.cookie ?? h.adminCookie).post(h.app, '/api/devices', {
    name: overrides.name ?? `PC-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    type: overrides.type ?? 'PC',
    controlMode: overrides.controlMode,
  });
  if (res.status !== 201) {
    throw new Error(`Device create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { ...res.body.device, enrollmentCode: res.body.enrollmentCode } as never;
}

export async function startSession(
  h: Harness,
  deviceId: string,
  durationMinutes = 60,
  cookie?: string,
): Promise<{ id: string; expiresAt: string; status: string }> {
  const res = await as(cookie ?? h.staffCookie).post(h.app, '/api/sessions', {
    deviceId,
    durationMinutes,
  });
  if (res.status !== 201) {
    throw new Error(`Session create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.session;
}

export function notificationsFor(
  h: Harness,
  predicate: (n: { kind: string; dedupeKey: string; sessionId?: string | null }) => boolean,
) {
  return h.realtime.events.filter((e) => e.event === 'notification:new').map((e) => e.payload as never as {
    kind: string;
    dedupeKey: string;
    sessionId?: string | null;
  }).filter(predicate);
}
