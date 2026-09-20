/**
 * Each test in this file fails against the code as it was before the hardening pass. They are the
 * evidence for the security findings, not a description of them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { api, approvedJob, as, login, uniq } from './helpers.js';
import { pool, query } from '../src/db/index.js';

let manager: any, qc: any, buyer: any, auditor: any, tech: any, student: any, supervisor: any, rival: any;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  qc = await login('qc@wst.local');
  buyer = await login('buyer@wst.local');
  auditor = await login('auditor@wst.local');
  tech = await login('tech@wst.local');
  student = await login('student@wst.local');
  supervisor = await login('supervisor@wst.local');
  rival = await login('manager@rival.local');
});

/* ================================================================ finding 1: export authorisation */

describe('exports require the dataset own permission, not report:read', () => {
  // The quality checker and the buyer both hold report:read. Neither holds audit:read or
  // training:read, so neither may pull the audit trail or student assessments.
  it('refuses the audit trail to a quality checker who only holds report:read', async () => {
    const r = await as(qc.token).get('/api/v1/exports/audit');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses student assessments to a procurement user who only holds report:read', async () => {
    const r = await as(buyer.token).get('/api/v1/exports/assessments');
    expect(r.status).toBe(403);
  });

  it('refuses invoice exports to a user without invoice or report access', async () => {
    expect((await as(tech.token).get('/api/v1/exports/invoices')).status).toBe(403);
  });

  it('still serves each dataset to the role that owns it', async () => {
    expect((await as(auditor.token).get('/api/v1/exports/audit')).status).toBe(200);
    expect((await as(auditor.token).get('/api/v1/exports/assessments')).status).toBe(200);
    expect((await as(manager.token).get('/api/v1/exports/invoices')).status).toBe(200);
  });

  it('caps and filters exports instead of streaming the whole table', async () => {
    const capped = await as(auditor.token).get('/api/v1/exports/audit?format=json&limit=3');
    expect(capped.status).toBe(200);
    expect(capped.body.data.length).toBeLessThanOrEqual(3);
    expect(capped.body.meta.maxRows).toBe(3);

    const future = new Date(Date.now() + 86400_000).toISOString();
    const empty = await as(auditor.token).get(`/api/v1/exports/audit?format=json&from=${future}`);
    expect(empty.body.data).toHaveLength(0);

    // A snapshot dataset says so rather than silently ignoring the filter.
    const unsupported = await as(auditor.token).get(`/api/v1/exports/stock?from=${future}`);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe('FILTER_NOT_SUPPORTED');
  });

  it('records the filters and truncation flag on the export audit event', async () => {
    await as(auditor.token).get('/api/v1/exports/audit?format=json&limit=2');
    const ev = await query("select * from audit_events where action='DATA_EXPORTED' order by occurred_at desc limit 1");
    expect(ev.rows[0].metadata_json.dataset).toBe('audit');
    expect(ev.rows[0].metadata_json).toHaveProperty('truncated');
    expect(ev.rows[0].metadata_json).toHaveProperty('filters');
  });
});

/* ================================================================ finding 2: student dashboard scope */

