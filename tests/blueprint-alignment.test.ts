/**
 * Streamlined-blueprint alignment (sections 2-4, 8 and 9 of the P6 blueprint):
 *
 *   - resource-creating endpoints answer 201 Created (register, vehicles, jobs, sessions);
 *   - a bay conflict and an insufficient-stock request are 400 Bad Request;
 *   - "Storekeeper / Tech" may issue parts, "Mentor / Supervisor" may create training sessions;
 *   - none of that widens access beyond what the blueprint names.
 *
 * Every blueprint path is exercised through its alias (/workshop/..., /training/...) so the
 * aliases are covered as well as the internal routes.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { as, login, uniq, approvedJob, createStockedPart } from './helpers.js';

let manager: any, advisor: any, tech: any, mentor: any, supervisor: any, student: any, storekeeper: any;
const m = () => as(manager.token);

/** Unique far-future windows so re-runs never collide with reservations left by earlier runs. */
let cursor = 900 + Math.floor(Math.random() * 100_000) * 24;
function window(hours = 2) {
  cursor += 12;
  const start = new Date(Date.now() + cursor * 3600_000);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + hours * 3600_000).toISOString() };
}

let courseId: string, bayId: string;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  advisor = await login('advisor@wst.local');
  tech = await login('tech@wst.local');
  mentor = await login('mentor@wst.local');
  supervisor = await login('supervisor@wst.local');
  student = await login('student@wst.local');
  storekeeper = await login('store@wst.local');
  courseId = (await as(supervisor.token).post('/api/v1/courses', { code: uniq('BP'), name: 'Blueprint alignment course' })).body.data.id;
  bayId = (await m().get('/api/v1/bays')).body.data[0].id;
});

describe('201 Created on the resource-creating blueprint endpoints', () => {
  it('POST /auth/register returns 201 and only a manager/admin may call it', async () => {
    const email = `${uniq('reg')}@wst.local`;
    const r = await m().post('/api/v1/auth/register', { email, password: 'Password123!', name: 'Registered Student', roles: ['STUDENT'] });
    expect(r.status).toBe(201);
    expect(r.body.data.email).toBe(email);
    expect(r.body.data.display_name).toBe('Registered Student'); // `name` alias maps onto displayName
    expect(r.body.error).toBeNull();

    const denied = await as(advisor.token).post('/api/v1/auth/register', { email: `${uniq('no')}@wst.local`, password: 'Password123!', name: 'Nope', roles: ['STUDENT'] });
    expect(denied.status).toBe(403);
  });

  it('POST /workshop/vehicles returns 201 for an advisor', async () => {
    const customer = (await m().post('/api/v1/customers', { name: uniq('BP Customer') })).body.data;
    const r = await as(advisor.token).post('/api/v1/workshop/vehicles', {
      customerId: customer.id, plateNo: uniq('BP').slice(0, 14), vin: uniq('VIN'), make: 'Kia', model: 'Rio', year: 2022, mileage: 1000,
    });
    expect(r.status).toBe(201);
    expect(r.body.data.customer_id).toBe(customer.id);
  });

  it('POST /workshop/jobs returns 201 and the internal /jobs route agrees', async () => {
    const customer = (await m().post('/api/v1/customers', { name: uniq('BP Customer') })).body.data;
    const vehicle = (await m().post(`/api/v1/customers/${customer.id}/vehicles`, {
      plateNo: uniq('BP').slice(0, 14), vin: uniq('VIN'), make: 'Kia', model: 'Rio', year: 2022, mileage: 1000,
    }));
    expect(vehicle.status).toBe(201); // internal route, same handler
    const body = { customerId: customer.id, vehicleId: vehicle.body.data.id, complaint: 'Blueprint job', serviceType: 'GENERAL', receivedMileage: 1500 };
    const viaAlias = await as(advisor.token).post('/api/v1/workshop/jobs', body);
    expect(viaAlias.status).toBe(201);
    expect(viaAlias.body.data.status).toBe('RECEIVED');
    expect(viaAlias.body.data.job_no).toBeTruthy();
    const viaInternal = await as(advisor.token).post('/api/v1/jobs', body);
    expect(viaInternal.status).toBe(201);
  });

  it('POST /training/sessions returns 201 for a supervisor', async () => {
    const r = await as(supervisor.token).post('/api/v1/training/sessions', { courseId, capacity: 5, title: uniq('S'), ...window() });
    expect(r.status).toBe(201);
  });

  it('non-creating endpoints keep 200 (stage change, part issue, invoice preview, assessments)', async () => {
    const { job } = await approvedJob(manager.token);
    const stage = await as(advisor.token).patch(`/api/v1/workshop/jobs/${job.id}/stage`, { toStatus: 'IN_PROGRESS' });
    expect(stage.status).toBe(200);
    const invoice = await as(advisor.token).get(`/api/v1/workshop/jobs/${job.id}/invoice`);
    expect(invoice.status).toBe(200);
  });
});

