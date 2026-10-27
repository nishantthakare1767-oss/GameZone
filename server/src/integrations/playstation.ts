import type { Device } from '../db/schema.js';
import type { Ctx } from '../context.js';
import { integrations } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * PlayStation integration boundary.
 *
 * Verified reality (2026): a retail PS5 has no public API for remote session
 * locking or app termination. Anything claiming otherwise relies on either
 * (a) a commercial venue-management product with its own signed API, or
 * (b) fragile screen-scraping of the console UI.
 *
 * So this module ships the honest default: MANUAL enforcement, where the
 * dashboard drives the countdown and staff act on the console. A second
 * adapter is provided for a venue-management HTTP bridge, but it is marked
 * UNVERIFIED until an operator confirms it against their own hardware — the
 * UI will say so, and nothing pretends otherwise.
 */
export interface AdapterCapabilities {
  /** Can the adapter actually block play at expiry without a human? */
  automaticLock: boolean;
  /** Has this adapter been verified against real hardware? */
  verified: boolean;
  /** Can it report console power/online state? */
  connectivity: boolean;
  /** Can it start/stop titles? */
  appControl: boolean;
}

export interface AdapterStatus {
  reachable: boolean;
  detail: string;
  checkedAt: string;
}

export interface PlayStationAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  readonly notes: string;
  status(device: Device): Promise<AdapterStatus>;
  /** Returns whether the console is now blocked. Must never lie. */
  restrict(device: Device, sessionId: string): Promise<{ ok: boolean; message: string }>;
  release(device: Device, sessionId: string): Promise<{ ok: boolean; message: string }>;
}

export class ManualEnforcementAdapter implements PlayStationAdapter {
  readonly id = 'manual-staff-enforcement';
  readonly name = 'Manual staff enforcement';
  readonly notes =
    'Sessions are timed by the server. When the timer ends the dashboard raises a staff alert; a staff member must stop play on the console. No network access to the console is required.';
  readonly capabilities: AdapterCapabilities = {
    automaticLock: false,
    verified: true,
    connectivity: false,
    appControl: false,
  };

  async status(): Promise<AdapterStatus> {
    return {
      reachable: true,
      detail: 'Always available — no hardware integration required.',
      checkedAt: new Date().toISOString(),
    };
  }

  async restrict(_device: Device, _sessionId: string) {
    return {
      ok: false,
      message: 'Manual enforcement: staff must stop the console. No remote lock is available.',
    };
  }

  async release(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Nothing to release: the console is not remotely controlled.' };
  }
}

export class HttpBridgeAdapter implements PlayStationAdapter {
  readonly id = 'http-bridge';
  readonly name = 'Venue management HTTP bridge';
  readonly notes =
    'Calls a venue-management bridge you host yourself (POST /sessions/:id/restrict and /release). UNVERIFIED: enable only after testing against your own console and bridge.';
  readonly capabilities: AdapterCapabilities = {
    automaticLock: true,
    verified: false,
    connectivity: true,
    appControl: true,
  };

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {}

  private async call(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }

  async status(device: Device): Promise<AdapterStatus> {
    if (!this.baseUrl) {
      return { reachable: false, detail: 'Bridge URL is not configured.', checkedAt: new Date().toISOString() };
    }
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return {
        reachable: res.ok,
        detail: res.ok ? 'Bridge responded.' : `Bridge returned HTTP ${res.status}.`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        reachable: false,
        detail: `Bridge unreachable: ${error instanceof Error ? error.message : String(error)}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async restrict(device: Device, sessionId: string) {
    try {
      const res = await this.call('/sessions/restrict', { deviceId: device.id, sessionId });
      return res.ok
        ? { ok: true, message: 'Bridge accepted the restriction.' }
        : { ok: false, message: `Bridge rejected the restriction (HTTP ${res.status}).` };
    } catch (error) {
      return { ok: false, message: `Bridge call failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async release(device: Device, sessionId: string) {
    try {
      const res = await this.call('/sessions/release', { deviceId: device.id, sessionId });
      return res.ok
        ? { ok: true, message: 'Bridge released the restriction.' }
        : { ok: false, message: `Bridge rejected the release (HTTP ${res.status}).` };
    } catch (error) {
      return { ok: false, message: `Bridge call failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export interface IntegrationView {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  status: string;
  notes: string | null;
  capabilities: AdapterCapabilities;
  config: Record<string, unknown>;
  lastCheckedAt: string | null;
}

export async function ensureDefaultIntegrations(ctx: Ctx) {
  const existing = await ctx.db.select().from(integrations);
  if (existing.length > 0) return;
  await ctx.db.insert(integrations).values({
    kind: 'PLAYSTATION',
    name: 'PlayStation session management',
    enabled: true,
    config: { adapter: 'manual-staff-enforcement' },
    status: 'MANUAL_ENFORCEMENT',
    notes:
      'No verified remote-lock API exists for retail PS5 consoles. Sessions are timed server-side and staff enforce expiry.',
  });
}

export async function listIntegrations(ctx: Ctx): Promise<IntegrationView[]> {
  const rows = await ctx.db.select().from(integrations);
  return rows.map((row) => {
    const adapter = resolveAdapter(row.config as Record<string, unknown>);
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      enabled: row.enabled,
      status: row.status,
      notes: row.notes,
      capabilities: adapter.capabilities,
      config: (row.config as Record<string, unknown>) ?? {},
      lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    };
  });
}

export function resolveAdapter(config: Record<string, unknown> | null | undefined): PlayStationAdapter {
  const kind = (config?.adapter as string) ?? 'manual-staff-enforcement';
  if (kind === 'http-bridge') {
    return new HttpBridgeAdapter(
      (config?.baseUrl as string) ?? '',
      process.env.PS_BRIDGE_API_KEY,
    );
  }
  return new ManualEnforcementAdapter();
}

/** The adapter used for a given console device. */
export async function adapterForDevice(ctx: Ctx, device: Device): Promise<PlayStationAdapter> {
  if (device.type !== 'PLAYSTATION') return new ManualEnforcementAdapter();
  const rows = await ctx.db
    .select()
    .from(integrations)
    .where(eq(integrations.kind, 'PLAYSTATION'))
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return new ManualEnforcementAdapter();
  return resolveAdapter(row.config as Record<string, unknown>);
}
