import type { Request, Response, NextFunction } from 'express';
import { ZodError, z } from 'zod';
import { localize, pickLocale } from './i18n.js';
import { logError } from './logger.js';

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 422, public details: any = {}) {
    super(message);
  }
}
export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found`, 404);
export const conflict = (code: string, message: string, details: any = {}) =>
  new DomainError(code, message, 409, details);
export const forbidden = (message = 'Permission denied') => new DomainError('FORBIDDEN', message, 403);

/**
 * Blueprint status-code table (section 8/9): a bay/resource overlap and an insufficient-stock
 * request are both "400 Bad Request". Generic duplicates, separation-of-duties and similar state
 * conflicts stay 409 through `conflict()` above.
 */
export const bayConflict = (code: string, message: string, details: any = {}) =>
  new DomainError(code, message, 400, details);
export const insufficientStock = (message: string, details: any = {}) =>
  new DomainError('INSUFFICIENT_STOCK', message, 400, details);

export const ok = (res: Response, data: any, meta: any = {}) =>
  res.json({ data, meta, error: null });

/** Same envelope as `ok`, but 201 Created for endpoints that create a resource (blueprint sections 2-4). */
export const created = (res: Response, data: any, meta: any = {}) =>
  res.status(201).json({ data, meta, error: null });

/** Messages are localized from the bilingual catalog using the request's Accept-Language header. */
export const fail = (res: Response, status: number, code: string, message: string, details: any = {}) => {
  const locale = pickLocale((res.req as any)?.headers?.['accept-language']);
  return res.status(status).json({
    data: null, meta: { locale },
    error: { code, message: localize(code, message, locale), messageEn: message, details },
  });
};

export const asyncRoute =
  (fn: any) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export const uuid = z.string().uuid();

/** Cursor-free page/pageSize pagination used by every list endpoint. */
export const pageParams = (req: Request) => {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

export const toCsv = (rows: any[]): string => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
};

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as any).requestId;
  if (err instanceof ZodError) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Request payload failed validation', {
      requestId,
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof DomainError) {
    return fail(res, err.status, err.code, err.message, { ...err.details, requestId });
  }
  // Postgres constraint violations mapped to stable API codes
  // 22P02 = invalid text representation, e.g. GET /jobs/abc. This used to surface as a 500.
  if (err?.code === '22P02')
    return fail(res, 400, 'VALIDATION_ERROR', 'A path or query parameter is not a valid value', {
      requestId,
      hint: 'Identifiers must be UUIDs',
    });
  if (err?.code === '23P01')
    return fail(res, 400, 'RESOURCE_CONFLICT', 'The requested window overlaps an existing booking', {
      requestId,
      constraint: err.constraint,
    });
  if (err?.code === '42501')
    return fail(res, 403, 'IMMUTABLE_RECORD', 'This record is append-only and cannot be modified', { requestId });
  if (err?.code === '23505') return fail(res, 409, 'DUPLICATE', 'Resource already exists', { requestId, constraint: err.constraint });
  if (err?.code === '23503') return fail(res, 400, 'FK_VIOLATION', 'Referenced resource does not exist', { requestId });
  if (err?.code === '23514' && String(err.constraint).includes('non_negative'))
    return fail(res, 400, 'INSUFFICIENT_STOCK', 'Operation would make stock negative', { requestId });
  logError('unhandled_error', {
    requestId,
    method: req.method,
    path: req.path,
    pgCode: err?.code,
    message: err?.message,
    stack: err?.stack,
  });
  return fail(res, 500, 'INTERNAL_ERROR', 'Unexpected error', { requestId });
}
