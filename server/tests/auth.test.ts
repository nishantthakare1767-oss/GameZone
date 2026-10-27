import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createHarness, as, ADMIN_PASSWORD, STAFF_PASSWORD, type Harness } from './helpers.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/password.js';

describe('authentication and permissions', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('signs in with valid credentials', async () => {
    const res = await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
  });

  it('rejects a wrong password and never reveals whether the user exists', async () => {
    const wrong = await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'nope-nope-nope' });
    const unknown = await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'ghost', password: 'nope-nope-nope' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('blocks dashboard APIs without a session', async () => {
    for (const url of ['/api/devices', '/api/sessions', '/api/dashboard/summary', '/api/staff']) {
      const res = await request(h.app).get(url);
      expect(res.status).toBe(401);
    }
  });

  it('rejects a forged session cookie', async () => {
    const res = await as('gamehub_session=not-a-real-token').get(h.app, '/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the signed-in user', async () => {
    const res = await as(h.staffCookie).get(h.app, '/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('staff');
  });

  it('lets staff read devices but not create them', async () => {
    const list = await as(h.staffCookie).get(h.app, '/api/devices');
    expect(list.status).toBe(200);

    const create = await as(h.staffCookie).post(h.app, '/api/devices', { name: 'PC-99', type: 'PC' });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('FORBIDDEN');
  });

  it('protects the audit log from staff', async () => {
    const res = await as(h.staffCookie).get(h.app, '/api/audit');
    expect(res.status).toBe(403);
  });

  it('invalidates the token on logout', async () => {
    const cookie = h.staffCookie;
    const out = await as(cookie).post(h.app, '/api/auth/logout');
    expect(out.status).toBe(200);

    const me = await as(cookie).get(h.app, '/api/auth/me');
    expect(me.status).toBe(401);
  });

  it('rejects a deactivated account even with a valid password', async () => {
    await h.db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.username, 'staff'));

    const res = await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'staff', password: STAFF_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('refuses to deactivate your own account', async () => {
    const patch = await as(h.adminCookie).patch(h.app, `/api/staff/${h.admin.id}`, { isActive: false });
    expect(patch.status).toBe(400);
    expect(patch.body.error.message).toMatch(/your own account/i);
  });

  it('prevents demoting the last active administrator', async () => {
    const patch = await as(h.adminCookie).patch(h.app, `/api/staff/${h.admin.id}`, { role: 'STAFF' });
    expect(patch.status).toBe(400);
    expect(patch.body.error.message).toMatch(/administrator/i);
  });

  it('allows an administrator to create staff and that staff can sign in', async () => {
    const created = await as(h.adminCookie).post(h.app, '/api/staff', {
      username: 'newstaff',
      displayName: 'New Staff',
      role: 'STAFF',
      password: 'AnotherPass123!',
    });
    expect(created.status).toBe(201);

    const login = await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'newstaff', password: 'AnotherPass123!' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('STAFF');
  });

  it('changes the password and revokes other sessions', async () => {
    await h.db
      .update(users)
      .set({ passwordHash: await hashPassword(STAFF_PASSWORD) })
      .where(eq(users.username, 'staff'));

    const otherSession = await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'staff', password: STAFF_PASSWORD });
    const otherCookie = otherSession.headers['set-cookie']![0]!.split(';')[0]!;

    const change = await as(h.staffCookie).post(h.app, '/api/auth/password', {
      currentPassword: STAFF_PASSWORD,
      newPassword: 'BrandNewPass123!',
    });
    expect(change.status).toBe(200);

    const revoked = await as(otherCookie).get(h.app, '/api/auth/me');
    expect(revoked.status).toBe(401);

    const relogin = await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'staff', password: 'BrandNewPass123!' });
    expect(relogin.status).toBe(200);
  });

  it('rejects weak passwords', async () => {
    const res = await as(h.staffCookie).post(h.app, '/api/auth/password', {
      currentPassword: STAFF_PASSWORD,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('records login and denial events in the audit log', async () => {
    await request(h.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong-password' });

    const audit = await as(h.adminCookie).get(h.app, '/api/audit?action=AUTH_LOGIN');
    expect(audit.status).toBe(200);
    const actions = audit.body.items.map((i: { action: string; outcome: string }) => `${i.action}:${i.outcome}`);
    expect(actions).toContain('AUTH_LOGIN:SUCCESS');
    expect(actions).toContain('AUTH_LOGIN:DENIED');
  });
});
