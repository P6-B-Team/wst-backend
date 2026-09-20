/**
 * The brief lists the Student as an actor who "views assigned sessions, attendance, tasks,
 * results, competencies, and certificates". A student holds no training:* permission, so every
 * staff endpoint correctly refused them and the actor had no way to see anything at all.
 *
 * These endpoints take no identifier: the student id comes from the token, which makes reading
 * another student's record unrepresentable rather than merely forbidden.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { as, login } from './helpers.js';
import { query } from '../src/db/index.js';

let student: any, tech: any, supervisor: any;
const me = () => as(student.token);

beforeAll(async () => {
  student = await login('student@wst.local');
  tech = await login('tech@wst.local');
  supervisor = await login('supervisor@wst.local');
});

describe('a student can see their own training record', () => {
  it('is linked to a student profile through the token', async () => {
    expect(student.user.studentId).toBeTruthy();
    const r = await me().get('/api/v1/me/student');
    expect(r.status).toBe(200);
    expect(r.body.data.id).toBe(student.user.studentId);
    expect(r.body.data.studentNo).toBeTruthy();
  });

  it('lists the sessions they are enrolled in, with their own attendance', async () => {
    const r = await me().get('/api/v1/me/sessions');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.meta.total).toBeGreaterThan(0);
    expect(r.body.data[0]).toHaveProperty('attendance_status');

    // Every row must belong to this student and no other.
    const enrolled = await query('select session_id from enrollments where student_id=$1', [student.user.studentId]);
    const allowed = new Set(enrolled.rows.map((x: any) => x.session_id));
    for (const row of r.body.data) expect(allowed.has(row.id)).toBe(true);
  });

  it('shows attendance with a computed ratio', async () => {
    const r = await me().get('/api/v1/me/attendance');
    expect(r.status).toBe(200);
    expect(r.body.data.summary.total).toBeGreaterThan(0);
    expect(r.body.data.summary.ratio).toBeGreaterThanOrEqual(0);
  });

  it('shows tasks and results, but never an unsigned assessment as a grade', async () => {
    const r = await me().get('/api/v1/me/results');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    for (const row of r.body.data) {
      expect(row).toHaveProperty('task_code');
      if (row.status !== 'SIGNED') {
        // WST-FR-11: unsigned results stay pending and cannot count toward certification.
        expect(row.result).toBeNull();
        expect(row.countsTowardCertification).toBe(false);
        expect(row.provisionalResult).toBeTruthy();
      } else {
        expect(row.countsTowardCertification).toBe(true);
      }
    }
  });

  it('shows competency coverage and the remaining gaps per course', async () => {
    const r = await me().get('/api/v1/me/competencies');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data[0]).toHaveProperty('coverage');
    expect(r.body.data[0]).toHaveProperty('gaps');
    expect(r.body.data[0].course).toHaveProperty('code');
  });

  it('lists their certificates', async () => {
    const r = await me().get('/api/v1/me/certificates');
    expect(r.status).toBe(200);
    const mine = await query('select count(*) c from certificates where student_id=$1', [student.user.studentId]);
    expect(r.body.data.length).toBe(Number(mine.rows[0].c));
    for (const c of r.body.data) expect(c.qrUrl).toContain('/me/certificates/');
  });

  it('can re-render the QR code for their own certificate', async () => {
    // The raw token used to exist for exactly one HTTP response, so a student who closed the page
    // could never get their QR code again. It is now recoverable from its encrypted copy.
    const certs = (await me().get('/api/v1/me/certificates')).body.data;
    if (!certs.length) return;
    const r = await me().get(`/api/v1/me/certificates/${certs[0].id}/qr`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('image/svg+xml');
    expect(String(r.text ?? r.body)).toContain('<svg');
  });

  it('refuses the QR code of a certificate belonging to someone else', async () => {
    const other = await query('select id from certificates where student_id <> $1 limit 1', [student.user.studentId]);
    if (!other.rowCount) return;
    expect((await me().get(`/api/v1/me/certificates/${other.rows[0].id}/qr`)).status).toBe(404);
  });
});

describe('staff can re-render a certificate QR without holding the original token', () => {
  it('renders from the stored encrypted token when none is supplied', async () => {
    const cert = await query("select id from certificates where token_cipher is not null and status='ISSUED' limit 1");
    if (!cert.rowCount) return;
    const r = await as(supervisor.token).get(`/api/v1/certificates/${cert.rows[0].id}/qr`);
    expect(r.status).toBe(200);
    expect(String(r.text ?? r.body)).toContain('<svg');
  });

  it('still rejects a wrong token when one is supplied', async () => {
    const cert = await query("select id from certificates where status='ISSUED' limit 1");
    const r = await as(supervisor.token).get(`/api/v1/certificates/${cert.rows[0].id}/qr?token=not-the-token`);
    expect(r.status).toBe(400);
  });
});

describe('the self-service endpoints belong to students only', () => {
  it('refuses an account with no student profile', async () => {
    for (const path of ['/api/v1/me/student', '/api/v1/me/sessions', '/api/v1/me/attendance', '/api/v1/me/results', '/api/v1/me/competencies', '/api/v1/me/certificates']) {
      const r = await as(tech.token).get(path);
      expect(r.status, path).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const { api } = await import('./helpers.js');
    expect((await api().get('/api/v1/me/sessions')).status).toBe(401);
  });

  it('still refuses a student the staff training endpoints', async () => {
    // The self-service routes are an addition, not a widening of the student role.
    expect((await me().get('/api/v1/students')).status).toBe(403);
    expect((await me().get('/api/v1/training-sessions')).status).toBe(403);
    expect((await me().get('/api/v1/certificates')).status).toBe(403);
    expect((await me().get('/api/v1/exports/assessments')).status).toBe(403);
  });
});
