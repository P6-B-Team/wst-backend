import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/index.js';
import {
  auth, currentUser, hashPassword, invalidateUserCache, isLockedOut, issueRefreshToken, loadUser,
  orgOf, recordLoginAttempt, requirePermission, revokeRefreshToken, rotateRefreshToken, signAccess, verifyPassword,
} from '../auth.js';
import { asyncRoute, created, DomainError, ok, uuid } from '../http.js';
import { audit } from '../core.js';

export const authRoutes = Router();

authRoutes.post(
  '/auth/login',
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(6) }).parse(req.body);
    if (await isLockedOut(b.email))
      throw new DomainError('AUTH_LOCKED', 'Too many failed attempts, try again in 15 minutes', 429);
    const r = await query('select * from users where lower(email)=lower($1) and is_active=true limit 1', [b.email]);
    const okPass = r.rowCount ? await verifyPassword(b.password, r.rows[0].password_hash) : false;
    await recordLoginAttempt(b.email, req.ip, okPass);
    if (!okPass) throw new DomainError('AUTH_INVALID', 'Invalid credentials', 401);
    const u = (await loadUser(r.rows[0].id))!;
    const refresh = await issueRefreshToken(u.id);
    ok(res, {
      accessToken: signAccess(u),
      refreshToken: refresh.raw,
      tokenType: 'Bearer',
      user: { id: u.id, email: u.email, displayName: u.displayName, organizationId: u.organizationId, roles: u.roles, studentId: u.studentId },
    });
  })
);

authRoutes.post(
  '/auth/refresh',
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    const rotated = await rotateRefreshToken(b.refreshToken);
    const u = await loadUser(rotated.userId);
    if (!u) throw new DomainError('AUTH_INVALID', 'User is inactive', 401);
    ok(res, { accessToken: signAccess(u), refreshToken: rotated.raw, tokenType: 'Bearer' });
  })
);

authRoutes.post(
  '/auth/logout',
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    await revokeRefreshToken(b.refreshToken);
    ok(res, { loggedOut: true });
  })
);

authRoutes.get('/me', auth, asyncRoute(async (req: any, res: any) => ok(res, currentUser(req))));

authRoutes.get(
  '/users',
  auth,
  requirePermission('admin:users'),
  asyncRoute(async (req: any, res: any) => {
    const r = await query(
      `select u.id, u.email, u.display_name, u.is_active,
              array_remove(array_agg(distinct ro.code), null) roles
         from users u
         left join user_roles ur on ur.user_id=u.id
         left join roles ro on ro.id=ur.role_id
        where u.organization_id=$1 group by u.id order by u.display_name`,
      [orgOf(req)]
    );
    ok(res, r.rows);
  })
);

authRoutes.post(
  '/users',
  auth,
  requirePermission('admin:users'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        displayName: z.string().min(2),
        roles: z.array(z.string()).min(1),
      })
      .parse(req.body);
    const newUser = await tx(async (c) => {
      const h = await hashPassword(b.password);
      const u = await c.query(
        'insert into users(organization_id,email,password_hash,display_name) values($1,$2,$3,$4) returning id,email,display_name',
        [orgOf(req), b.email, h, b.displayName]
      );
      for (const code of b.roles) {
        const role = await c.query('select id from roles where code=$1', [code]);
        if (!role.rowCount) throw new DomainError('UNKNOWN_ROLE', `Role ${code} does not exist`, 400);
        await c.query('insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing', [u.rows[0].id, role.rows[0].id]);
      }
      await audit(req, 'USER_CREATED', 'user', u.rows[0].id, { roles: b.roles }, c);
      return { ...u.rows[0], roles: b.roles };
    });
    created(res, newUser);
  })
);

authRoutes.patch(
  '/users/:id/roles',
  auth,
  requirePermission('admin:users'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ roles: z.array(z.string()) }).parse(req.body);
    uuid.parse(req.params.id);
    const target = await query('select id from users where id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    if (!target.rowCount) throw new DomainError('NOT_FOUND', 'User not found', 404);
    await tx(async (c) => {
      await c.query('delete from user_roles where user_id=$1', [req.params.id]);
      for (const code of b.roles) {
        const role = await c.query('select id from roles where code=$1', [code]);
        if (!role.rowCount) throw new DomainError('UNKNOWN_ROLE', `Role ${code} does not exist`, 400);
        await c.query('insert into user_roles(user_id,role_id) values($1,$2)', [req.params.id, role.rows[0].id]);
      }
      await audit(req, 'USER_ROLES_CHANGED', 'user', req.params.id, { roles: b.roles }, c);
    });
    invalidateUserCache(req.params.id);
    ok(res, { id: req.params.id, roles: b.roles });
  })
);
