import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db/index.js';
import { auth, currentUser, orgOf, requirePermission } from '../auth.js';
import { asyncRoute, created, DomainError, forbidden, notFound, ok, pageParams, uuid } from '../http.js';
import { audit, inScope, notify } from '../core.js';
import { assertSessionPublishable, certificationStatus, conflictError, findSessionConflicts, reserveBay, releaseBay } from '../services.js';
import { decryptToken, encryptToken } from '../crypto.js';

export const trainingRoutes = Router();
/** Mounted before every authenticated router so the public contract is reachable without a token. */
export const publicTrainingRoutes = Router();

/* ---------------------------------------------------------------- public certificate verification */
/** Public, unauthenticated, minimal-disclosure contract: no student PII beyond the student number. */
publicTrainingRoutes.get(
  '/certificates/verify/:token',
  asyncRoute(async (req: any, res: any) => {
    const hash = crypto.createHash('sha256').update(String(req.params.token)).digest('hex');
    const r = await query(
      `select c.issue_date, c.status, c.revoked_at, c.coverage_json, s.student_no, co.name course_name, o.name organization_name
         from certificates c
         join students s on s.id=c.student_id
         join courses co on co.id=c.course_id
         join organizations o on o.id=c.organization_id
        where c.public_token_hash=$1`,
      [hash]
    );
    if (!r.rowCount) return ok(res, { valid: false, reason: 'NOT_FOUND' });
    const c = r.rows[0];
    ok(res, {
      valid: c.status === 'ISSUED' && !c.revoked_at,
      status: c.status,
      studentNo: c.student_no,
      course: c.course_name,
      organization: c.organization_name,
      issueDate: c.issue_date,
      revokedAt: c.revoked_at,
      competencyCoverage: c.coverage_json,
    });
  })
);

trainingRoutes.use(auth);


/* ---------------------------------------------------------------- catalogue */

trainingRoutes.post('/terms', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ code: z.string().min(1), name: z.string().min(2), startsOn: z.string(), endsOn: z.string() }).parse(req.body);
  const r = await query('insert into terms(organization_id,code,name,starts_on,ends_on) values($1,$2,$3,$4,$5) returning *', [orgOf(req), b.code, b.name, b.startsOn, b.endsOn]);
  ok(res, r.rows[0]);
}));

trainingRoutes.get('/terms', requirePermission('training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  ok(res, (await query('select * from terms where organization_id=$1 order by starts_on desc', [orgOf(req)])).rows);
}));

trainingRoutes.post('/courses', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ code: z.string().min(1), name: z.string().min(2), durationHours: z.number().int().nonnegative().optional(), termId: uuid.optional() }).parse(req.body);
  const r = await query('insert into courses(organization_id,code,name,duration_hours,term_id) values($1,$2,$3,$4,$5) returning *', [orgOf(req), b.code, b.name, b.durationHours ?? 0, b.termId ?? null]);
  await audit(req, 'COURSE_CREATED', 'course', r.rows[0].id, { code: b.code });
  ok(res, r.rows[0]);
}));

trainingRoutes.get('/courses', requirePermission('training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  const { page, pageSize, offset } = pageParams(req);
  const rows = await query(`select * from courses where organization_id=$1 order by code limit ${pageSize} offset ${offset}`, [orgOf(req)]);
  const total = await query('select count(*) c from courses where organization_id=$1', [orgOf(req)]);
  ok(res, rows.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

trainingRoutes.post('/competencies', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ code: z.string().min(1), name: z.string().min(2) }).parse(req.body);
  const r = await query('insert into competencies(organization_id,code,name) values($1,$2,$3) returning *', [orgOf(req), b.code, b.name]);
  ok(res, r.rows[0]);
}));

trainingRoutes.post('/courses/:id/tasks', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ code: z.string().min(1), title: z.string().min(2), required: z.boolean().optional(), weight: z.number().positive().optional(), competencyIds: z.array(uuid).optional() }).parse(req.body);
  const course = await inScope.course(orgOf(req), req.params.id);
  const out = await tx(async (c) => {
    const t = await c.query('insert into practical_tasks(course_id,code,title,required,weight) values($1,$2,$3,$4,$5) returning *', [course.id, b.code, b.title, b.required ?? true, b.weight ?? 1]);
    for (const cid of b.competencyIds ?? []) {
      const comp = await c.query('select id from competencies where id=$1 and organization_id=$2', [cid, orgOf(req)]);
      if (!comp.rowCount) throw notFound('Competency');
      await c.query('insert into task_competencies(task_id,competency_id) values($1,$2) on conflict do nothing', [t.rows[0].id, cid]);
    }
    return t.rows[0];
  });
  ok(res, out);
}));

