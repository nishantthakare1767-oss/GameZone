import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { authSessions, users } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Actor } from '../context.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Human-friendly enrollment code, e.g. GHUB-4F2A-9C1B. */
export function generateEnrollmentCode(): string {
  const raw = randomBytes(4).toString('hex').toUpperCase();
  return `GHUB-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/** Used to keep login timing roughly constant for unknown usernames. */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

export interface LoginInput {
  username: string;
  password: string;
  userAgent?: string | null;
  ip?: string | null;
  ttlHours: number;
}

export interface LoginResult {
  token: string;
  user: Actor;
  expiresAt: Date;
}

export async function authenticate(
  db: Db,
  clock: Clock,
  input: LoginInput,
): Promise<LoginResult | null> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);
  const user = rows[0];

  if (!user) {
    await verifyPassword(input.password, await dummyHash());
    return null;
  }
  if (!user.isActive) {
    await verifyPassword(input.password, user.passwordHash);
    return null;
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) return null;

  const token = generateToken();
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + input.ttlHours * 3_600_000);

  await db.insert(authSessions).values({
    userId: user.id,
    tokenHash: hashToken(token),
    createdAt: now,
    expiresAt,
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));

  return {
    token,
    expiresAt,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
  };
}

export interface ResolvedAuth {
  user: Actor;
  authSessionId: string;
}

export async function resolveAuth(
  db: Db,
  clock: Clock,
  token: string,
): Promise<ResolvedAuth | null> {
  if (!token) return null;
  const rows = await db
    .select({ session: authSessions, user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, hashToken(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, clock.now()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.user.isActive) return null;
  return {
    authSessionId: row.session.id,
    user: {
      id: row.user.id,
      username: row.user.username,
      displayName: row.user.displayName,
      role: row.user.role,
    },
  };
}

export async function revokeAuth(db: Db, clock: Clock, token: string): Promise<void> {
  if (!token) return;
  await db
    .update(authSessions)
    .set({ revokedAt: clock.now() })
    .where(and(eq(authSessions.tokenHash, hashToken(token)), isNull(authSessions.revokedAt)));
}

export async function revokeAllForUser(db: Db, clock: Clock, userId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: clock.now() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
}
