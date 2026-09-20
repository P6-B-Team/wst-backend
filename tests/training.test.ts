import { describe, it, expect, beforeAll } from 'vitest';
import { api, as, login, uniq } from './helpers.js';

let supervisor: any, mentor: any, manager: any, sup: ReturnType<typeof as>;
let course: any, tasks: any[], bay: any, mentorId: string;

beforeAll(async () => {
  supervisor = await login('supervisor@wst.local');
  mentor = await login('mentor@wst.local');
  manager = await login('manager@wst.local');
  sup = as(supervisor.token);
  mentorId = mentor.user.id;

  course = (await sup.post('/api/v1/courses', { code: uniq('C'), name: 'Brakes practical', durationHours: 20 })).body.data;
  const competency = (await sup.post('/api/v1/competencies', { code: uniq('CMP'), name: 'Brake service' })).body.data;
  tasks = [];
  for (const code of ['T1', 'T2']) {
    tasks.push((await sup.post(`/api/v1/courses/${course.id}/tasks`, { code: `${code}-${uniq('x')}`, title: `Task ${code}`, required: true, competencyIds: [competency.id] })).body.data);
  }
  bay = (await as(manager.token).get('/api/v1/bays')).body.data.find((b: any) => b.code === 'BAY-T');
});

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

async function session(startH: number, endH: number, opts: any = {}) {
  return (
    await sup.post('/api/v1/training-sessions', {
      courseId: course.id, startsAt: hoursFromNow(startH), endsAt: hoursFromNow(endH),
      bayId: opts.bayId ?? bay.id, mentorId: opts.mentorId ?? mentorId, capacity: opts.capacity ?? 10, title: uniq('S'),
    })
  ).body.data;
}

