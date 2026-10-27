import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { cafeSettings } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';

export interface SettingsShape {
  cafeName: string;
  timezone: string;
  /** Quick-pick durations, minutes. */
  sessionDurations: number[];
  minSessionMinutes: number;
  maxSessionMinutes: number;
  maxExtensionMinutes: number;
  /** Notify staff this many minutes before expiry. */
  expiringSoonMinutes: number;
  expiringWarningMinutes: number;
  /** A PC whose agent has not checked in for this long is shown as offline. */
  deviceOfflineAfterSeconds: number;
  /** How long an agent may keep running on its last authorization while offline. */
  agentGraceSeconds: number;
  /** Expired sessions may be extended only by an explicit staff action. */
  allowExtensionAfterExpiry: boolean;
  /** PlayStation consoles always require staff-assisted enforcement. */
  requireStaffAssistedConsoles: boolean;
  soundNotifications: boolean;
  /** Block new sessions on a device whose agent is offline. */
  blockOfflineDeviceSessions: boolean;
}

export const SETTING_DEFAULTS: SettingsShape = {
  cafeName: 'GameHub Control Center',
  timezone: 'Asia/Kolkata',
  sessionDurations: [30, 60, 90, 120, 180, 240],
  minSessionMinutes: 5,
  maxSessionMinutes: 720,
  maxExtensionMinutes: 240,
  expiringSoonMinutes: 5,
  expiringWarningMinutes: 1,
  deviceOfflineAfterSeconds: 90,
  agentGraceSeconds: 900,
  allowExtensionAfterExpiry: true,
  requireStaffAssistedConsoles: true,
  soundNotifications: true,
  blockOfflineDeviceSessions: false,
};

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as (keyof SettingsShape)[];

const CACHE_TTL_MS = 2_000;

export class SettingsService {
  private cache: SettingsShape | null = null;
  private cachedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async get(): Promise<SettingsShape> {
    const now = this.clock.now().getTime();
    if (this.cache && now - this.cachedAt < CACHE_TTL_MS) return this.cache;

    const rows = await this.db.select().from(cafeSettings);
    const merged: Record<string, unknown> = { ...SETTING_DEFAULTS };
    for (const row of rows) {
      if (row.key in SETTING_DEFAULTS) merged[row.key] = row.value;
    }
    this.cache = merged as unknown as SettingsShape;
    this.cachedAt = now;
    return this.cache;
  }

  invalidate() {
    this.cache = null;
  }

  async update(
    patch: Partial<SettingsShape>,
    userId: string | null,
  ): Promise<SettingsShape> {
    const entries = Object.entries(patch).filter(
      ([key]) => SETTING_KEYS.includes(key as keyof SettingsShape) && key in SETTING_DEFAULTS,
    );
    for (const [key, value] of entries) {
      await this.db
        .insert(cafeSettings)
        .values({ key, value: value as never, updatedByUserId: userId, updatedAt: this.clock.now() })
        .onConflictDoUpdate({
          target: cafeSettings.key,
          set: { value: value as never, updatedByUserId: userId, updatedAt: this.clock.now() },
        });
    }
    this.invalidate();
    return this.get();
  }

  /** Effective grace window for a device (falls back to the cafe-wide value). */
  async graceSecondsFor(deviceGrace: number | null): Promise<number> {
    if (deviceGrace && deviceGrace > 0) return deviceGrace;
    return (await this.get()).agentGraceSeconds;
  }

  async raw(): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select()
      .from(cafeSettings)
      .where(inArray(cafeSettings.key, SETTING_KEYS as unknown as string[]));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async delete(key: string) {
    await this.db.delete(cafeSettings).where(eq(cafeSettings.key, key));
    this.invalidate();
  }
}
