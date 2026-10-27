import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createHarness, createDevice, startSession, as, type Harness } from './helpers.js';
import { devices, notifications } from '../src/db/schema.js';

describe('device agent API', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  async function enroll(
    deviceId: string,
    code: string,
    version = '1.0.0',
  ): Promise<{ status: number; token?: string; body: Record<string, unknown> }> {
    const res = await request(h.app)
      .post('/api/agent/register')
      .send({ deviceId, enrollmentCode: code, agentVersion: version, os: 'Windows 11' });
    return { status: res.status, token: res.body.deviceToken, body: res.body };
  }

  const heartbeat = (token: string, body: Record<string, unknown> = {}) =>
    request(h.app).post('/api/agent/heartbeat').set('Authorization', `Bearer ${token}`).send(body);

  it('exchanges an enrollment code for a device token exactly once', async () => {
    const device = await createDevice(h, { name: 'PC-01' });
    const first = await enroll(device.id, device.enrollmentCode!);

    expect(first.status).toBe(201);
    expect(first.token).toBeTruthy();
    expect(first.body.device).toMatchObject({ name: 'PC-01' });

    const replay = await enroll(device.id, device.enrollmentCode!);
    expect(replay.status).toBe(401);
  });

  it('rejects unknown enrollment codes', async () => {
    const device = await createDevice(h, { name: 'PC-02' });
    const res = await enroll(device.id, 'GHUB-0000-0000');
    expect(res.status).toBe(401);
  });

  it('rejects agent calls without a token', async () => {
    await request(h.app).post('/api/agent/heartbeat').send({}).expect(401);
    await request(h.app).get('/api/agent/session-state').expect(401);
  });

  it('rejects a bogus token', async () => {
    await heartbeat('definitely-not-a-token').expect(401);
  });

  it('records heartbeats and reports authorized session state', async () => {
    const device = await createDevice(h, { name: 'PC-03' });
    const { token } = await enroll(device.id, device.enrollmentCode!);
    const session = await startSession(h, device.id, 60);

    const res = await heartbeat(token!, { agentVersion: '1.2.3' });
    expect(res.status).toBe(200);
    expect(res.body.authorization.state).toBe('AUTHORIZED');
    expect(res.body.authorization.session.id).toBe(session.id);
    expect(res.body.authorization.graceSeconds).toBe(900);

    const [row] = await h.db.select().from(devices).where(eq(devices.id, device.id));
    expect(row!.lastHeartbeatAt).toBeTruthy();
    expect(row!.agentVersion).toBe('1.2.3');

    const dashboard = await as(h.staffCookie).get(h.app, `/api/devices/${device.id}`);
    expect(dashboard.body.connectivity).toBe('ONLINE');
  });

  it('reports expiry even before the worker has processed it', async () => {
    const device = await createDevice(h, { name: 'PC-04' });
    const { token } = await enroll(device.id, device.enrollmentCode!);
    await startSession(h, device.id, 30);

    h.clock.advanceMinutes(31);
    const res = await request(h.app)
      .get('/api/agent/session-state')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.authorization.state).toBe('EXPIRED');
  });

  it('reports no session on an idle device', async () => {
    const device = await createDevice(h, { name: 'PC-05' });
    const { token } = await enroll(device.id, device.enrollmentCode!);

    const res = await request(h.app)
      .get('/api/agent/session-state')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.authorization.state).toBe('NO_SESSION');
  });

  it('blocks a disabled device at authorization time', async () => {
    const device = await createDevice(h, { name: 'PC-06' });
    const { token } = await enroll(device.id, device.enrollmentCode!);
    await as(h.adminCookie).patch(h.app, `/api/devices/${device.id}`, { enabled: false });

    const res = await request(h.app)
      .get('/api/agent/session-state')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.authorization.state).toBe('DISABLED');
  });

  it('records restriction failures and raises a critical alert', async () => {
    const device = await createDevice(h, { name: 'PC-07' });
    const { token } = await enroll(device.id, device.enrollmentCode!);
    const session = await startSession(h, device.id, 10);

    const res = await request(h.app)
      .post('/api/agent/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        events: [
          {
            type: 'RESTRICTION_FAILED',
            action: 'RESTRICT',
            outcome: 'FAILED',
            sessionId: session.id,
            message: 'Kiosk shell could not acquire the desktop',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.failed).toHaveLength(1);

    const [row] = await h.db.select().from(devices).where(eq(devices.id, device.id));
    expect(row!.agentError).toMatch(/kiosk shell/i);

    const alerts = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'ACCESS_RESTRICTION_FAILED'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('CRITICAL');
  });

  it('cannot reach dashboard endpoints with a device token', async () => {
    const device = await createDevice(h, { name: 'PC-08' });
    const { token } = await enroll(device.id, device.enrollmentCode!);

    for (const url of ['/api/devices', '/api/sessions', '/api/dashboard/summary', '/api/staff']) {
      const res = await request(h.app).get(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  it('stops accepting a token after credential rotation', async () => {
    const device = await createDevice(h, { name: 'PC-09' });
    const { token } = await enroll(device.id, device.enrollmentCode!);
    await heartbeat(token!).expect(200);

    await as(h.adminCookie).post(h.app, `/api/devices/${device.id}/enrollment`);
    await heartbeat(token!).expect(401);
  });

  it('notifies staff when an agent reconnects after an outage', async () => {
    const device = await createDevice(h, { name: 'PC-10' });
    const { token } = await enroll(device.id, device.enrollmentCode!);
    await heartbeat(token!).expect(200);

    // Go offline beyond the threshold, then check back in.
    h.clock.advanceMinutes(5);
    const res = await heartbeat(token!);
    expect(res.status).toBe(200);

    const alerts = await h.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'AGENT_RECONNECTED'));
    expect(alerts).toHaveLength(1);
  });

  it('validates heartbeat payloads', async () => {
    const device = await createDevice(h, { name: 'PC-11' });
    const { token } = await enroll(device.id, device.enrollmentCode!);

    const res = await heartbeat(token!, { accessState: 'NOT_A_STATE' });
    expect(res.status).toBe(400);
  });

  it('rejects enrollment onto a console device', async () => {
    const console_ = await createDevice(h, { name: 'PS-01', type: 'PLAYSTATION' });
    const res = await request(h.app)
      .post('/api/agent/register')
      .send({ deviceId: console_.id, enrollmentCode: 'GHUB-1111-2222' });
    expect(res.status).toBe(400);
  });
});