trainingRoutes.get('/courses/:id/tasks', requirePermission('training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  const course = await inScope.course(orgOf(req), req.params.id);
  const r = await query(
    `select pt.*, coalesce(json_agg(json_build_object('id',cp.id,'code',cp.code,'name',cp.name)) filter (where cp.id is not null), '[]') competencies
       from practical_tasks pt
       left join task_competencies tc on tc.task_id=pt.id
       left join competencies cp on cp.id=tc.competency_id
      where pt.course_id=$1 group by pt.id order by pt.code`,
    [course.id]
  );
  ok(res, r.rows);
}));

/* ---------------------------------------------------------------- students & groups */

trainingRoutes.post('/student-groups', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ code: z.string().min(1), name: z.string().min(2), termId: uuid.optional() }).parse(req.body);
  const r = await query('insert into student_groups(organization_id,code,name,term_id) values($1,$2,$3,$4) returning *', [orgOf(req), b.code, b.name, b.termId ?? null]);
  ok(res, r.rows[0]);
}));

trainingRoutes.post('/students', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ studentNo: z.string().min(1), fullName: z.string().min(2), userId: uuid.optional(), groupId: uuid.optional() }).parse(req.body);
  const r = await query('insert into students(organization_id,student_no,full_name,user_id,group_id) values($1,$2,$3,$4,$5) returning *', [orgOf(req), b.studentNo, b.fullName, b.userId ?? null, b.groupId ?? null]);
  await audit(req, 'STUDENT_CREATED', 'student', r.rows[0].id, { studentNo: b.studentNo });
  ok(res, r.rows[0]);
}));

