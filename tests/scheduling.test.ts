/**
 * WST-FR-10 and the risk control "one shared resource calendar with database constraints".
 * Detection used to run in one direction only — a session checked jobs, but a job could be
 * scheduled straight into a bay a published session was already holding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { as, login, uniq } from './helpers.js';
import { pool, query } from '../src/db/index.js';

let manager: any, supervisor: any;
const m = () => as(manager.token);
const sup = () => as(supervisor.token);

/**
 * A window far enough out, and unique per call, that it cannot collide with seeded data — or with
 * the reservations a previous run of this same file left in the database. Publishing now takes a
 * real lock on the shared bay calendar, so a fixed offset makes the suite collide with itself on
 * the second run. The base is randomised per run for that reason.
 */
let cursor = 400 + Math.floor(Math.random() * 100_000) * 24;
function window(hours = 2) {
  cursor += 12;
  const start = new Date(Date.now() + cursor * 3600_000);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + hours * 3600_000).toISOString() };
}

let bayA: any, bayB: any, courseId: string;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  supervisor = await login('supervisor@wst.local');
  const bays = (await m().get('/api/v1/bays')).body.data;
  [bayA, bayB] = bays;
  courseId = (await sup().post('/api/v1/courses', { code: uniq('C'), name: 'Scheduling course' })).body.data.id;
});

async function publishedSession(bayId: string, w: { startsAt: string; endsAt: string }) {
  const s = (await sup().post('/api/v1/training-sessions', { courseId, bayId, capacity: 5, title: uniq('S'), ...w })).body.data;
  const p = await sup().post(`/api/v1/training-sessions/${s.id}/publish`, {});
  expect(p.status).toBe(200);
  return s;
}

async function job(over: any = {}) {
  const customer = (await m().post('/api/v1/customers', { name: uniq('Sched Customer') })).body.data;
  const vehicle = (await m().post(`/api/v1/customers/${customer.id}/vehicles`, {
    plateNo: uniq('PL').slice(0, 14), vin: uniq('VIN'), make: 'Toyota', model: 'Corolla', year: 2021, mileage: 1000,
  })).body.data;
  return m().post('/api/v1/jobs', {
    customerId: customer.id, vehicleId: vehicle.id, complaint: 'Scheduled work',
    serviceType: 'BRAKES', receivedMileage: 1100, ...over,
  });
}

