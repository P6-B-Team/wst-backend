import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { query } from './db/index.js';
import { DomainError, forbidden } from './http.js';
import { logSecurity, logWarn } from './logger.js';

export type AuthUser = {
  id: string;
  organizationId: string;
  email: string;
  displayName?: string;
  roles: string[];
  permissions: string[];
  studentId?: string;
};

/**
 * Secrets are never given a usable default. A hard-coded fallback means every deployment that
 * forgets the environment variable signs tokens with a value that is public in this repository, so
 * anyone could mint an admin token. Outside development the process refuses to start instead.
 */
let ephemeralSecret: string | undefined;
export function accessSecret(): string {
  const configured = process.env.JWT_ACCESS_SECRET;
  if (configured && configured.length >= 16) return configured;
  if (process.env.NODE_ENV === 'production')
    throw new Error('JWT_ACCESS_SECRET must be set to at least 16 characters in production');
  if (configured && configured.length > 0 && process.env.NODE_ENV !== 'test')
    logWarn('weak_jwt_secret', { length: configured.length, minimum: 16 });
  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(48).toString('hex');
    logWarn('jwt_secret_missing_using_ephemeral', {
      note: 'Development only. Tokens are invalidated on every restart. Set JWT_ACCESS_SECRET.',
    });
  }
  return configured && configured.length >= 16 ? configured : ephemeralSecret;
}

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export function signAccess(u: AuthUser) {
  return jwt.sign(
    { sub: u.id, organizationId: u.organizationId, email: u.email, roles: u.roles, studentId: u.studentId },
    accessSecret(),
    { expiresIn: (process.env.ACCESS_TOKEN_TTL || '15m') as jwt.SignOptions['expiresIn'] }
  );
}

/** Refresh tokens are opaque random strings; only the hash is stored and they rotate on every use. */
export async function issueRefreshToken(userId: string) {
  const raw = crypto.randomBytes(48).toString('hex');
  const days = Number(String(process.env.REFRESH_TOKEN_TTL || '7d').replace(/\D/g, '')) || 7;
  const r = await query(
    `insert into refresh_tokens(user_id, token_hash, expires_at)
     values($1,$2, now() + ($3 || ' days')::interval) returning id`,
    [userId, sha256(raw), String(days)]
  );
  return { raw, id: r.rows[0].id as string };
}

export async function rotateRefreshToken(raw: string) {
  const r = await query(
    `select * from refresh_tokens where token_hash=$1 and revoked_at is null and expires_at > now()`,
    [sha256(raw)]
  );
  if (!r.rowCount) throw new DomainError('AUTH_INVALID', 'Refresh token is invalid, expired or already used', 401);
  const next = await issueRefreshToken(r.rows[0].user_id);
  await query('update refresh_tokens set revoked_at=now(), replaced_by=$1 where id=$2', [next.id, r.rows[0].id]);
  return { userId: r.rows[0].user_id as string, raw: next.raw };
}

export const revokeRefreshToken = (raw: string) =>
  query('update refresh_tokens set revoked_at=now() where token_hash=$1 and revoked_at is null', [sha256(raw)]);

export async function loadUser(id: string): Promise<AuthUser | undefined> {
  const r = await query(
    `select u.id, u.organization_id, u.email, u.display_name, u.is_active,
            array_remove(array_agg(distinct ro.code), null) roles,
            array_remove(array_agg(distinct p.code), null) permissions,
            s.id student_id
       from users u
       left join user_roles ur on ur.user_id = u.id
       left join roles ro on ro.id = ur.role_id
       left join role_permissions rp on rp.role_id = ro.id
       left join permissions p on p.id = rp.permission_id
       left join students s on s.user_id = u.id
      where u.id = $1
      group by u.id, s.id`,
    [id]
  );
  const row = r.rows[0];
  if (!row || !row.is_active) return undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    displayName: row.display_name,
    roles: row.roles || [],
    permissions: row.permissions || [],
    studentId: row.student_id || undefined,
  };
}

/**
 * Permissions are resolved from the database on every request (with a short TTL cache) instead of
 * being trusted from the token, so revoking a role takes effect immediately rather than surviving
 * until the access token expires.
 */
const cache = new Map<string, { at: number; user: AuthUser }>();
const CACHE_MS = 15_000;
async function resolveUser(id: string) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  const user = await loadUser(id);
  if (user) cache.set(id, { at: Date.now(), user });
  return user;
}
export const invalidateUserCache = (id: string) => cache.delete(id);

export async function auth(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new DomainError('AUTH_REQUIRED', 'Bearer token required', 401);
    const claims: any = jwt.verify(h.slice(7), accessSecret());
    const user = await resolveUser(claims.sub);
    if (!user) throw new DomainError('AUTH_INVALID', 'User is inactive or no longer exists', 401);
    (req as any).user = user;
    next();
  } catch (e: any) {
    if (e instanceof DomainError) return next(e);
    return next(new DomainError('AUTH_INVALID', 'Invalid or expired token', 401));
  }
}

export function requirePermission(...needed: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = (req as any).user as AuthUser;
    if (!needed.some((p) => u.permissions.includes(p))) {
      logSecurity('permission_denied', { userId: u.id, path: req.path, method: req.method, needed });
      return next(forbidden(`Requires one of: ${needed.join(', ')}`));
    }
    next();
  };
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const u = (req as any).user as AuthUser;
    if (!roles.some((r) => u.roles.includes(r))) {
      logSecurity('role_denied', { userId: u.id, path: req.path, method: req.method, roles });
      return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

export const currentUser = (req: Request) => (req as any).user as AuthUser;
export const orgOf = (req: Request) => currentUser(req).organizationId;

export const recordLoginAttempt = (email: string, ip: string | undefined, success: boolean) =>
  query('insert into login_attempts(email, ip, success) values($1,$2,$3)', [email, ip ?? null, success]);

export const FAILED_LOGIN_LIMIT = 5;

/**
 * Counts consecutive failures *since the last successful sign-in*, not every failure in the
 * window. Counting all of them meant five mistyped passwords spread across fifteen minutes locked
 * an account even though the user had signed in successfully in between — the lockout never
 * reset until the window aged out, which is a denial of service against a legitimate user rather
 * than a defence against credential stuffing.
 */
export async function isLockedOut(email: string) {
  const r = await query(
    `select count(*) c from login_attempts
      where email=$1
        and success=false
        and attempted_at > now() - interval '15 minutes'
        and attempted_at > coalesce(
          (select max(attempted_at) from login_attempts
            where email=$1 and success=true), to_timestamp(0))`,
    [email]
  );
  return Number(r.rows[0].c) >= FAILED_LOGIN_LIMIT;
}
