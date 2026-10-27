import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createDevice, startSession, as, type Harness } from './helpers.js';

describe('device management', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('creates a device and issues an enrollment code for PC agents', async () => {
    const device = await createDevice(h, { name: 'PC-01', type: 'PC' });
    expect(device.name).toBe('PC-01');
    expect(device.controlMode).toBe('AGENT');
    expect(device.enrollmentCode).toMatch(/^GHUB-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('marks consoles as manually enforced with no enrollment code', async () => {
    const device = await createDevice(h, { name: 'PS-01', type: 'PLAYSTATION' });
    expect(device.controlMode).toBe('MANUAL');
    expect(device.enrollmentCode).toBeNull();

    const view = await as(h.adminCookie).get(h.app, `/api/devices/${device.id}`);
    expect(view.body.requiresStaffEnforcement).toBe(true);
    expect(view.body.connectivity).toBe('MANUAL');
  });

  it('rejects duplicate names case-insensitively', async () => {
    await createDevice(h, { name: 'PC-07' });
    const res = await as(h.adminCookie).post(h.app, '/api/devices', { name: 'pc-07', type: 'PC' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVICE_NAME_TAKEN');
  });

  it('supports more devices than the initial capacity without code changes', async () => {
    for (let i = 1; i <= 14; i += 1) {
      await createDevice(h, { name: `PC-${String(i).padStart(2, '0')}` });
    }
    for (let i = 1; i <= 4; i += 1) {
      await createDevice(h, { name: `PS-${String(i).padStart(2, '0')}`, type: 'PLAYSTATION' });
    }

    const summary = await as(h.adminCookie).get(h.app, '/api/dashboard/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.totals.devices).toBe(18);
    expect(summary.body.totals.pcs).toBe(14);
    expect(summary.body.totals.consoles).toBe(4);
  });

  it('validates device input', async () => {
    const res = await as(h.adminCookie).post(h.app, '/api/devices', { name: 'X', type: 'TOASTER' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('updates a device name and rejects collisions', async () => {
    const a = await createDevice(h, { name: 'PC-A' });
    await createDevice(h, { name: 'PC-B' });

    const ok = await as(h.adminCookie).patch(h.app, `/api/devices/${a.id}`, { name: 'PC-ALPHA' });
    expect(ok.status).toBe(200);
    expect(ok.body.device.name).toBe('PC-ALPHA');

    const clash = await as(h.adminCookie).patch(h.app, `/api/devices/${a.id}`, { name: 'PC-B' });
    expect(clash.status).toBe(409);
  });

  it('blocks archiving a device with an active session', async () => {
    const device = await createDevice(h, { name: 'PC-05' });
    await startSession(h, device.id, 60);

    const res = await as(h.adminCookie).post(h.app, `/api/devices/${device.id}/archive`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVICE_HAS_ACTIVE_SESSION');
  });

  it('archives a device once its session is resolved and keeps history', async () => {
    const device = await createDevice(h, { name: 'PC-06' });
    const session = await startSession(h, device.id, 30);
    await as(h.staffCookie).post(h.app, `/api/sessions/${session.id}/end`, { reason: 'Test cleanup' });

    const archived = await as(h.adminCookie).post(h.app, `/api/devices/${device.id}/archive`);
    expect(archived.status).toBe(200);

    const list = await as(h.adminCookie).get(h.app, '/api/devices');
    expect(list.body.items.map((d: { id: string }) => d.id)).not.toContain(device.id);

    const history = await as(h.adminCookie).get(h.app, `/api/devices/${device.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.sessions.length).toBe(1);
  });

  it('toggles maintenance and refuses sessions while in maintenance', async () => {
    const device = await createDevice(h, { name: 'PC-08' });
    const res = await as(h.adminCookie).post(h.app, `/api/devices/${device.id}/maintenance`, {
      maintenance: true,
      reason: 'GPU re-seat',
    });
    expect(res.status).toBe(200);
    expect(res.body.device.status).toBe('MAINTENANCE');

    const attempt = await as(h.staffCookie).post(h.app, '/api/sessions', {
      deviceId: device.id,
      durationMinutes: 30,
    });
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('DEVICE_MAINTENANCE');
  });

  it('rotates an enrollment code and revokes the previous device token', async () => {
    const device = await createDevice(h, { name: 'PC-09' });
    const firstCode = device.enrollmentCode!;

    const enroll = await as(h.adminCookie).post(h.app, `/api/devices/${device.id}/enrollment`);
    expect(enroll.status).toBe(200);
    expect(enroll.body.enrollmentCode).not.toBe(firstCode);

    const oldRegister = await as(h.adminCookie).post(h.app, '/api/agent/register', {
      deviceId: device.id,
      enrollmentCode: firstCode,
    });
    expect(oldRegister.status).toBe(401);

    const newRegister = await as(h.adminCookie).post(h.app, '/api/agent/register', {
      deviceId: device.id,
      enrollmentCode: enroll.body.enrollmentCode,
    });
    expect(newRegister.status).toBe(201);
    expect(newRegister.body.deviceToken).toBeTruthy();
  });

  it('reports connectivity separately from operational status', async () => {
    const device = await createDevice(h, { name: 'PC-10' });
    const view = await as(h.adminCookie).get(h.app, `/api/devices/${device.id}`);
    expect(view.body.status).toBe('AVAILABLE');
    expect(view.body.connectivity).toBe('NEVER_CONNECTED');
  });
});
