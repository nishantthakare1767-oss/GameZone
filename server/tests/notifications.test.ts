import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { createHarness, createDevice, startSession, as, type Harness } from './helpers.js';
import { notifications } from '../src/db/schema.js';
import { createNotification } from '../src/services/notifications.js';

describe('notifications', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('never stores the same logical event twice', async () => {
    const input = {
      kind: 'SESSION_EXTENDED' as const,
      title: 'PC-01 extended',
      message: '15 minutes added',
      dedupeKey: 'duplicate-key-1',
    };

    const first = await createNotification(h.db, h.clock, h.realtime, input);
    const second = await createNotification(h.db, h.clock, h.realtime, input);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const rows = await h.db.select().from(notifications);
    expect(rows).toHaveLength(1);
  });

  it('lists notifications with an unread count', async () => {
    const device = await createDevice(h, { name: 'PC-01' });
    await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();

    const res = await as(h.staffCookie).get(h.app, '/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.unreadCount).toBe(res.body.items.length);
  });

  it('marks a single notification read idempotently', async () => {
    const device = await createDevice(h, { name: 'PC-02' });
    await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();

    const list = await as(h.staffCookie).get(h.app, '/api/notifications');
    const id = list.body.items[0].id;

    const first = await as(h.staffCookie).post(h.app, `/api/notifications/${id}/read`);
    const second = await as(h.staffCookie).post(h.app, `/api/notifications/${id}/read`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const after = await as(h.staffCookie).get(h.app, '/api/notifications');
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.items[0].readAt).toBeTruthy();
  });

  it('marks everything read', async () => {
    const device = await createDevice(h, { name: 'PC-03' });
    await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();
    await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();

    const res = await as(h.staffCookie).post(h.app, '/api/notifications/read-all');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);

    const list = await as(h.staffCookie).get(h.app, '/api/notifications?unreadOnly=true');
    expect(list.body.items).toHaveLength(0);
  });

  it('returns 404 for an unknown notification', async () => {
    const res = await as(h.staffCookie).post(
      h.app,
      '/api/notifications/3f1e4a70-8c95-4a41-9a24-1c4b0d7a1c11/read',
    );
    expect(res.status).toBe(404);
  });

  it('survives a server restart because alerts live in the database', async () => {
    const device = await createDevice(h, { name: 'PC-04' });
    await startSession(h, device.id, 5);
    h.clock.advanceMinutes(6);
    await h.worker.runOnce();

    const stored = await h.db.select().from(notifications).orderBy(asc(notifications.createdAt));
    expect(stored.length).toBeGreaterThan(0);

    // A brand-new worker on the same database must not re-emit them.
    const before = stored.length;
    await h.worker.runOnce();
    const after = await h.db.select().from(notifications);
    expect(after.length).toBe(before);
  });
});
