import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Wrap async handlers so rejected promises reach the error middleware (Express 4). */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return;
  }
  const pgCode = (err as { code?: string }).code;
  if (pgCode === '23505') {
    res.status(409).json({ error: 'A record with these details already exists' });
    return;
  }
  if (pgCode === '23000' || pgCode === '23514') {
    res.status(409).json({ error: (err as Error).message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
