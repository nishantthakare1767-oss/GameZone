import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import {
  createHarness,
  createDevice,
  startSession,
  as,
  type Harness,
} from './helpers.js';
import { devices, notifications, sessions, workerRuns } from '../src/db/schema.js';
import { ExpiryWorker } from '../src/services/expiry.js';
import { addSeconds } from '../src/lib/clock.js';

describe('automatic session expiry', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const expiryNotifications = () =>
    h.db.select().from(notifications).where(eq(notifications.kind, 'SESSION_EXPIRED'));

  it('expires a session once its time is up and notifies the dashboard', async () => {
    const device = await createDevice(h, { name: 'PC-01' });
    const session = await startSession(h, device.id, 30);

    h.clock.advanceMinutes(31);
    const result = await h.worker.runOnce();

    expect(result.expired).toBe(1);

    const [row] = await h.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row!.status).toBe('EXPIRED');
    expect(row!.endReason).toBe('AUTO_EXPIRED');
    expect(row!.endedAt?.getTime()).toBe(new Date(session.expiresAt).getTime());
    expect(row!.expiredProcessedAt).toBeTruthy();

    const alerts = await expiryNotifications();
    expect(alerts).toHaveLength(1);

    const view = await as(h.staffCookie).get(h.app, `/api/sessions/${session.id}`);
    expect(view.body.session.status).toBe('EXPIRED');
    expect(view.body.events.map((e: { type: string }) => e.type)).toContain('EXPIRED');

    const deviceView = await as(h.staffCookie).get(h.app, `/api/devices/${device.id}`);
    expect(deviceView.body.status).toBe('EXPIRED');
    expect(deviceView.body.restrictionPending).toBe(true);
  });

  it('never processes the same expiry twice across repeated runs', async () => {
    const device = await createDevice(h, { name: 'PC-02' });
    await startSession(h, device.id, 10);
    h.clock.advanceMinutes(11);

    const first = await h.worker.runOnce();
    const second = await h.worker.runOnce();
    const third = await h.worker.runOnce();

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
    expect(third.expired).toBe(0);
    expect(await expiryNotifications()).toHaveLength(1);
  });

  it('recovers sessions that expired while the process was down', async () => {
    const device = await createDevice(h, { name: 'PC-03' });
    const session = await startSession(h, device.id, 60);

    // Simulate downtime: the clock moves on, a brand new worker instance starts.
    h.clock.advanceMinutes(95);
    const restarted = new ExpiryWorker(h.ctx);
    const result = await restarted.runOnce();

    expect(result.expired).toBe(1);
    const [row] = await h.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row!.status).toBe('EXPIRED');
    expect(await expiryNotifications()).toHaveLength(1);

    // Running the restarted worker again stays idempotent.
    await restarted.runOnce();
    expect(await expiryNotifications()).toHaveLength(1);
  });

  it('does not expire a session that was extended before it ran out', async () => {
    const device = await createDevice(h, { name: 'PC-04' });
    const session = await startSession(h, device.id, 30);

    h.clock.advanceMinutes(25);
    await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, {
      minutes: 60,
      idempotencyKey: 'extend-before-expiry',
    });

    h.clock.advanceMinutes(10);
    const result = await h.worker.runOnce();
    expect(result.expired).toBe(0);

    const [row] = await h.db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row!.status).toBe('ACTIVE');
  });

  it('emits five minute and one minute warnings exactly once each', async () => {
    const device = await createDevice(h, { name: 'PC-05' });
    const session = await startSession(h, device.id, 30);

    h.clock.set(new Date(new Date(session.expiresAt).getTime() - 4 * 60_000));
    await h.worker.runOnce();
    await h.worker.runOnce();

    const soon = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'SESSION_EXPIRING_SOON'));
    expect(soon).toHaveLength(1);

    h.clock.set(new Date(new Date(session.expiresAt).getTime() - 30_000));
    await h.worker.runOnce();
    await h.worker.runOnce();

    const final = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'SESSION_EXPIRING_1_MIN'));
    expect(final).toHaveLength(1);
  });

  it('flags a console expiry as staff-assisted', async () => {
    const console_ = await createDevice(h, { name: 'PS-01', type: 'PLAYSTATION' });
    await startSession(h, console_.id, 15);

    h.clock.advanceMinutes(16);
    await h.worker.runOnce();

    const assist = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'STAFF_ASSIST_REQUIRED'));
    expect(assist).toHaveLength(1);
    expect(assist[0]!.message).toMatch(/cannot be locked remotely/i);

    const [device] = await h.db.select().from(devices).where(eq(devices.id, console_.id));
    expect(device!.pendingRestrictionSessionId).toBeNull();
  });

  it('raises one offline alert per outage episode', async () => {
    const device = await createDevice(h, { name: 'PC-06' });
    const stale = addSeconds(h.clock.now(), -600);
    await h.db.update(devices).set({ lastHeartbeatAt: stale }).where(eq(devices.id, device.id));

    await h.worker.runOnce();
    await h.worker.runOnce();

    const alerts = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'AGENT_DISCONNECTED'));
    expect(alerts).toHaveLength(1);

    // A fresh heartbeat starts a new episode; going stale again alerts again.
    await h.db
      .update(devices)
      .set({ lastHeartbeatAt: addSeconds(h.clock.now(), -601) })
      .where(eq(devices.id, device.id));
    await h.worker.runOnce();

    const after = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'AGENT_DISCONNECTED'));
    expect(after).toHaveLength(2);
  });

  it('records worker runs for observability', async () => {
    const device = await createDevice(h, { name: 'PC-07' });
    await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();

    const runs = await h.db.select().from(workerRuns).where(eq(workerRuns.worker, 'expiry'));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((r) => r.status === 'OK' && r.processed > 0)).toBe(true);
  });

  it('exposes worker health over the API', async () => {
    const device = await createDevice(h, { name: 'PC-08' });
    await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();

    const res = await as(h.staffCookie).get(h.app, '/api/health');
    expect(res.status).toBe(200);
    expect(res.body.expiryWorker.lastStatus).toBe('OK');
  });

  it('marks the expired session restricted once the agent confirms', async () => {
    const device = await createDevice(h, { name: 'PC-09' });
    const session = await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();

    let view = await as(h.staffCookie).get(h.app, `/api/devices/${device.id}`);
    expect(view.body.restrictionPending).toBe(true);

    // Enroll an agent and confirm the lock.
    const token = await enroll(h, device.id, device.enrollmentCode!);
    const res = await request(h.app)
      .post('/api/agent/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        events: [
          { type: 'RESTRICTION_APPLIED', action: 'RESTRICT', outcome: 'SUCCESS', sessionId: session.id },
        ],
      });
    expect(res.status).toBe(200);

    view = await as(h.staffCookie).get(h.app, `/api/devices/${device.id}`);
    expect(view.body.status).toBe('RESTRICTED');
    expect(view.body.restrictionPending).toBe(false);

    const detail = await as(h.staffCookie).get(h.app, `/api/sessions/${session.id}`);
    expect(detail.body.session.restrictionConfirmedAt).toBeTruthy();
  });

  it('enforces one active session per device at the database level', async () => {
    const device = await createDevice(h, { name: 'PC-10' });
    await startSession(h, device.id, 30);

    await expect(
      h.db.insert(sessions).values({
        deviceId: device.id,
        startedByUserId: h.staff.id,
        startedAt: h.clock.now(),
        plannedDurationMinutes: 30,
        expiresAt: addSeconds(h.clock.now(), 1800),
        status: 'ACTIVE',
      }),
    ).rejects.toThrow();

    const rows = await h.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.deviceId, device.id), eq(sessions.status, 'ACTIVE')));
    expect(rows).toHaveLength(1);
  });
});

async function enroll(h: Harness, deviceId: string, code: string): Promise<string> {
  const res = await request(h.app).post('/api/agent/register').send({ deviceId, enrollmentCode: code });
  if (res.status !== 201) throw new Error(`enroll failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.deviceToken as string;
}
