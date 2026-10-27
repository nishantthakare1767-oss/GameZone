import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createDevice, startSession, as, type Harness } from './helpers.js';

describe('session lifecycle', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('starts a session and computes expiry from the server clock', async () => {
    const device = await createDevice(h, { name: 'PC-01' });
    const session = await startSession(h, device.id, 90);

    expect(session.status).toBe('ACTIVE');
    expect(session.expiresAt).toBe(
      new Date(h.clock.now().getTime() + 90 * 60_000).toISOString(),
    );

    const view = await as(h.staffCookie).get(h.app, `/api/sessions/${session.id}`);
    expect(view.body.session.remainingSeconds).toBe(5400);

    const deviceView = await as(h.staffCookie).get(h.app, `/api/devices/${device.id}`);
    expect(deviceView.body.status).toBe('ACTIVE');
    expect(deviceView.body.session.id).toBe(session.id);
  });

  it('rejects durations outside the configured window', async () => {
    const device = await createDevice(h, { name: 'PC-02' });

    const tooShort = await as(h.staffCookie).post(h.app, '/api/sessions', {
      deviceId: device.id,
      durationMinutes: 1,
    });
    expect(tooShort.status).toBe(400);

    const tooLong = await as(h.staffCookie).post(h.app, '/api/sessions', {
      deviceId: device.id,
      durationMinutes: 5000,
    });
    expect(tooLong.status).toBe(400);
  });

  it('refuses a second active session on the same device', async () => {
    const device = await createDevice(h, { name: 'PC-03' });
    await startSession(h, device.id, 60);

    const again = await as(h.staffCookie).post(h.app, '/api/sessions', {
      deviceId: device.id,
      durationMinutes: 30,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DEVICE_BUSY');
  });

  it('survives concurrent start requests with exactly one winner', async () => {
    const device = await createDevice(h, { name: 'PC-04' });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        as(h.staffCookie).post(h.app, '/api/sessions', {
          deviceId: device.id,
          durationMinutes: 60,
        }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.body.error.code === 'DEVICE_BUSY')).toBe(true);

    const active = await as(h.staffCookie).get(h.app, '/api/sessions/active');
    expect(active.body.items).toHaveLength(1);
  });

  it('extends a session and records the extension', async () => {
    const device = await createDevice(h, { name: 'PC-05' });
    const session = await startSession(h, device.id, 60);
    const originalExpiry = new Date(session.expiresAt).getTime();

    const extend = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, {
      minutes: 30,
      idempotencyKey: 'extend-key-0001',
    });

    expect(extend.status).toBe(200);
    expect(extend.body.replayed).toBe(false);
    expect(new Date(extend.body.session.expiresAt).getTime()).toBe(originalExpiry + 30 * 60_000);
    expect(extend.body.session.extendedMinutes).toBe(30);

    const detail = await as(h.staffCookie).get(h.app, `/api/sessions/${session.id}`);
    expect(detail.body.extensions).toHaveLength(1);
    expect(detail.body.extensions[0].minutes).toBe(30);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toContain('EXTENDED');
  });

  it('never adds time twice for a retried extension', async () => {
    const device = await createDevice(h, { name: 'PC-06' });
    const session = await startSession(h, device.id, 60);

    const payload = { minutes: 45, idempotencyKey: 'retry-key-abcdef' };
    const first = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, payload);
    const second = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, payload);
    const third = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, payload);

    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(third.body.replayed).toBe(true);
    expect(second.body.session.expiresAt).toBe(first.body.session.expiresAt);
    expect(third.body.session.expiresAt).toBe(first.body.session.expiresAt);
    expect(third.body.session.extendedMinutes).toBe(45);

    const detail = await as(h.staffCookie).get(h.app, `/api/sessions/${session.id}`);
    expect(detail.body.extensions).toHaveLength(1);
  });

  it('deduplicates concurrent extension retries', async () => {
    const device = await createDevice(h, { name: 'PC-07' });
    const session = await startSession(h, device.id, 60);

    const payload = { minutes: 15, idempotencyKey: 'parallel-key-1234' };
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, payload),
      ),
    );

    const expiries = new Set(results.map((r) => r.body.session.expiresAt));
    expect(expiries.size).toBe(1);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);

    const detail = await as(h.staffCookie).get(h.app, `/api/sessions/${session.id}`);
    expect(detail.body.extensions).toHaveLength(1);
  });

  it('requires an explicit reactivation for an expired session', async () => {
    const device = await createDevice(h, { name: 'PC-08' });
    const session = await startSession(h, device.id, 30);

    h.clock.advanceMinutes(31);
    await h.worker.runOnce();

    const blocked = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, {
      minutes: 15,
      idempotencyKey: 'expired-no-confirm',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('REACTIVATION_REQUIRED');

    const reactivated = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, {
      minutes: 15,
      idempotencyKey: 'expired-with-confirm',
      reactivate: true,
    });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.reactivated).toBe(true);
    expect(reactivated.body.session.status).toBe('ACTIVE');
    // Time restarts from now, expired minutes are not credited back.
    expect(new Date(reactivated.body.session.expiresAt).getTime()).toBe(
      h.clock.now().getTime() + 15 * 60_000,
    );
  });

  it('will not extend a finished session', async () => {
    const device = await createDevice(h, { name: 'PC-09' });
    const session = await startSession(h, device.id, 60);
    await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/end`, { reason: 'Customer left' });

    const extend = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/extend`, {
      minutes: 15,
      idempotencyKey: 'ended-session-key',
    });
    expect(extend.status).toBe(409);
    expect(extend.body.error.code).toBe('SESSION_ENDED');
  });

  it('ends a session early and frees the device', async () => {
    const device = await createDevice(h, { name: 'PC-10' });
    const session = await startSession(h, device.id, 120);

    const end = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/end`, {
      reason: 'Customer finished early',
    });
    expect(end.status).toBe(200);
    expect(end.body.session.status).toBe('ENDED');
    expect(end.body.session.endReason).toBe('Customer finished early');
    expect(end.body.session.endedBy.displayName).toBe(h.staff.displayName);

    const deviceView = await as(h.staffCookie).get(h.app, `/api/devices/${device.id}`);
    expect(deviceView.body.status).toBe('AVAILABLE');

    // A new session can start immediately afterwards.
    const next = await startSession(h, device.id, 30);
    expect(next.status).toBe('ACTIVE');
  });

  it('requires a reason to end a session', async () => {
    const device = await createDevice(h, { name: 'PC-11' });
    const session = await startSession(h, device.id, 60);

    const res = await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/end`, { reason: '' });
    expect(res.status).toBe(400);
  });

  it('returns searchable session history', async () => {
    const device = await createDevice(h, { name: 'PC-12' });
    const session = await startSession(h, device.id, 30);
    await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/end`, { reason: 'done' });

    const byDevice = await as(h.staffCookie).get(h.app, `/api/sessions?deviceId=${device.id}`);
    expect(byDevice.body.items).toHaveLength(1);

    const byStatus = await as(h.staffCookie).get(h.app, '/api/sessions?status=ENDED');
    expect(byStatus.body.items.length).toBe(1);

    const byStaff = await as(h.staffCookie).get(h.app, `/api/sessions?staffId=${h.staff.id}`);
    expect(byStaff.body.items.length).toBe(1);

    const noMatch = await as(h.staffCookie).get(h.app, '/api/sessions?search=nobody');
    expect(noMatch.body.items).toHaveLength(0);
  });

  it('stores an optional customer nickname and never requires it', async () => {
    const device = await createDevice(h, { name: 'PC-13' });
    const withNickname = await as(h.staffCookie).post(h.app, '/api/sessions', {
      deviceId: device.id,
      durationMinutes: 30,
      customerNickname: 'Shadow',
    });
    expect(withNickname.body.session.customerNickname).toBe('Shadow');
  });
});
