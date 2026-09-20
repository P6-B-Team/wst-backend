import { describe, it, expect, beforeAll } from 'vitest';
import { api, approvedJob, as, login, uniq } from './helpers.js';

let manager: any, technician: any, rival: any, auditor: any;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  technician = await login('tech@wst.local');
  rival = await login('manager@rival.local');
  auditor = await login('auditor@wst.local');
});

describe('authentication', () => {
  it('rejects a wrong password', async () => {
    const r = await api().post('/api/v1/auth/login').send({ email: 'manager@wst.local', password: 'wrong-password' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH_INVALID');
  });

  it('rejects requests without a token', async () => {
    const r = await api().get('/api/v1/jobs');
    expect(r.status).toBe(401);
  });

  it('returns the effective permission set for the caller', async () => {
    const r = await as(manager.token).get('/api/v1/me');
    expect(r.status).toBe(200);
    expect(r.body.data.permissions).toContain('job:transition');
    expect(r.body.data.roles).toContain('WORKSHOP_MANAGER');
  });

  it('rotates refresh tokens and refuses to reuse the old one', async () => {
    const session = await login('advisor@wst.local');
    const first = await api().post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.data.refreshToken).not.toBe(session.refreshToken);
    const replay = await api().post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(replay.status).toBe(401);
  });

  it('revokes a refresh token on logout', async () => {
    const session = await login('qc@wst.local');
    await api().post('/api/v1/auth/logout').send({ refreshToken: session.refreshToken });
    const r = await api().post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(r.status).toBe(401);
  });
});

describe('RBAC', () => {
  it('denies a technician the ability to create customers', async () => {
    const r = await as(technician.token).post('/api/v1/customers', { name: uniq('Nope') });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('denies a technician access to the audit trail', async () => {
    const r = await as(technician.token).get('/api/v1/audit-events');
    expect(r.status).toBe(403);
  });

  it('allows the auditor to read the audit trail', async () => {
    const r = await as(auditor.token).get('/api/v1/audit-events');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });
});

describe('organization row-level scope', () => {
  it('hides another organization job card from list and detail', async () => {
    const { job } = await approvedJob(manager.token);
    const detail = await as(rival.token).get(`/api/v1/jobs/${job.id}`);
    expect(detail.status).toBe(404);
    const list = await as(rival.token).get('/api/v1/jobs');
    expect(list.body.data.some((j: any) => j.id === job.id)).toBe(false);
  });

  it('blocks writing labor onto another organization job card', async () => {
    const { job } = await approvedJob(manager.token);
    const r = await as(rival.token).post(`/api/v1/jobs/${job.id}/labor`, { minutes: 30 });
    expect(r.status).toBe(404);
  });

  it('blocks issuing another organization stock', async () => {
    const stores = await as(manager.token).get('/api/v1/stores');
    const storeA = stores.body.data[0];
    const parts = await as(manager.token).get('/api/v1/parts');
    const { job } = await approvedJob(rival.token);
    const r = await as(rival.token).post(`/api/v1/jobs/${job.id}/parts/issue`, {
      partId: parts.body.data[0].id, storeId: storeA.id, quantity: 1,
    });
    expect(r.status).toBe(404);
  });

  it('keeps audit events inside the organization that produced them', async () => {
    const mine = await as(auditor.token).get('/api/v1/audit-events?pageSize=200');
    expect(mine.status).toBe(200);
    expect(mine.body.data.every((e: any) => e.organization_id === auditor.user.organizationId)).toBe(true);
  });
});