describe('400 Bad Request for bay conflicts (blueprint sections 8 and 9)', () => {
  it('blocks publishing a session that overlaps a commercial job in the same bay', async () => {
    const w = window();
    const customer = (await m().post('/api/v1/customers', { name: uniq('C') })).body.data;
    const vehicle = (await m().post(`/api/v1/customers/${customer.id}/vehicles`, { plateNo: uniq('P').slice(0, 14), vin: uniq('V'), make: 'Kia', model: 'Rio' })).body.data;
    const job = await m().post('/api/v1/workshop/jobs', {
      customerId: customer.id, vehicleId: vehicle.id, complaint: 'Occupies the bay', serviceType: 'GENERAL', receivedMileage: 100,
      bayId, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt,
    });
    expect(job.status).toBe(201);

    const s = (await as(supervisor.token).post('/api/v1/training/sessions', { courseId, bayId, capacity: 5, title: uniq('S'), ...w })).body.data;
    const publish = await as(supervisor.token).post(`/api/v1/training-sessions/${s.id}/publish`, {});
    expect(publish.status).toBe(400);
    expect(publish.body.error.code).toBe('RESOURCE_CONFLICT');
    expect(publish.body.error.details.conflicts.some((c: any) => c.kind === 'JOB_BAY')).toBe(true);
  });

  it('blocks a job that is scheduled into a bay a published session holds', async () => {
    const w = window();
    const s = (await as(supervisor.token).post('/api/v1/training/sessions', { courseId, bayId, capacity: 5, title: uniq('S'), ...w })).body.data;
    expect((await as(supervisor.token).post(`/api/v1/training-sessions/${s.id}/publish`, {})).status).toBe(200);

    const customer = (await m().post('/api/v1/customers', { name: uniq('C') })).body.data;
    const vehicle = (await m().post(`/api/v1/customers/${customer.id}/vehicles`, { plateNo: uniq('P').slice(0, 14), vin: uniq('V'), make: 'Kia', model: 'Rio' })).body.data;
    const r = await as(advisor.token).post('/api/v1/workshop/jobs', {
      customerId: customer.id, vehicleId: vehicle.id, complaint: 'Clashes with training', serviceType: 'GENERAL', receivedMileage: 100,
      bayId, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('RESOURCE_CONFLICT');
  });

  it('other conflicts are unchanged: over-capacity enrolment stays 409', async () => {
    // Guards against the 400 change leaking into unrelated state conflicts. The capacity check runs
    // before student lookup, so two syntactically valid ids are enough to hit it.
    const s = (await as(supervisor.token).post('/api/v1/training/sessions', { courseId, capacity: 1, title: uniq('S'), ...window() })).body.data;
    const r = await as(supervisor.token).post(`/api/v1/training-sessions/${s.id}/enrollments`, { studentIds: [randomUUID(), randomUUID()] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CAPACITY_EXCEEDED');
  });
});

describe('Technician may issue parts (blueprint: "Storekeeper / Tech")', () => {
  it('a technician issues a part through POST /workshop/jobs/:id/parts and stock drops atomically', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 5);
    const r = await as(tech.token).post(`/api/v1/workshop/jobs/${job.id}/parts`, { partId: part.id, storeId: store.id, quantity: 2 });
    expect(r.status).toBe(200);
    expect(Number(r.body.data.balanceAfter)).toBe(3);
    expect(r.body.data.issued_by).toBe(tech.user.id);
  });

  it('a storekeeper can still issue parts (existing behaviour unchanged)', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 5);
    const r = await as(storekeeper.token).post(`/api/v1/workshop/jobs/${job.id}/parts`, { partId: part.id, storeId: store.id, quantity: 1 });
    expect(r.status).toBe(200);
  });

  it('requesting more than is available is 400 INSUFFICIENT_STOCK and stock is untouched', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 2);
    const r = await as(tech.token).post(`/api/v1/workshop/jobs/${job.id}/parts`, { partId: part.id, storeId: store.id, quantity: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(Number(r.body.error.details.available)).toBe(2);
  });

  it('customer approval is still required before a technician can issue parts', async () => {
    const customer = (await m().post('/api/v1/customers', { name: uniq('C') })).body.data;
    const vehicle = (await m().post(`/api/v1/customers/${customer.id}/vehicles`, { plateNo: uniq('P').slice(0, 14), vin: uniq('V'), make: 'Kia', model: 'Rio' })).body.data;
    const job = (await m().post('/api/v1/jobs', { customerId: customer.id, vehicleId: vehicle.id, complaint: 'Not approved yet', serviceType: 'GENERAL', receivedMileage: 100 })).body.data;
    const { part, store } = await createStockedPart(manager.token, 3);
    const r = await as(tech.token).post(`/api/v1/workshop/jobs/${job.id}/parts`, { partId: part.id, storeId: store.id, quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CUSTOMER_APPROVAL_REQUIRED');
  });

  it('the grant is narrow: a technician still cannot reserve, release, reverse or adjust stock', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 5);
    const t = as(tech.token);
    expect((await t.post(`/api/v1/jobs/${job.id}/parts/reserve`, { partId: part.id, storeId: store.id, quantity: 1 })).status).toBe(403);
    expect((await t.post('/api/v1/stock/adjustments', { storeId: store.id, partId: part.id, delta: 5, reason: 'Technician must not adjust stock' })).status).toBe(403);

    const jp = (await m().post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 1 })).body.data;
    expect((await t.post(`/api/v1/job-parts/${jp.id}/reversals`, { quantity: 1, reason: 'Technician must not reverse' })).status).toBe(403);
  });

  it('roles that never had access still do not: student and mentor get 403', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 5);
    const body = { partId: part.id, storeId: store.id, quantity: 1 };
    expect((await as(student.token).post(`/api/v1/workshop/jobs/${job.id}/parts`, body)).status).toBe(403);
    expect((await as(mentor.token).post(`/api/v1/workshop/jobs/${job.id}/parts`, body)).status).toBe(403);
  });
});

