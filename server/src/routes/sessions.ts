import { Router } from 'express';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { requireAuth } from '../auth/middleware.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseBody, pathParam } from '../lib/validate.js';
import {
  createSession,
  endSession,
  extendSession,
  getSessionEvents,
  getSessionExtensions,
  getSessionView,
  listSessions,
} from '../services/sessions.js';
import { listActiveSessionViews } from '../services/queries.js';

const createSchema = z.object({
  deviceId: z.string().uuid(),
  durationMinutes: z.number().int().min(1).max(1440),
  customerNickname: z.string().trim().max(40).nullish(),
});

const extendSchema = z.object({
  minutes: z.number().int().min(1).max(1440),
  idempotencyKey: z.string().min(8).max(120),
  reactivate: z.boolean().optional(),
  note: z.string().trim().max(200).nullish(),
});

const endSchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

const listSchema = z.object({
  deviceId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'ENDED']).optional(),
  staffId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function sessionRoutes(ctx: Ctx) {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (req, res) => {
    const query = parseBody(listSchema, req.query);
    const page = await listSessions(ctx, {
      deviceId: query.deviceId,
      status: query.status,
      staffId: query.staffId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    });
    res.json(page);
  });

  router.get('/active', async (_req, res) => {
    res.json({ items: await listActiveSessionViews(ctx) });
  });

  router.post('/', async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const session = await createSession(
      ctx,
      {
        deviceId: body.deviceId,
        durationMinutes: body.durationMinutes,
        customerNickname: body.customerNickname ?? null,
      },
      req.user!,
      req.ip,
    );
    res.status(201).json({ session });
  });

  router.get('/:id', async (req, res) => {
    const [session, extensions, events] = await Promise.all([
      getSessionView(ctx, pathParam(req, "id")),
      getSessionExtensions(ctx.db, pathParam(req, "id")),
      getSessionEvents(ctx.db, pathParam(req, "id")),
    ]);
    if (!session) throw notFound('Session not found');
    res.json({
      session,
      extensions,
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        actorLabel: e.actorLabel,
        detail: e.detail,
        at: e.createdAt.toISOString(),
      })),
    });
  });

  router.post('/:id/extend', async (req, res) => {
    const body = parseBody(extendSchema, req.body);
    const result = await extendSession(
      ctx,
      {
        sessionId: pathParam(req, "id"),
        minutes: body.minutes,
        idempotencyKey: body.idempotencyKey,
        reactivate: body.reactivate,
        note: body.note ?? null,
      },
      req.user!,
      req.ip,
    );
    res.json(result);
  });

  router.post('/:id/end', async (req, res) => {
    const body = parseBody(endSchema, req.body);
    if (pathParam(req, "id").length < 8) throw badRequest('Invalid session id');
    const session = await endSession(ctx, { sessionId: pathParam(req, "id"), reason: body.reason }, req.user!, req.ip);
    res.json({ session });
  });

  router.get('/:id/events', async (req, res) => {
    const [events, extensions] = await Promise.all([
      getSessionEvents(ctx.db, pathParam(req, "id")),
      getSessionExtensions(ctx.db, pathParam(req, "id")),
    ]);
    res.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        actorLabel: e.actorLabel,
        detail: e.detail,
        at: e.createdAt.toISOString(),
      })),
      extensions,
    });
  });

  return router;
}
