import type { ErrorRequestHandler } from 'express';
import type { z } from 'zod';
import { EngineError } from './engine/types';

/** An error with an HTTP status. Sent as `{ error: code, message }`. */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message ?? code);
  }
}

/** Validate input with zod; throws a 400 `bad_request` listing the failing fields. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const message = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
    throw new HttpError(400, 'bad_request', message);
  }
  return r.data;
}

const ENGINE_STATUS: Record<string, number> = {
  pass_invalid: 410,
  no_events: 400,
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
  } else if (err instanceof EngineError) {
    res.status(ENGINE_STATUS[err.code] ?? 409).json({ error: err.code, message: err.message });
  } else if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'bad_request', message: 'Body is not valid JSON' });
  } else {
    console.error(err);
    res.status(500).json({ error: 'internal', message: 'Something went wrong' });
  }
};