describe('session scheduling', () => {
  it('rejects a session whose end is before its start', async () => {
    const r = await sup.post('/api/v1/training-sessions', {
      courseId: course.id, startsAt: hoursFromNow(10), endsAt: hoursFromNow(8), capacity: 5,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_WINDOW');
  });

  it('refuses to publish a session that overlaps a published session in the same bay', async () => {
    const base = 1000 + Math.floor(Math.random() * 1000);
    const first = await session(base, base + 3);
    expect((await sup.post(`/api/v1/training-sessions/${first.id}/publish`, {})).status).toBe(200);

    const overlapping = await session(base + 1, base + 4);
    const dry = await sup.get(`/api/v1/training-sessions/${overlapping.id}/conflicts`);
    expect(dry.body.data.hasConflict).toBe(true);

    const r = await sup.post(`/api/v1/training-sessions/${overlapping.id}/publish`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('RESOURCE_CONFLICT');
    expect(r.body.error.details.conflicts.some((c: any) => c.kind === 'SESSION_BAY')).toBe(true);
  });

  it('refuses to publish when the mentor is already booked elsewhere', async () => {
    const base = 3000 + Math.floor(Math.random() * 1000);
    const otherBay = (await as(manager.token).get('/api/v1/bays')).body.data.find((b: any) => b.code === 'BAY-2');
    const first = await session(base, base + 2);
    await sup.post(`/api/v1/training-sessions/${first.id}/publish`, {});
    const clash = await session(base, base + 2, { bayId: otherBay.id });
    const r = await sup.post(`/api/v1/training-sessions/${clash.id}/publish`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.details.conflicts.some((c: any) => c.kind === 'SESSION_MENTOR')).toBe(true);
  });

  it('refuses to publish when a workshop job occupies the same bay', async () => {
    const base = 5000 + Math.floor(Math.random() * 1000);
    const m = as(manager.token);
    const customer = (await m.post('/api/v1/customers', { name: uniq('C') })).body.data;
    const vehicle = (await m.post(`/api/v1/customers/${customer.id}/vehicles`, {
      plateNo: uniq('P').slice(0, 14), vin: uniq('V'), make: 'Kia', model: 'Rio',
    })).body.data;
    await m.post('/api/v1/jobs', {
      customerId: customer.id, vehicleId: vehicle.id, complaint: 'Service', serviceType: 'GENERAL',
      receivedMileage: 1000, bayId: bay.id, scheduledStartAt: hoursFromNow(base), scheduledEndAt: hoursFromNow(base + 4),
    });
    const s = await session(base + 1, base + 2);
    const r = await sup.post(`/api/v1/training-sessions/${s.id}/publish`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.details.conflicts.some((c: any) => c.kind === 'JOB_BAY')).toBe(true);
  });

  it('publishes a clean session and enforces capacity on enrollment', async () => {
    const base = 7000 + Math.floor(Math.random() * 1000);
    const s = await session(base, base + 2, { capacity: 1 });
    expect((await sup.post(`/api/v1/training-sessions/${s.id}/publish`, {})).status).toBe(200);

    const a = (await sup.post('/api/v1/students', { studentNo: uniq('S'), fullName: 'Student A' })).body.data;
    const b = (await sup.post('/api/v1/students', { studentNo: uniq('S'), fullName: 'Student B' })).body.data;
    expect((await sup.post(`/api/v1/training-sessions/${s.id}/enrollments`, { studentIds: [a.id] })).status).toBe(200);
    const over = await sup.post(`/api/v1/training-sessions/${s.id}/enrollments`, { studentIds: [b.id] });
    expect(over.body.error.code).toBe('CAPACITY_EXCEEDED');
  });
});

describe('assessments, sign-off and certification', () => {
  it('keeps unsigned assessments out of certification and issues once signed', async () => {
    const base = 9000 + Math.floor(Math.random() * 2000);
    const s = await session(base, base + 3);
    await sup.post(`/api/v1/training-sessions/${s.id}/publish`, {});
    const student = (await sup.post('/api/v1/students', { studentNo: uniq('S'), fullName: 'Certifiable Student' })).body.data;
    await sup.post(`/api/v1/training-sessions/${s.id}/enrollments`, { studentIds: [student.id] });
    await sup.post(`/api/v1/training-sessions/${s.id}/attendance`, { studentId: student.id, status: 'PRESENT' });

    // the mentor records both assessments — they land in PENDING_SIGNATURE
    const recorded = [];
    for (const t of tasks) {
      const r = await as(mentor.token).post(`/api/v1/training-sessions/${s.id}/assessments`, {
        studentId: student.id, taskId: t.id, result: 'PASS', timeOnTask: 45, mentorNote: 'Good work',
      });
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe('PENDING_SIGNATURE');
      recorded.push(r.body.data);
    }

    const coverageBefore = await sup.get(`/api/v1/students/${student.id}/competency-coverage?courseId=${course.id}`);
    expect(coverageBefore.body.data.eligible).toBe(false);
    expect(coverageBefore.body.data.gaps.every((g: any) => g.reason === 'PENDING_SIGNATURE')).toBe(true);

    const blocked = await sup.post('/api/v1/certificates', { studentId: student.id, courseId: course.id });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('NOT_ELIGIBLE');

    // the mentor who recorded the assessment cannot sign it off
    const selfSign = await as(mentor.token).post(`/api/v1/assessments/${recorded[0].id}/signoff`, {});
    expect([403, 409]).toContain(selfSign.status);

    for (const a of recorded) {
      const r = await sup.post(`/api/v1/assessments/${a.id}/signoff`, {});
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe('SIGNED');
    }

    const coverageAfter = await sup.get(`/api/v1/students/${student.id}/competency-coverage?courseId=${course.id}`);
    expect(coverageAfter.body.data.eligible).toBe(true);
    expect(coverageAfter.body.data.coverage).toBe(1);

    const cert = await sup.post('/api/v1/certificates', { studentId: student.id, courseId: course.id });
    expect(cert.status).toBe(200);
    const token = cert.body.data.verificationToken;

    const verify = await api().get(`/api/v1/certificates/verify/${token}`);
    expect(verify.status).toBe(200);
    expect(verify.body.data.valid).toBe(true);
    expect(verify.body.data.studentNo).toBe(student.student_no);
    expect(verify.body.data).not.toHaveProperty('fullName');

    const revoked = await sup.post(`/api/v1/certificates/${cert.body.data.id}/revoke`, { reason: 'Issued in error' });
    expect(revoked.status).toBe(200);
    const afterRevoke = await api().get(`/api/v1/certificates/verify/${token}`);
    expect(afterRevoke.body.data.valid).toBe(false);
  });

  it('reports an unknown certificate token as invalid without leaking anything', async () => {
    const r = await api().get('/api/v1/certificates/verify/not-a-real-token');
    expect(r.status).toBe(200);
    expect(r.body.data.valid).toBe(false);
  });

  it('produces an explainable, versioned training risk score', async () => {
    const r = await sup.get('/api/v1/predictions/training-risk');
    expect(r.status).toBe(200);
    expect(r.body.meta.model.version).toBe('weighted-rules-v1');
    expect(r.body.meta.model.strategy).toBe('RULE_BASELINE');
    if (r.body.data.length) {
      expect(r.body.data[0].explanation.contributions.length).toBeGreaterThan(0);
      expect(r.body.data[0]).toHaveProperty('band');
    }
  });
});

describe('dashboards and exports', () => {
  it('serves role-scoped dashboards', async () => {
    expect((await as(manager.token).get('/api/v1/dashboards/workshop')).status).toBe(200);
    expect((await as(manager.token).get('/api/v1/dashboards/inventory')).status).toBe(200);
    expect((await as(manager.token).get('/api/v1/dashboards/finance')).status).toBe(200);
    expect((await sup.get('/api/v1/dashboards/training')).status).toBe(200);
    const student = await login('student@wst.local');
    const own = await as(student.token).get('/api/v1/dashboards/student');
    expect([200, 404]).toContain(own.status);
  });

  it('exports CSV for reporting', async () => {
    const r = await as(manager.token).get('/api/v1/exports/jobs');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text.split('\n')[0]).toContain('job_no');
  });
});