describe('the workshop and training share one bay calendar', () => {
  it('refuses a job scheduled into a bay a published session is holding', async () => {
    const w = window();
    await publishedSession(bayA.id, w);
    const r = await job({ bayId: bayA.id, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('RESOURCE_CONFLICT');
    expect(r.body.error.details.conflicts.some((c: any) => c.kind === 'SESSION_BAY')).toBe(true);
  });

  it('refuses a job that only partially overlaps the session', async () => {
    const w = window(4);
    await publishedSession(bayA.id, w);
    const overlapStart = new Date(new Date(w.startsAt).getTime() + 3600_000).toISOString();
    const overlapEnd = new Date(new Date(w.endsAt).getTime() + 3600_000).toISOString();
    const r = await job({ bayId: bayA.id, scheduledStartAt: overlapStart, scheduledEndAt: overlapEnd });
    expect(r.status).toBe(400);
  });

  it('allows a job in the same bay immediately after the session ends', async () => {
    const w = window(2);
    await publishedSession(bayA.id, w);
    const after = new Date(w.endsAt).toISOString();
    const r = await job({ bayId: bayA.id, scheduledStartAt: after, scheduledEndAt: new Date(new Date(after).getTime() + 3600_000).toISOString() });
    expect(r.status).toBe(201);
  });

  it('refuses a session published into a bay a job is holding (the direction that already worked)', async () => {
    const w = window();
    const j = await job({ bayId: bayB.id, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt });
    expect(j.status).toBe(201);
    const s = (await sup().post('/api/v1/training-sessions', { courseId, bayId: bayB.id, capacity: 5, title: uniq('S'), ...w })).body.data;
    const p = await sup().post(`/api/v1/training-sessions/${s.id}/publish`, {});
    expect(p.status).toBe(400);
    expect(p.body.error.details.conflicts.some((c: any) => c.kind === 'JOB_BAY')).toBe(true);
  });

  it('refuses reassigning an existing job into an occupied bay', async () => {
    const w = window();
    await publishedSession(bayA.id, w);
    const j = (await job({ scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt })).body.data;
    const r = await m().patch(`/api/v1/jobs/${j.id}`, { bayId: bayA.id });
    expect(r.status).toBe(400);
  });
});

describe('closing a job releases its bay', () => {
  it('frees the bay when the job is cancelled', async () => {
    const w = window();
    const j = (await job({ bayId: bayA.id, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt })).body.data;

    // While the job is open the bay is taken.
    const blocked = (await sup().post('/api/v1/training-sessions', { courseId, bayId: bayA.id, capacity: 5, title: uniq('S'), ...w })).body.data;
    expect((await sup().post(`/api/v1/training-sessions/${blocked.id}/publish`, {})).status).toBe(400);

    // A cancelled job is not workshop work any more and must not keep holding the bay.
    expect((await m().post(`/api/v1/jobs/${j.id}/transitions`, { toStatus: 'CANCELLED', reason: 'Customer withdrew' })).status).toBe(200);
    expect((await sup().post(`/api/v1/training-sessions/${blocked.id}/publish`, {})).status).toBe(200);
  });

  it('frees the bay when a session is cancelled', async () => {
    const w = window();
    const s = await publishedSession(bayB.id, w);
    expect((await job({ bayId: bayB.id, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt })).status).toBe(400);
    expect((await sup().post(`/api/v1/training-sessions/${s.id}/cancel`, { reason: 'Mentor unavailable' })).status).toBe(200);
    expect((await job({ bayId: bayB.id, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt })).status).toBe(201);
  });
});

describe('the guarantee is in the database, not only in the application', () => {
  it('rejects an overlapping reservation written directly, bypassing the API entirely', async () => {
    const w = window();
    await publishedSession(bayA.id, w);
    // Two concurrent transactions can both pass an application-level check and both commit.
    // The exclusion constraint is what makes that impossible, so it is tested directly.
    await expect(
      pool.query(
        `insert into bay_reservations(organization_id,bay_id,source_type,source_id,during)
         values('00000000-0000-0000-0000-000000000001',$1,'JOB',gen_random_uuid(), tstzrange($2::timestamptz,$3::timestamptz,'[)'))`,
        [bayA.id, w.startsAt, w.endsAt]
      )
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('surfaces a raw exclusion violation as 400, never as 500', async () => {
    const w = window();
    await publishedSession(bayA.id, w);
    const r = await job({ bayId: bayA.id, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt });
    expect(r.status).toBe(400);
  });

  it('keeps one reservation row per job and removes it on close', async () => {
    const w = window();
    const j = (await job({ bayId: bayA.id, scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt })).body.data;
    expect(Number((await query("select count(*) c from bay_reservations where source_type='JOB' and source_id=$1", [j.id])).rows[0].c)).toBe(1);

    // Reassigning must not leave the old row behind and double-book the job against itself.
    await m().patch(`/api/v1/jobs/${j.id}`, { bayId: bayB.id });
    const rows = await query("select bay_id from bay_reservations where source_type='JOB' and source_id=$1", [j.id]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].bay_id).toBe(bayB.id);

    await m().post(`/api/v1/jobs/${j.id}/transitions`, { toStatus: 'CANCELLED', reason: 'Test cleanup' });
    expect(Number((await query("select count(*) c from bay_reservations where source_type='JOB' and source_id=$1", [j.id])).rows[0].c)).toBe(0);
  });
});

describe('job assignment (step 2 of the primary workflow)', () => {
  it('assigns bay and technician after the job card was opened', async () => {
    const j = (await job()).body.data;
    expect(j.bay_id).toBeNull();
    const w = window();
    const tech = (await query(
      "select u.id from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where r.code='TECHNICIAN' limit 1"
    )).rows[0].id;

    const r = await m().patch(`/api/v1/jobs/${j.id}`, {
      bayId: bayA.id, technicianId: tech, priority: 'HIGH', scheduledStartAt: w.startsAt, scheduledEndAt: w.endsAt,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.bay_id).toBe(bayA.id);
    expect(r.body.data.assigned_technician_id).toBe(tech);
    expect(r.body.data.priority).toBe('HIGH');
  });

  it('records the assignment, with its previous values, in the audit trail', async () => {
    const j = (await job()).body.data;
    await m().patch(`/api/v1/jobs/${j.id}`, { priority: 'URGENT' });
    const ev = await query("select * from audit_events where action='JOB_UPDATED' and entity_id=$1", [j.id]);
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].metadata_json.changed.priority).toBe('URGENT');
    expect(ev.rows[0].metadata_json).toHaveProperty('previous');
  });

  it('rejects an empty update and an inverted window', async () => {
    const j = (await job()).body.data;
    expect((await m().patch(`/api/v1/jobs/${j.id}`, {})).status).toBe(400);
    const w = window();
    const r = await m().patch(`/api/v1/jobs/${j.id}`, { scheduledStartAt: w.endsAt, scheduledEndAt: w.startsAt });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_WINDOW');
  });

  it('rejects a bay or technician from another organization', async () => {
    const j = (await job()).body.data;
    const rivalBay = (await query("select id from bays where organization_id='00000000-0000-0000-0000-000000000002' limit 1")).rows[0].id;
    expect((await m().patch(`/api/v1/jobs/${j.id}`, { bayId: rivalBay })).status).toBe(404);
  });

  it('refuses to reassign a delivered or cancelled job', async () => {
    const j = (await job()).body.data;
    await m().post(`/api/v1/jobs/${j.id}/transitions`, { toStatus: 'CANCELLED', reason: 'Closed for this test' });
    const r = await m().patch(`/api/v1/jobs/${j.id}`, { priority: 'LOW' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('JOB_CLOSED');
  });
});
