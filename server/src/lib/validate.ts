import type { Request } from 'express';
import type { ZodType } from 'zod';
import { badRequest } from './errors.js';

/** Express 5 types route params as string | string[]; normalise to a single string. */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return String(value ?? '');
}

export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T>, data: unknown): T {
  return parseBody(schema, data ?? {});
}