describe("a user without a student profile cannot read a student's dashboard", () => {
  let someStudentId: string;
  beforeAll(async () => {
    someStudentId = (await query("select id from students where organization_id='00000000-0000-0000-0000-000000000001' and user_id is null limit 1")).rows[0].id;
  });

  it('refuses a technician reading an arbitrary student record', async () => {
    // The old guard was skipped entirely for users with no studentId of their own, which let any
    // authenticated user read attendance and grades for anybody — breaking WST-FR-01's acceptance
    // evidence that "a student cannot access another student's record".
    const r = await as(tech.token).get(`/api/v1/dashboards/student?studentId=${someStudentId}`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses a student reading a different student record', async () => {
    const r = await as(student.token).get(`/api/v1/dashboards/student?studentId=${someStudentId}`);
    expect(r.status).toBe(403);
  });

  it('allows a student their own dashboard with no identifier at all', async () => {
    const r = await as(student.token).get('/api/v1/dashboards/student');
    expect(r.status).toBe(200);
    expect(r.body.data.student.id).toBe(student.user.studentId);
  });

  it('allows training staff and records the access as a sensitive read', async () => {
    const r = await as(supervisor.token).get(`/api/v1/dashboards/student?studentId=${someStudentId}`);
    expect(r.status).toBe(200);
    const ev = await query(
      "select * from audit_events where action='STUDENT_RECORD_READ' and entity_id=$1 order by occurred_at desc limit 1",
      [someStudentId]
    );
    expect(ev.rowCount).toBe(1);
  });
});

/* ================================================================ finding 3: attachments */

describe('attachment validation and scope', () => {
  let jobId: string;
  beforeAll(async () => {
    jobId = (await approvedJob(manager.token)).job.id;
  });

  const attach = (body: any, token = manager.token) => as(token).post('/api/v1/attachments', body);
  const valid = (over: any = {}) => ({
    entityType: 'job_card', entityId: jobId, fileName: 'evidence.png',
    contentType: 'image/png', sizeBytes: 1024, storageKey: `jobs/${jobId}/evidence.png`, ...over,
  });

  it('accepts a well formed image', async () => {
    const r = await attach(valid());
    expect(r.status).toBe(200);
    expect(r.body.data.content_type).toBe('image/png');
  });

  it('refuses an executable content type', async () => {
    const r = await attach(valid({ fileName: 'payload.exe', contentType: 'application/x-msdownload' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('refuses a file whose extension disagrees with its declared type', async () => {
    const r = await attach(valid({ fileName: 'payload.exe', contentType: 'image/png' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('FILE_TYPE_MISMATCH');
  });

  it('refuses a traversal storage key', async () => {
    for (const storageKey of ['../../etc/passwd', '/etc/passwd', 'jobs/../../secret.png']) {
      const r = await attach(valid({ storageKey }));
      expect(r.status, storageKey).toBe(422);
      expect(r.body.error.code).toBe('INVALID_STORAGE_KEY');
    }
  });

  it('refuses a traversal file name', async () => {
    const r = await attach(valid({ fileName: '../evidence.png' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_FILE_NAME');
  });

  it('refuses an oversized file', async () => {
    const r = await attach(valid({ sizeBytes: 26 * 1024 * 1024 }));
    expect(r.status).toBe(400);
  });

  it('refuses attaching to an entity owned by another organization', async () => {
    // The row exists, but not in the caller's organization: it must look like it does not exist.
    const r = await attach(valid(), rival.token);
    expect(r.status).toBe(404);
  });

  it('refuses attaching to an entity that does not exist', async () => {
    const r = await attach(valid({ entityId: '00000000-0000-0000-0000-0000000000ff' }));
    expect(r.status).toBe(404);
  });

  it('requires a permission to list attachments', async () => {
    // This endpoint previously had no permission at all: any authenticated account could
    // enumerate evidence photos and invoice documents by entity id.
    const r = await as(student.token).get(`/api/v1/attachments?entityType=job_card&entityId=${jobId}`);
    expect(r.status).toBe(403);
    const allowed = await as(manager.token).get(`/api/v1/attachments?entityType=job_card&entityId=${jobId}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.length).toBeGreaterThan(0);
  });

  it('rejects an attachment listing without a valid entity reference', async () => {
    expect((await as(manager.token).get('/api/v1/attachments')).status).toBe(400);
  });

  it('records the attachment in the audit trail', async () => {
    const ev = await query("select * from audit_events where action='ATTACHMENT_ADDED' and entity_id=$1", [jobId]);
    expect(ev.rowCount).toBeGreaterThan(0);
  });
});

/* ================================================================ finding 4: immutable audit */

describe('audit_events is append-only at the database level', () => {
  it('rejects an UPDATE even from the application database user', async () => {
    const row = await query('select id from audit_events limit 1');
    await expect(
      pool.query("update audit_events set action='TAMPERED' where id=$1", [row.rows[0].id])
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a DELETE', async () => {
    const row = await query('select id from audit_events limit 1');
    await expect(pool.query('delete from audit_events where id=$1', [row.rows[0].id])).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a TRUNCATE, which bypasses row level triggers', async () => {
    await expect(pool.query('truncate audit_events')).rejects.toMatchObject({ code: '42501' });
  });

  it('still allows new events to be appended', async () => {
    const before = Number((await query('select count(*) c from audit_events')).rows[0].c);
    await as(manager.token).post('/api/v1/customers', { name: uniq('Audit Customer') });
    const after = Number((await query('select count(*) c from audit_events')).rows[0].c);
    expect(after).toBeGreaterThan(before);
  });
});

/* ================================================================ error handling and transport */

describe('error handling', () => {
  it('returns 400, not 500, for a malformed identifier', async () => {
    const r = await as(manager.token).get('/api/v1/jobs/abc');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a malformed identifier on nested resources', async () => {
    expect((await as(manager.token).get('/api/v1/customers/not-a-uuid')).status).toBe(400);
    expect((await as(manager.token).get('/api/v1/customers/not-a-uuid/vehicles')).status).toBe(400);
  });

  it('carries a request id on every error so a log line can be found', async () => {
    const r = await as(manager.token).get('/api/v1/jobs/abc');
    expect(r.body.error.details.requestId).toBeTruthy();
    expect(r.headers['x-request-id']).toBeTruthy();
  });
});

describe('transport defaults are safe without configuration', () => {
  it('does not reflect an arbitrary origin', async () => {
    const { allowedCorsOrigins } = await import('../src/app.js');
    expect(allowedCorsOrigins).not.toContain('*');
    const r = await api().get('/health/live').set('Origin', 'https://evil.example');
    expect(r.headers['access-control-allow-origin']).not.toBe('*');
    expect(r.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('refuses to sign tokens with a hard-coded development secret in production', async () => {
    const { accessSecret } = await import('../src/auth.js');
    const previousEnv = process.env.NODE_ENV;
    const previousSecret = process.env.JWT_ACCESS_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_ACCESS_SECRET;
    try {
      expect(() => accessSecret()).toThrow(/JWT_ACCESS_SECRET/);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousSecret !== undefined) process.env.JWT_ACCESS_SECRET = previousSecret;
    }
  });

  it('never logs a secret even when one is handed to the logger', async () => {
    const { redact } = await import('../src/logger.js');
    const out = redact({ password: 'hunter2', nested: { refreshToken: 'abc', keep: 1 } });
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.refreshToken).toBe('[REDACTED]');
    expect(out.nested.keep).toBe(1);
  });
});

/* ================================================================ login throttling */

describe('login throttling locks attackers out without locking the user out', () => {
  const EMAIL = 'advisor@wst.local';

  it('locks the account after repeated failures', async () => {
    await query('delete from login_attempts where email=$1', [EMAIL]);
    for (let i = 0; i < 5; i++)
      await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'wrong-password' });
    const r = await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'Password123!' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('AUTH_LOCKED');
  });

  it('resets the counter on a successful sign-in, so scattered typos never lock a real user', async () => {
    // Counting every failure in the window meant four typos today plus one tomorrow-morning typo
    // locked an account the user had signed into successfully in between.
    await query('delete from login_attempts where email=$1', [EMAIL]);
    for (let i = 0; i < 4; i++)
      await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'wrong-password' });
    expect((await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'Password123!' })).status).toBe(200);

    for (let i = 0; i < 4; i++)
      await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'wrong-password' });
    const r = await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'Password123!' });
    expect(r.status).toBe(200);
    await query('delete from login_attempts where email=$1', [EMAIL]);
  });

  it('never reveals whether the address exists', async () => {
    const unknown = await api().post('/api/v1/auth/login').send({ email: 'nobody@wst.local', password: 'Password123!' });
    const known = await api().post('/api/v1/auth/login').send({ email: 'qc@wst.local', password: 'wrong-password' });
    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);
    expect(unknown.body.error.code).toBe(known.body.error.code);
    await query("delete from login_attempts where email in ('nobody@wst.local','qc@wst.local')");
  });
});