trainingRoutes.get('/students', requirePermission('training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  const { page, pageSize, offset } = pageParams(req);
  const params = [orgOf(req), String(req.query.q || '')];
  const where = `organization_id=$1 and ($2='' or student_no ilike '%'||$2||'%' or full_name ilike '%'||$2||'%')`;
  const rows = await query(`select * from students where ${where} order by student_no limit ${pageSize} offset ${offset}`, params);
  const total = await query(`select count(*) c from students where ${where}`, params);
  // Student records are personal data: listing them is a sensitive read and is audited.
  await audit(req, 'STUDENTS_LISTED', 'student', null, { rows: rows.rowCount, query: params[1] || null });
  ok(res, rows.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

/* ---------------------------------------------------------------- sessions */

// Blueprint phase 3: "Mentor / Supervisor". A mentor may create a draft; publishing (which takes the
// shared bay) stays with training:write.
trainingRoutes.post('/training-sessions', requirePermission('training:write', 'training:schedule'), asyncRoute(async (req: any, res: any) => {
  const b = z
    .object({
      courseId: uuid, title: z.string().optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime(),
      bayId: uuid.optional(), mentorId: uuid.optional(), groupId: uuid.optional(), capacity: z.number().int().positive(),
    })
    .parse(req.body);
  // Least privilege: someone who can only *schedule* (a mentor) creates sessions they will teach
  // themselves; a supervisor (training:write) can assign any mentor.
  if (!currentUser(req).permissions.includes('training:write')) {
    if (b.mentorId && b.mentorId !== currentUser(req).id)
      throw forbidden('Mentors can only schedule sessions that they teach themselves');
    b.mentorId = currentUser(req).id;
  }
  await inScope.course(orgOf(req), b.courseId);
  if (new Date(b.endsAt) <= new Date(b.startsAt)) throw new DomainError('INVALID_WINDOW', 'endsAt must be after startsAt');
  if (b.mentorId) {
    const m = await query('select 1 from users where id=$1 and organization_id=$2', [b.mentorId, orgOf(req)]);
    if (!m.rowCount) throw notFound('Mentor');
  }
  const r = await query(
    `insert into training_sessions(organization_id,course_id,title,starts_at,ends_at,bay_id,mentor_id,group_id,capacity)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [orgOf(req), b.courseId, b.title ?? null, b.startsAt, b.endsAt, b.bayId ?? null, b.mentorId ?? null, b.groupId ?? null, b.capacity]
  );
  created(res, r.rows[0]);
}));

trainingRoutes.get('/training-sessions', requirePermission('training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  const { page, pageSize, offset } = pageParams(req);
  const r = await query(
    `select ts.*, co.name course_name, b.code bay_code, u.display_name mentor_name,
            (select count(*) from enrollments e where e.session_id=ts.id) enrolled
       from training_sessions ts
       left join courses co on co.id=ts.course_id
       left join bays b on b.id=ts.bay_id
       left join users u on u.id=ts.mentor_id
      where ts.organization_id=$1 and ($2='' or ts.status=$2) order by ts.starts_at, ts.id limit ${pageSize} offset ${offset}`,
    [orgOf(req), String(req.query.status || '')]
  );
  const total = await query("select count(*) c from training_sessions where organization_id=$1 and ($2='' or status=$2)", [
    orgOf(req), String(req.query.status || ''),
  ]);
  ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

/** Dry-run conflict check so the scheduler UI can warn before attempting to publish. */
trainingRoutes.get('/training-sessions/:id/conflicts', requirePermission('training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  const s = await inScope.session(orgOf(req), req.params.id);
  const conflicts = await findSessionConflicts({ query: (t: string, p: any[]) => query(t, p) }, orgOf(req), s);
  ok(res, { sessionId: s.id, hasConflict: conflicts.length > 0, conflicts });
}));

/** Rule 8: a session with a bay / mentor / technician overlap cannot be published. */
trainingRoutes.post('/training-sessions/:id/publish', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const out = await tx(async (c) => {
    const s = await inScope.session(orgOf(req), req.params.id, c, true);
    if (s.status === 'PUBLISHED') return s;
    assertSessionPublishable(s);
    const conflicts = await findSessionConflicts(c, orgOf(req), s);
    if (conflicts.length) throw conflictError(conflicts);
    // Taking the bay in the shared calendar is what makes the protection symmetric and
    // concurrency-safe: two sessions, or a session and a job, published at the same instant are
    // separated by the exclusion constraint rather than by a check that both of them passed.
    await reserveBay(c, {
      organizationId: orgOf(req), bayId: s.bay_id, sourceType: 'SESSION', sourceId: s.id,
      startsAt: s.starts_at, endsAt: s.ends_at, userId: currentUser(req).id,
    });
    const r = await c.query("update training_sessions set status='PUBLISHED' where id=$1 returning *", [s.id]);
    await audit(req, 'SESSION_PUBLISHED', 'training_session', s.id, { bayId: s.bay_id, mentorId: s.mentor_id }, c);
    if (s.mentor_id) await notify(orgOf(req), s.mentor_id, 'SESSION_PUBLISHED', { sessionId: s.id }, c);
    return r.rows[0];
  });
  ok(res, out);
}));

/** Releasing a session frees its bay for workshop jobs; without it a cancelled class blocks a bay. */
trainingRoutes.post('/training-sessions/:id/cancel', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ reason: z.string().min(3) }).parse(req.body);
  const out = await tx(async (c) => {
    const s = await inScope.session(orgOf(req), req.params.id, c, true);
    if (s.status === 'CANCELLED') throw new DomainError('INVALID_STATE', 'Session is already cancelled');
    await releaseBay(c, 'SESSION', s.id);
    const r = await c.query("update training_sessions set status='CANCELLED' where id=$1 returning *", [s.id]);
    await audit(req, 'SESSION_CANCELLED', 'training_session', s.id, { reason: b.reason }, c);
    return r.rows[0];
  });
  ok(res, out);
}));

trainingRoutes.post('/training-sessions/:id/enrollments', requirePermission('training:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ studentIds: z.array(uuid).min(1) }).parse(req.body);
  const out = await tx(async (c) => {
    const s = await inScope.session(orgOf(req), req.params.id, c, true);
    const count = Number((await c.query('select count(*) c from enrollments where session_id=$1', [s.id])).rows[0].c);
    if (count + b.studentIds.length > Number(s.capacity))
      throw new DomainError('CAPACITY_EXCEEDED', 'Session capacity exceeded', 409, { capacity: Number(s.capacity), enrolled: count });
    for (const sid of b.studentIds) {
      await inScope.student(orgOf(req), sid, c);
      await c.query('insert into enrollments(session_id,student_id) values($1,$2) on conflict do nothing', [s.id, sid]);
    }
    await audit(req, 'STUDENTS_ENROLLED', 'training_session', s.id, { studentIds: b.studentIds }, c);
    return { sessionId: s.id, enrolled: count + b.studentIds.length };
  });
  ok(res, out);
}));

trainingRoutes.post('/training-sessions/:id/attendance', requirePermission('attendance:write', 'assessment:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ studentId: uuid, status: z.enum(['PRESENT', 'ABSENT', 'LATE']) }).parse(req.body);
  const out = await tx(async (c) => {
    const s = await inScope.session(orgOf(req), req.params.id, c);
    await inScope.student(orgOf(req), b.studentId, c);
    const enrolled = await c.query('select 1 from enrollments where session_id=$1 and student_id=$2', [s.id, b.studentId]);
    if (!enrolled.rowCount) throw new DomainError('NOT_ENROLLED', 'Student is not enrolled in this session', 422);
    const r = await c.query(
      `insert into attendances(session_id,student_id,status,recorded_by) values($1,$2,$3,$4)
       on conflict(session_id,student_id) do update set status=excluded.status, recorded_by=excluded.recorded_by returning *`,
      [s.id, b.studentId, b.status, currentUser(req).id]
    );
    return r.rows[0];
  });
  ok(res, out);
}));

/* ---------------------------------------------------------------- assessments */

trainingRoutes.post('/training-sessions/:id/assessments', requirePermission('assessment:write'), asyncRoute(async (req: any, res: any) => {
  const b = z
    .object({ studentId: uuid, taskId: uuid, result: z.enum(['PASS', 'FAIL', 'NEEDS_IMPROVEMENT']), timeOnTask: z.number().int().nonnegative(), mentorNote: z.string().optional() })
    .parse(req.body);
  const out = await tx(async (c) => {
    const s = await inScope.session(orgOf(req), req.params.id, c);
    await inScope.student(orgOf(req), b.studentId, c);
    const task = await c.query('select 1 from practical_tasks where id=$1 and course_id=$2', [b.taskId, s.course_id]);
    if (!task.rowCount) throw new DomainError('TASK_NOT_IN_COURSE', 'Task does not belong to this session course', 422);
    const existing = await c.query('select * from assessments where session_id=$1 and student_id=$2 and task_id=$3 for update', [s.id, b.studentId, b.taskId]);
    if (existing.rowCount && existing.rows[0].status === 'SIGNED')
      throw new DomainError('ALREADY_SIGNED', 'A signed assessment cannot be edited; revoke the sign-off first', 409);
    const r = await c.query(
      `insert into assessments(session_id,student_id,task_id,result,time_on_task,mentor_note,entered_by,status)
       values($1,$2,$3,$4,$5,$6,$7,'PENDING_SIGNATURE')
       on conflict(session_id,student_id,task_id) do update set result=excluded.result, time_on_task=excluded.time_on_task,
            mentor_note=excluded.mentor_note, entered_by=excluded.entered_by, status='PENDING_SIGNATURE' returning *`,
      [s.id, b.studentId, b.taskId, b.result, b.timeOnTask, b.mentorNote ?? null, currentUser(req).id]
    );
    await audit(req, 'ASSESSMENT_RECORDED', 'assessment', r.rows[0].id, { result: b.result, status: 'PENDING_SIGNATURE' }, c);
    return r.rows[0];
  });
  ok(res, out);
}));

/** Rule 9 (part 1): sign-off is a separate act by a supervisor, never by the mentor who entered it. */
trainingRoutes.post('/assessments/:id/signoff', requirePermission('assessment:signoff'), asyncRoute(async (req: any, res: any) => {
  const out = await tx(async (c) => {
    const a = await inScope.assessment(orgOf(req), req.params.id, c, true);
    if (a.status === 'SIGNED') throw new DomainError('ALREADY_SIGNED', 'Assessment is already signed', 409);
    if (a.entered_by === currentUser(req).id)
      throw new DomainError('SEPARATION_OF_DUTIES', 'The mentor who recorded an assessment cannot sign it off', 409);
    await c.query("update assessments set status='SIGNED' where id=$1", [a.id]);
    await c.query('insert into assessment_signoffs(assessment_id,signed_by) values($1,$2)', [a.id, currentUser(req).id]);
    await audit(req, 'ASSESSMENT_SIGNED', 'assessment', a.id, { signedBy: currentUser(req).id }, c);
    return { ...a, status: 'SIGNED' };
  });
  ok(res, out);
}));

trainingRoutes.get('/students/:id/competency-coverage', requirePermission('training:read', 'training:write', 'assessment:write'), asyncRoute(async (req: any, res: any) => {
  const student = await inScope.student(orgOf(req), req.params.id);
  const courseId = String(req.query.courseId || '');
  if (!courseId) throw new DomainError('COURSE_REQUIRED', 'courseId query parameter is required', 400);
  await inScope.course(orgOf(req), courseId);
  const status = await certificationStatus({ query: (t: string, p: any[]) => query(t, p) }, orgOf(req), student.id, courseId);
  ok(res, { studentId: student.id, courseId, ...status });
}));

/* ---------------------------------------------------------------- certificates */

/** Rule 9 (part 2): issuing is blocked while any required assessment is unsigned. */
trainingRoutes.post('/certificates', requirePermission('certificate:issue'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ studentId: uuid, courseId: uuid }).parse(req.body);
  const out = await tx(async (c) => {
    const student = await inScope.student(orgOf(req), b.studentId, c);
    const course = await inScope.course(orgOf(req), b.courseId, c);
    const status = await certificationStatus(c, orgOf(req), student.id, course.id);
    if (!status.eligible)
      throw new DomainError('NOT_ELIGIBLE', 'Student does not meet the certification rules', 422, status);
    const token = crypto.randomBytes(24).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const cert = await c.query(
      `insert into certificates(organization_id,student_id,course_id,public_token_hash,token_cipher,issued_by,coverage_json)
       values($1,$2,$3,$4,$5,$6,$7) returning *`,
      [orgOf(req), student.id, course.id, hash, encryptToken(token), currentUser(req).id,
       JSON.stringify({ coverage: status.coverage, attendanceRatio: status.attendanceRatio, requiredTasks: status.requiredTasks })]
    );
    await audit(req, 'CERTIFICATE_ISSUED', 'certificate', cert.rows[0].id, { studentId: student.id, courseId: course.id }, c);
    if (student.user_id) {
      await notify(orgOf(req), student.user_id, 'CERTIFICATE_ISSUED', { certificateId: cert.rows[0].id, courseId: course.id }, c);
    }
    return {
      ...cert.rows[0],
      verificationToken: token,
      verifyUrl: `${process.env.PUBLIC_URL || 'http://localhost:4000'}/api/v1/certificates/verify/${token}`,
      qrUrl: `/api/v1/certificates/${cert.rows[0].id}/qr?token=${token}`,
    };
  });
  ok(res, out);
}));

trainingRoutes.post('/certificates/:id/revoke', requirePermission('certificate:revoke', 'certificate:issue'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ reason: z.string().min(3) }).parse(req.body);
  const out = await tx(async (c) => {
    const cert = await c.query('select * from certificates where id=$1 and organization_id=$2 for update', [req.params.id, orgOf(req)]);
    if (!cert.rowCount) throw notFound('Certificate');
    const r = await c.query("update certificates set status='REVOKED', revoked_at=now(), revoke_reason=$1 where id=$2 returning *", [b.reason, req.params.id]);
    await audit(req, 'CERTIFICATE_REVOKED', 'certificate', req.params.id, { reason: b.reason }, c);
    return r.rows[0];
  });
  ok(res, out);
}));

/* ================================================================ WST-FR-12: QR-verifiable certificate */

/**
 * Returns the QR code for a certificate as SVG or a PNG data URL. The encoded value is the public
 * verification URL with a signed random token — no internal student id and no grade history.
 */
trainingRoutes.get(
  '/certificates/:id/qr',
  requirePermission('certificate:issue', 'training:read', 'report:read'),
  asyncRoute(async (req: any, res: any) => {
    const cert = await query('select * from certificates where id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    if (!cert.rowCount) throw notFound('Certificate');
    // A caller may still pass the token it received at issue time, but it is no longer required:
    // the token is recoverable from its encrypted copy, so a student can always re-render their QR.
    const supplied = String(req.query.token || '');
    let token = supplied;
    if (token) {
      const expected = crypto.createHash('sha256').update(token).digest('hex');
      if (expected !== cert.rows[0].public_token_hash)
        throw new DomainError('VALIDATION_ERROR', 'Token does not match this certificate', 400);
    } else {
      token = decryptToken(cert.rows[0].token_cipher) ?? '';
      if (!token)
        throw new DomainError('TOKEN_UNRECOVERABLE', 'This certificate predates encrypted tokens; reissue it to regenerate a QR code', 409);
    }

    const base = process.env.PUBLIC_URL || 'http://localhost:4000';
    const verifyUrl = `${base}/api/v1/certificates/verify/${token}`;
    const QRCode = (await import('qrcode')).default;
    if (String(req.query.format || 'svg') === 'png') {
      const dataUrl = await QRCode.toDataURL(verifyUrl, { width: 320, margin: 1 });
      return ok(res, { verifyUrl, format: 'png', dataUrl });
    }
    const svg = await QRCode.toString(verifyUrl, { type: 'svg', margin: 1 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  })
);

trainingRoutes.get(
  '/certificates',
  requirePermission('certificate:issue', 'training:read', 'report:read'),
  asyncRoute(async (req: any, res: any) => {
    const { page, pageSize, offset } = pageParams(req);
    const params = [orgOf(req), String(req.query.status || ''), req.query.studentId || null];
    const where = `c.organization_id=$1 and ($2='' or c.status=$2) and ($3::uuid is null or c.student_id=$3::uuid)`;
    const r = await query(
      `select c.id, c.status, c.issue_date, c.revoked_at, c.coverage_json, s.student_no, s.full_name, co.code course_code, co.name course_name
         from certificates c join students s on s.id=c.student_id join courses co on co.id=c.course_id
        where ${where} order by c.issue_date desc, c.id desc limit ${pageSize} offset ${offset}`,
      params
    );
    const total = await query(`select count(*) c from certificates c where ${where}`, params);
    await audit(req, 'CERTIFICATES_LISTED', 'certificate', null, { rows: r.rowCount, filters: { status: req.query.status ?? null } });
    ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
  })
);

/* ================================================================ WST-FR-01 / actor "Student"
 * "Views assigned sessions, attendance, tasks, results, competencies, and certificates."
 * A student holds no training:* permission, so every staff endpoint correctly rejects them. These
 * endpoints are the student's own scope: they take no identifier at all and read the student id
 * from the authenticated token, which makes accessing somebody else's record unrepresentable
 * rather than merely forbidden.
 */

const meStudent = async (req: any) => {
  const me = currentUser(req);
  if (!me.studentId) throw forbidden('This account is not linked to a student record');
  const r = await query('select * from students where id=$1 and organization_id=$2', [me.studentId, orgOf(req)]);
  if (!r.rowCount) throw notFound('Student');
  return r.rows[0];
};

trainingRoutes.get('/me/student', asyncRoute(async (req: any, res: any) => {
  const student = await meStudent(req);
  const group = student.group_id
    ? (await query('select code, name from student_groups where id=$1', [student.group_id])).rows[0]
    : null;
  ok(res, { id: student.id, studentNo: student.student_no, fullName: student.full_name, status: student.status, group });
}));

trainingRoutes.get('/me/sessions', asyncRoute(async (req: any, res: any) => {
  const student = await meStudent(req);
  const { page, pageSize, offset } = pageParams(req);
  const r = await query(
    `select ts.id, ts.title, ts.starts_at, ts.ends_at, ts.status, co.code course_code, co.name course_name,
            co.name_ar course_name_ar, b.code bay_code, u.display_name mentor_name,
            at.status attendance_status
       from enrollments e
       join training_sessions ts on ts.id = e.session_id
       join courses co on co.id = ts.course_id
       left join bays b on b.id = ts.bay_id
       left join users u on u.id = ts.mentor_id
       left join attendances at on at.session_id = ts.id and at.student_id = e.student_id
      where e.student_id=$1 and ts.organization_id=$2
      order by ts.starts_at desc, ts.id desc limit ${pageSize} offset ${offset}`,
    [student.id, orgOf(req)]
  );
  const total = await query('select count(*) c from enrollments where student_id=$1', [student.id]);
  ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

trainingRoutes.get('/me/attendance', asyncRoute(async (req: any, res: any) => {
  const student = await meStudent(req);
  const r = await query(
    `select at.status, ts.id session_id, ts.title, ts.starts_at, co.name course_name
       from attendances at
       join training_sessions ts on ts.id = at.session_id
       join courses co on co.id = ts.course_id
      where at.student_id=$1 and ts.organization_id=$2 order by ts.starts_at desc`,
    [student.id, orgOf(req)]
  );
  const attended = r.rows.filter((x: any) => ['PRESENT', 'LATE'].includes(x.status)).length;
  ok(res, {
    records: r.rows,
    summary: { total: r.rowCount, attended, ratio: r.rowCount ? Math.round((attended / r.rowCount) * 100) / 100 : null },
  });
}));

/** Tasks and results. An assessment that is not yet signed is shown as pending, never as a grade. */
trainingRoutes.get('/me/results', asyncRoute(async (req: any, res: any) => {
  const student = await meStudent(req);
  const r = await query(
    `select a.id, a.result, a.status, a.time_on_task, a.mentor_note,
            pt.code task_code, pt.title task_title, pt.title_ar task_title_ar, pt.required,
            co.id course_id, co.name course_name, ts.starts_at
       from assessments a
       join training_sessions ts on ts.id = a.session_id
       join courses co on co.id = ts.course_id
       join practical_tasks pt on pt.id = a.task_id
      where a.student_id=$1 and ts.organization_id=$2 order by ts.starts_at desc, pt.code`,
    [student.id, orgOf(req)]
  );
  ok(res, r.rows.map((x: any) => ({
    ...x,
    result: x.status === 'SIGNED' ? x.result : null,
    provisionalResult: x.status === 'SIGNED' ? null : x.result,
    countsTowardCertification: x.status === 'SIGNED',
  })));
}));

trainingRoutes.get('/me/competencies', asyncRoute(async (req: any, res: any) => {
  const student = await meStudent(req);
  const courses = await query(
    `select distinct co.id, co.code, co.name from enrollments e
       join training_sessions ts on ts.id=e.session_id join courses co on co.id=ts.course_id
      where e.student_id=$1 and ts.organization_id=$2`,
    [student.id, orgOf(req)]
  );
  const out: any[] = [];
  for (const course of courses.rows) {
    const status = await certificationStatus({ query: (t: string, p: any[]) => query(t, p) }, orgOf(req), student.id, course.id);
    out.push({ course, ...status });
  }
  ok(res, out);
}));

trainingRoutes.get('/me/certificates', asyncRoute(async (req: any, res: any) => {
  const student = await meStudent(req);
  const r = await query(
    `select c.id, c.status, c.issue_date, c.revoked_at, c.coverage_json, co.code course_code, co.name course_name
       from certificates c join courses co on co.id=c.course_id
      where c.student_id=$1 and c.organization_id=$2 order by c.issue_date desc`,
    [student.id, orgOf(req)]
  );
  ok(res, r.rows.map((x: any) => ({ ...x, qrUrl: `/api/v1/me/certificates/${x.id}/qr` })));
}));

/** A student can always re-render the QR code for their own certificate. */
trainingRoutes.get('/me/certificates/:id/qr', asyncRoute(async (req: any, res: any) => {
  const student = await meStudent(req);
  const cert = await query('select * from certificates where id=$1 and student_id=$2 and organization_id=$3', [
    req.params.id, student.id, orgOf(req),
  ]);
  if (!cert.rowCount) throw notFound('Certificate');
  const token = decryptToken(cert.rows[0].token_cipher);
  if (!token)
    throw new DomainError('TOKEN_UNRECOVERABLE', 'This certificate predates encrypted tokens; ask your supervisor to reissue it', 409);
  const verifyUrl = `${process.env.PUBLIC_URL || 'http://localhost:4000'}/api/v1/certificates/verify/${token}`;
  const QRCode = (await import('qrcode')).default;
  if (String(req.query.format || 'svg') === 'png')
    return ok(res, { verifyUrl, format: 'png', dataUrl: await QRCode.toDataURL(verifyUrl, { width: 320, margin: 1 }) });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(await QRCode.toString(verifyUrl, { type: 'svg', margin: 1 }));
}));