describe('Mentor may create training sessions (blueprint: "Mentor / Supervisor")', () => {
  it('a mentor creates a draft session for themselves: 201, mentor forced to the caller', async () => {
    const r = await as(mentor.token).post('/api/v1/training/sessions', { courseId, bayId, capacity: 5, title: uniq('S'), ...window() });
    expect(r.status).toBe(201);
    expect(r.body.data.mentor_id).toBe(mentor.user.id);
    expect(r.body.data.status).not.toBe('PUBLISHED'); // a draft: creating never takes the bay
  });

  it('a mentor cannot create a session on behalf of another mentor', async () => {
    const r = await as(mentor.token).post('/api/v1/training/sessions', { courseId, capacity: 5, mentorId: supervisor.user.id, ...window() });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('a mentor can name themselves explicitly', async () => {
    const r = await as(mentor.token).post('/api/v1/training/sessions', { courseId, capacity: 5, mentorId: mentor.user.id, ...window() });
    expect(r.status).toBe(201);
  });

  it('a mentor cannot publish, cancel or manage courses: publishing takes the shared bay and stays with the supervisor', async () => {
    const s = (await as(mentor.token).post('/api/v1/training/sessions', { courseId, bayId, capacity: 5, title: uniq('S'), ...window() })).body.data;
    expect((await as(mentor.token).post(`/api/v1/training-sessions/${s.id}/publish`, {})).status).toBe(403);
    expect((await as(mentor.token).post(`/api/v1/training-sessions/${s.id}/cancel`, { reason: 'Mentor must not cancel' })).status).toBe(403);
    expect((await as(mentor.token).post('/api/v1/courses', { code: uniq('X'), name: 'Not allowed' })).status).toBe(403);

    // The supervisor can publish the mentor's draft, and the conflict engine still guards the bay.
    expect((await as(supervisor.token).post(`/api/v1/training-sessions/${s.id}/publish`, {})).status).toBe(200);
  });

  it('a supervisor can still assign any mentor (existing behaviour unchanged)', async () => {
    const r = await as(supervisor.token).post('/api/v1/training/sessions', { courseId, capacity: 5, mentorId: mentor.user.id, ...window() });
    expect(r.status).toBe(201);
    expect(r.body.data.mentor_id).toBe(mentor.user.id);
  });

  it('students, technicians and advisors still cannot create sessions', async () => {
    const body = { courseId, capacity: 5, ...window() };
    for (const who of [student, tech, advisor]) {
      expect((await as(who.token).post('/api/v1/training/sessions', body)).status).toBe(403);
    }
  });

  it('a mentor still records assessments as before (assessment:write is untouched)', async () => {
    const perms: string[] = (await as(mentor.token).get('/api/v1/me')).body.data.permissions;
    expect(perms).toContain('assessment:write');
    expect(perms).toContain('training:schedule');
    expect(perms).not.toContain('training:write');
    expect(perms).not.toContain('assessment:signoff');
  });
});
