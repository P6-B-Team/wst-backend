import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/index.js';
import { auth, currentUser, orgOf, requirePermission } from '../auth.js';
import { asyncRoute, DomainError, ok, pageParams, toCsv, uuid } from '../http.js';
import { audit, settings } from '../core.js';
import { reorderSuggestions, trainingRisk } from '../services.js';
import { withModelFallback } from '../ai-adapter.js';

export const analyticsRoutes = Router();
analyticsRoutes.use(auth);

/* ---------------------------------------------------------------- dashboards */

const workshopKpis = async (org: string) => {
  const [stages, throughput, rework, approval] = await Promise.all([
    query('select status, count(*)::int count from job_cards where organization_id=$1 group by status', [org]),
    query(
      `select count(*)::int delivered,
              coalesce(round(avg(extract(epoch from (closed_at - created_at))/3600)::numeric,2),0) avg_turnaround_hours
         from job_cards where organization_id=$1 and status='DELIVERED'`,
      [org]
    ),
    query(
      `select count(*)::int rework_events from job_stage_history h join job_cards j on j.id=h.job_card_id
        where j.organization_id=$1 and h.from_status='QUALITY_CHECK' and h.to_status='IN_PROGRESS'`,
      [org]
    ),
    query(
      `select count(*) filter (where customer_approval_status='APPROVED')::int approved,
              count(*) filter (where customer_approval_status='PENDING')::int pending_approval
         from job_cards where organization_id=$1`,
      [org]
    ),
  ]);
  return { jobsByStage: stages.rows, throughput: throughput.rows[0], rework: rework.rows[0], approvals: approval.rows[0] };
};

analyticsRoutes.get('/dashboards/workshop', requirePermission('report:read'), asyncRoute(async (req: any, res: any) => {
  ok(res, await workshopKpis(orgOf(req)));
}));

analyticsRoutes.get('/dashboards/inventory', requirePermission('report:read', 'stock:read'), asyncRoute(async (req: any, res: any) => {
  const [value, movements, alerts] = await Promise.all([
    query(
      `select coalesce(round(sum(sb.on_hand * p.average_cost)::numeric,2),0) stock_value, count(distinct p.id)::int parts
         from parts p left join stock_balances sb on sb.part_id=p.id where p.organization_id=$1`,
      [orgOf(req)]
    ),
    query(
      `select type, count(*)::int count, coalesce(sum(abs(quantity)),0) quantity
         from stock_movements where organization_id=$1 and created_at > now() - interval '30 days' group by type`,
      [orgOf(req)]
    ),
    reorderSuggestions(orgOf(req)),
  ]);
  ok(res, { valuation: value.rows[0], movements30d: movements.rows, belowMinimum: alerts.length, reorderSuggestions: alerts.slice(0, 20) });
}));

analyticsRoutes.get('/dashboards/finance', requirePermission('report:read', 'invoice:read'), asyncRoute(async (req: any, res: any) => {
  const r = await query(
    `select count(*)::int invoices,
            coalesce(sum(total_amount),0) invoiced,
            coalesce(sum(case when status='PAID' then total_amount else 0 end),0) collected,
            coalesce(sum(subtotal_parts),0) parts_revenue,
            coalesce(sum(subtotal_labor),0) labor_revenue,
            coalesce(sum(tax_amount),0) tax
       from invoices where organization_id=$1 and status<>'CANCELLED'`,
    [orgOf(req)]
  );
  const outstanding = await query(
    `select coalesce(sum(i.total_amount),0) - coalesce((select sum(amount) from payment_references pr join invoices i2 on i2.id=pr.invoice_id where i2.organization_id=$1),0) outstanding
       from invoices i where i.organization_id=$1 and i.status='ISSUED'`,
    [orgOf(req)]
  );
  ok(res, { ...r.rows[0], outstanding: Number(outstanding.rows[0].outstanding) });
}));

analyticsRoutes.get('/dashboards/training', requirePermission('report:read', 'training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  const [sessions, assessments, certs, risk] = await Promise.all([
    query('select status, count(*)::int count from training_sessions where organization_id=$1 group by status', [orgOf(req)]),
    query(
      `select a.status, count(*)::int count from assessments a join training_sessions ts on ts.id=a.session_id
        where ts.organization_id=$1 group by a.status`,
      [orgOf(req)]
    ),
    query("select count(*) filter (where status='ISSUED')::int issued, count(*) filter (where status='REVOKED')::int revoked from certificates where organization_id=$1", [orgOf(req)]),
    trainingRisk(orgOf(req)),
  ]);
  ok(res, {
    sessionsByStatus: sessions.rows,
    assessmentsByStatus: assessments.rows,
    certificates: certs.rows[0],
    atRiskStudents: risk.filter((r) => r.band !== 'LOW').length,
    riskSample: risk.slice(0, 10),
  });
}));

/** Student-scoped dashboard: a student may only ever see their own record. */
analyticsRoutes.get('/dashboards/student', asyncRoute(async (req: any, res: any) => {
  const me = currentUser(req);
  const requested = String(req.query.studentId || '');
  const staff = me.permissions.includes('training:read') || me.permissions.includes('training:write');
  /*
   * The old guard only ran `if (me.studentId && ...)`, so any user *without* a student profile
   * skipped it entirely: a technician could pass ?studentId= and read another person's attendance
   * and grades, breaking WST-FR-01's own acceptance evidence. Authorisation is now stated
   * positively — you may read your own record, or anybody's only with a training permission.
   */
  if (requested && requested !== me.studentId && !staff)
    throw new DomainError('FORBIDDEN', 'Students may only view their own dashboard', 403);
  const studentId = requested || me.studentId || '';
  if (!studentId) throw new DomainError('NOT_A_STUDENT', 'No student profile linked to this user', 404);
  uuid.parse(studentId);
  if (staff && studentId !== me.studentId)
    await audit(req, 'STUDENT_RECORD_READ', 'student', studentId, { via: 'dashboards/student' });
  const s = await query('select * from students where id=$1 and organization_id=$2', [studentId, orgOf(req)]);
  if (!s.rowCount) throw new DomainError('NOT_FOUND', 'Student not found', 404);
  const [attendance, assessments] = await Promise.all([
    query(
      `select count(*) filter (where status in ('PRESENT','LATE'))::int attended, count(*)::int total
         from attendances where student_id=$1`,
      [studentId]
    ),
    query(
      `select a.status, a.result, count(*)::int count from assessments a where a.student_id=$1 group by a.status, a.result`,
      [studentId]
    ),
  ]);
  const risk = (await trainingRisk(orgOf(req))).filter((r) => r.studentId === studentId);
  ok(res, { student: s.rows[0], attendance: attendance.rows[0], assessments: assessments.rows, risk });
}));

/* ---------------------------------------------------------------- exports */

/**
 * `dateColumn` is the column each dataset is filtered on. Datasets that describe a current state
 * rather than a stream of events (stock levels, competency coverage) have none, and say so instead
 * of silently ignoring a `from`/`to` the caller supplied.
 */
const exports_: Record<string, { permission: string; sql: string; dateColumn?: string }> = {
  jobs: {
    dateColumn: 'created_at',
    permission: 'report:read',
    sql: `select j.job_no, c.name customer, v.plate_no, j.status, j.customer_approval_status, j.created_at, j.closed_at
            from job_cards j join customers c on c.id=j.customer_id join vehicles v on v.id=j.vehicle_id
           where j.organization_id=$1 order by j.created_at desc`,
  },
  invoices: {
    dateColumn: 'issued_at',
    permission: 'report:read',
    sql: `select i.invoice_no, j.job_no, i.status, i.subtotal_parts, i.subtotal_labor, i.sublet_price,
                 i.discount_amount, i.tax_amount, i.total_amount, i.issued_at
            from invoices i join job_cards j on j.id=i.job_card_id
           where i.organization_id=$1 order by i.issued_at desc`,
  },
  stock: {
    permission: 'stock:read',
    sql: `select p.sku, p.name, s.code store, sb.on_hand, sb.reserved, p.min_level, p.max_level
            from stock_balances sb join parts p on p.id=sb.part_id join stores s on s.id=sb.store_id
           where p.organization_id=$1 order by p.sku`,
  },
  assessments: {
    permission: 'training:read',
    sql: `select st.student_no, co.name course, pt.code task, a.result, a.status, a.time_on_task
            from assessments a join students st on st.id=a.student_id
            join training_sessions ts on ts.id=a.session_id join courses co on co.id=ts.course_id
            join practical_tasks pt on pt.id=a.task_id
           where ts.organization_id=$1 order by st.student_no`,
  },
  technician_utilization: {
    permission: 'report:read',
    sql: `select u.display_name technician,
                 count(distinct j.id) jobs,
                 coalesce(sum(l.minutes),0) labor_minutes,
                 round(coalesce(sum(l.minutes),0)/60.0, 2) labor_hours
            from users u
            left join labor_entries l on l.technician_id = u.id
            left join job_cards j on j.id = l.job_card_id and j.organization_id = $1
           where u.organization_id = $1
           group by u.id order by labor_minutes desc`,
  },
  stock_health: {
    permission: 'stock:read',
    sql: `select p.sku, p.name, p.min_level, p.max_level,
                 coalesce(sum(sb.on_hand),0) on_hand, coalesce(sum(sb.reserved),0) reserved,
                 coalesce(sum(sb.on_hand),0) - coalesce(sum(sb.reserved),0) available,
                 case when coalesce(sum(sb.on_hand),0) - coalesce(sum(sb.reserved),0) <= p.min_level
                      then 'BELOW_MINIMUM' else 'OK' end health
            from parts p left join stock_balances sb on sb.part_id = p.id
           where p.organization_id=$1 group by p.id order by health, p.sku`,
  },
  attendance: {
    dateColumn: 'starts_at',
    permission: 'training:read',
    sql: `select st.student_no, co.name course, ts.title session_title, ts.starts_at, at.status
            from attendances at
            join students st on st.id = at.student_id
            join training_sessions ts on ts.id = at.session_id
            join courses co on co.id = ts.course_id
           where ts.organization_id=$1 order by ts.starts_at desc, st.student_no`,
  },
  competency: {
    permission: 'training:read',
    sql: `select st.student_no, co.name course, cp.code competency, cp.name competency_name,
                 count(*) filter (where a.status='SIGNED' and a.result='PASS') signed_pass,
                 count(*) total_assessments
            from assessments a
            join students st on st.id=a.student_id
            join training_sessions ts on ts.id=a.session_id
            join courses co on co.id=ts.course_id
            join task_competencies tc on tc.task_id=a.task_id
            join competencies cp on cp.id=tc.competency_id
           where ts.organization_id=$1
           group by st.student_no, co.name, cp.code, cp.name order by st.student_no`,
  },
  certification: {
    dateColumn: 'issue_date',
    permission: 'training:read',
    sql: `select st.student_no, co.name course, c.status, c.issue_date, c.revoked_at
            from certificates c join students st on st.id=c.student_id join courses co on co.id=c.course_id
           where c.organization_id=$1 order by c.issue_date desc`,
  },
  turnaround: {
    dateColumn: 'closed_at',
    permission: 'report:read',
    sql: `select j.job_no, j.service_type, j.created_at, j.closed_at,
                 round(extract(epoch from (j.closed_at - j.created_at))/3600.0, 2) turnaround_hours
            from job_cards j where j.organization_id=$1 and j.closed_at is not null
           order by j.closed_at desc`,
  },
  audit: {
    dateColumn: 'occurred_at',
    permission: 'audit:read',
    sql: `select occurred_at, action, entity_type, entity_id, actor_id, metadata_json
            from audit_events where organization_id=$1 order by occurred_at desc limit 5000`,
  },
};

analyticsRoutes.get(
  '/exports/:dataset',
  asyncRoute(async (req: any, res: any) => {
    const def = exports_[req.params.dataset];
    if (!def) throw new DomainError('UNKNOWN_EXPORT', `Unknown dataset. Available: ${Object.keys(exports_).join(', ')}`, 404);
    // The dataset's own permission is required, full stop. The previous `||` meant any holder of
    // report:read could export the audit log, assessments and invoices — a quality checker or a
    // buyer could read the whole audit trail. report:read is not a master key.
    if (!currentUser(req).permissions.includes(def.permission))
      throw new DomainError('FORBIDDEN', `Requires ${def.permission}`, 403);

    const f = z
      .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.coerce.number().int().positive().optional() })
      .parse({ from: req.query.from, to: req.query.to, limit: req.query.limit });
    if (f.from && f.to && new Date(f.to) < new Date(f.from))
      throw new DomainError('INVALID_RANGE', '`to` must not be earlier than `from`', 400);

    if ((f.from || f.to) && !def.dateColumn)
      throw new DomainError('FILTER_NOT_SUPPORTED', `The ${req.params.dataset} dataset is a point-in-time snapshot and has no date to filter on`, 400);

    const cfg = await settings(orgOf(req));
    const cap = Math.min(f.limit ?? Number(cfg.max_export_rows), Number(cfg.max_export_rows));
    // Every export is filtered and capped (common pack: "enforce maximum page and export size").
    const sql = def.dateColumn
      ? `select * from (${def.sql}) x
          where ($2::timestamptz is null or x.${def.dateColumn} >= $2::timestamptz)
            and ($3::timestamptz is null or x.${def.dateColumn} <= $3::timestamptz)
          limit ${cap + 1}`
      : `select * from (${def.sql}) x limit ${cap + 1}`;
    const params = def.dateColumn ? [orgOf(req), f.from ?? null, f.to ?? null] : [orgOf(req)];
    const all = (await query(sql, params)).rows;
    const truncated = all.length > cap;
    const rows = truncated ? all.slice(0, cap) : all;
    await audit(req, 'DATA_EXPORTED', 'export', null, {
      dataset: req.params.dataset, rows: rows.length, truncated,
      filters: { from: f.from ?? null, to: f.to ?? null }, format: String(req.query.format || 'csv'),
    });
    const format = String(req.query.format || 'csv');
    if (format === 'json') return ok(res, rows, { rows: rows.length, truncated, maxRows: cap });
    if (truncated) res.setHeader('X-Export-Truncated', 'true');
    if (format === 'pdf') {
      const { tablePdf } = await import('../pdf.js');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.dataset}.pdf"`);
      return tablePdf(`WST export — ${req.params.dataset}`, rows).pipe(res);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.dataset}.csv"`);
    res.send(toCsv(rows));
  })
);

/* ---------------------------------------------------------------- predictions */

analyticsRoutes.get('/predictions/reorder', requirePermission('stock:read', 'report:read'), asyncRoute(async (req: any, res: any) => {
  const outcome = await withModelFallback('/reorder', { organizationId: orgOf(req) }, () => reorderSuggestions(orgOf(req)));
  ok(res, outcome.data, {
    model: { key: 'inventory_reorder', version: 'min-max-v1', strategy: 'RULE_BASELINE' },
    fallbackUsed: outcome.fallbackUsed, source: outcome.source, reason: outcome.reason,
  });
}));

analyticsRoutes.get('/predictions/training-risk', requirePermission('training:read', 'training:write', 'report:read'), asyncRoute(async (req: any, res: any) => {
  const courseId = req.query.courseId ? String(req.query.courseId) : undefined;
  const outcome = await withModelFallback('/training-risk', { organizationId: orgOf(req), courseId }, () => trainingRisk(orgOf(req), courseId));
  ok(res, outcome.data, {
    model: { key: 'training_completion_risk', version: 'weighted-rules-v1', strategy: 'RULE_BASELINE' },
    fallbackUsed: outcome.fallbackUsed, source: outcome.source, reason: outcome.reason,
  });
}));

/** Persist a prediction snapshot so scores stay reproducible and auditable over time. */
analyticsRoutes.post('/predictions/:model/runs', requirePermission('report:read'), asyncRoute(async (req: any, res: any) => {
  const model = req.params.model;
  if (!['reorder', 'training-risk'].includes(model)) throw new DomainError('UNKNOWN_MODEL', 'Unknown model', 404);
  const rows = model === 'reorder' ? await reorderSuggestions(orgOf(req)) : await trainingRisk(orgOf(req));
  let stored = 0;
  for (const r of rows as any[]) {
    await query(
      `insert into prediction_runs(organization_id,model_key,model_version,strategy,subject_type,subject_id,score,band,features_json,explanation_json,fallback_used)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orgOf(req), r.model.key, r.model.version, r.model.strategy,
        model === 'reorder' ? 'part' : 'student',
        model === 'reorder' ? r.partId : r.studentId,
        model === 'reorder' ? r.suggestedReorderQty : r.riskScore,
        model === 'reorder' ? r.urgency : r.band,
        JSON.stringify(model === 'reorder' ? r.explanation.features : r.explanation.contributions),
        JSON.stringify(r.explanation),
        !process.env.AI_SERVICE_URL,
      ]
    );
    stored++;
  }
  ok(res, { model, stored });
}));

analyticsRoutes.get('/predictions/:model/runs', requirePermission('report:read'), asyncRoute(async (req: any, res: any) => {
  const key = req.params.model === 'reorder' ? 'inventory_reorder' : 'training_completion_risk';
  const r = await query('select * from prediction_runs where organization_id=$1 and model_key=$2 order by created_at desc limit 200', [orgOf(req), key]);
  ok(res, r.rows);
}));

/* ---------------------------------------------------------------- audit, notifications, attachments, config */

analyticsRoutes.get('/audit-events', requirePermission('audit:read'), asyncRoute(async (req: any, res: any) => {
  const { page, pageSize, offset } = pageParams(req);
  const params = [orgOf(req), String(req.query.entityType || ''), String(req.query.action || '')];
  const r = await query(
    `select ae.*, u.display_name actor_name from audit_events ae left join users u on u.id=ae.actor_id
      where ae.organization_id=$1 and ($2='' or ae.entity_type=$2) and ($3='' or ae.action=$3)
      order by ae.occurred_at desc, ae.id desc limit ${pageSize} offset ${offset}`,
    params
  );
  const total = await query(
    `select count(*) c from audit_events ae
      where ae.organization_id=$1 and ($2='' or ae.entity_type=$2) and ($3='' or ae.action=$3)`,
    params
  );
  ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

analyticsRoutes.get('/notifications', asyncRoute(async (req: any, res: any) => {
  const r = await query(
    `select * from notifications where organization_id=$1 and (recipient_id=$2 or recipient_id is null)
      order by created_at desc limit 100`,
    [orgOf(req), currentUser(req).id]
  );
  ok(res, r.rows);
}));

analyticsRoutes.post('/notifications/:id/read', asyncRoute(async (req: any, res: any) => {
  const r = await query(
    "update notifications set status='READ', read_at=now() where id=$1 and organization_id=$2 and recipient_id=$3 returning *",
    [req.params.id, orgOf(req), currentUser(req).id]
  );
  if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Notification not found', 404);
  ok(res, r.rows[0]);
}));

/**
 * Attachment metadata endpoint. Binary storage is delegated to whatever object store DevOps
 * provisions; the backend owns the metadata, scope and audit trail, and accepts a storage key.
 */
/**
 * Allow-list, not a block-list. The security requirements ask for "file type/size validation";
 * an unconstrained contentType accepted `application/x-msdownload` and an unconstrained
 * storageKey accepted `../../etc/passwd`, which is a path-traversal primitive handed to whatever
 * object store DevOps wires up behind this metadata.
 */
export const ALLOWED_CONTENT_TYPES: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
};
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SAFE_STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

/** Which permission may attach to (and read) each entity type — evidence follows the record. */
const ATTACHMENT_SCOPES: Record<string, { table: string; orgColumn: string; write: string[]; read: string[] }> = {
  job_card: { table: 'job_cards', orgColumn: 'organization_id', write: ['attachment:write', 'job:create', 'labor:write'], read: ['job:read'] },
  vehicle: { table: 'vehicles', orgColumn: 'organization_id', write: ['attachment:write', 'customer:write'], read: ['customer:read'] },
  assessment: { table: 'assessments', orgColumn: '', write: ['assessment:write'], read: ['training:read', 'training:write', 'assessment:write'] },
  goods_receipt: { table: 'goods_receipts', orgColumn: 'organization_id', write: ['purchase:receive'], read: ['purchase:read', 'purchase:write'] },
  invoice: { table: 'invoices', orgColumn: 'organization_id', write: ['invoice:write'], read: ['invoice:read', 'invoice:write'] },
};

const holdsAny = (req: any, perms: string[]) => perms.some((p) => currentUser(req).permissions.includes(p));

/** Proves the target row exists inside the caller's organisation before anything is written. */
async function assertEntityInScope(org: string, entityType: string, entityId: string) {
  if (entityType === 'assessment') {
    const r = await query(
      `select 1 from assessments a join training_sessions ts on ts.id = a.session_id
        where a.id=$1 and ts.organization_id=$2`,
      [entityId, org]
    );
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Assessment not found', 404);
    return;
  }
  const def = ATTACHMENT_SCOPES[entityType];
  const r = await query(`select 1 from ${def.table} where id=$1 and ${def.orgColumn}=$2`, [entityId, org]);
  if (!r.rowCount) throw new DomainError('NOT_FOUND', `${entityType} not found`, 404);
}

analyticsRoutes.post('/attachments', requirePermission('attachment:write', 'job:create', 'training:write', 'assessment:write', 'purchase:receive', 'invoice:write'), asyncRoute(async (req: any, res: any) => {
  const b = z
    .object({
      entityType: z.enum(['job_card', 'vehicle', 'assessment', 'goods_receipt', 'invoice']),
      entityId: uuid,
      fileName: z.string().min(1).max(255),
      contentType: z.string().min(3),
      sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
      storageKey: z.string().min(1).max(256),
    })
    .strict()
    .parse(req.body);

  const allowedExtensions = ALLOWED_CONTENT_TYPES[b.contentType.toLowerCase()];
  if (!allowedExtensions)
    throw new DomainError('UNSUPPORTED_FILE_TYPE', 'This content type is not accepted', 422, {
      allowed: Object.keys(ALLOWED_CONTENT_TYPES),
    });
  const extension = b.fileName.includes('.') ? b.fileName.split('.').pop()!.toLowerCase() : '';
  if (!allowedExtensions.includes(extension))
    throw new DomainError('FILE_TYPE_MISMATCH', 'The file extension does not match its declared content type', 422, {
      contentType: b.contentType, extension, expected: allowedExtensions,
    });
  if (/[\\/]|\.\./.test(b.fileName))
    throw new DomainError('INVALID_FILE_NAME', 'File names may not contain path separators', 422);
  if (!SAFE_STORAGE_KEY.test(b.storageKey) || b.storageKey.includes('..'))
    throw new DomainError('INVALID_STORAGE_KEY', 'Storage key must be a relative object key without traversal segments', 422);

  const scope = ATTACHMENT_SCOPES[b.entityType];
  if (!holdsAny(req, scope.write))
    throw new DomainError('FORBIDDEN', `Attaching to a ${b.entityType} requires one of: ${scope.write.join(', ')}`, 403);
  await assertEntityInScope(orgOf(req), b.entityType, b.entityId);

  const r = await query(
    'insert into attachments(organization_id,entity_type,entity_id,file_name,content_type,size_bytes,storage_key,uploaded_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',
    [orgOf(req), b.entityType, b.entityId, b.fileName, b.contentType.toLowerCase(), b.sizeBytes, b.storageKey, currentUser(req).id]
  );
  await audit(req, 'ATTACHMENT_ADDED', b.entityType, b.entityId, {
    attachmentId: r.rows[0].id, fileName: b.fileName, contentType: b.contentType, sizeBytes: b.sizeBytes,
  });
  ok(res, r.rows[0]);
}));

analyticsRoutes.get('/attachments', asyncRoute(async (req: any, res: any) => {
  const q = z
    .object({ entityType: z.enum(['job_card', 'vehicle', 'assessment', 'goods_receipt', 'invoice']), entityId: uuid })
    .parse({ entityType: req.query.entityType, entityId: req.query.entityId });
  const scope = ATTACHMENT_SCOPES[q.entityType];
  // This endpoint previously carried no permission at all: any authenticated user could enumerate
  // evidence photos and invoice documents for any entity id in their organisation.
  if (!holdsAny(req, [...scope.read, ...scope.write]))
    throw new DomainError('FORBIDDEN', `Requires one of: ${scope.read.join(', ')}`, 403);
  await assertEntityInScope(orgOf(req), q.entityType, q.entityId);
  const r = await query(
    'select * from attachments where organization_id=$1 and entity_type=$2 and entity_id=$3 order by created_at desc',
    [orgOf(req), q.entityType, q.entityId]
  );
  await audit(req, 'ATTACHMENTS_LISTED', q.entityType, q.entityId, { rows: r.rowCount });
  ok(res, r.rows);
}));

analyticsRoutes.get('/bays', requirePermission('job:read', 'training:read', 'training:write'), asyncRoute(async (req: any, res: any) => {
  ok(res, (await query('select * from bays where organization_id=$1 order by code', [orgOf(req)])).rows);
}));

analyticsRoutes.post('/bays', requirePermission('admin:users', 'job:create'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ code: z.string().min(1), name: z.string().min(1) }).parse(req.body);
  const r = await query('insert into bays(organization_id,code,name) values($1,$2,$3) returning *', [orgOf(req), b.code, b.name]);
  ok(res, r.rows[0]);
}));

analyticsRoutes.get('/settings', requirePermission('report:read', 'admin:users'), asyncRoute(async (req: any, res: any) => {
  ok(res, await settings(orgOf(req)));
}));

analyticsRoutes.patch('/settings', requirePermission('admin:users'), asyncRoute(async (req: any, res: any) => {
  const b = z
    .object({
      taxRate: z.number().min(0).max(1).optional(),
      poApprovalThreshold: z.number().nonnegative().optional(),
      poApprovalsRequiredAbove: z.number().int().min(1).max(5).optional(),
      poApprovalsRequiredBelow: z.number().int().min(1).max(5).optional(),
      reminderIntervalDays: z.number().int().positive().optional(),
      reminderIntervalKm: z.number().int().positive().optional(),
      certificateMinAttendanceRatio: z.number().min(0).max(1).optional(),
    })
    .parse(req.body);
  await settings(orgOf(req));
  const r = await query(
    `update org_settings set
        tax_rate=coalesce($1,tax_rate),
        po_approval_threshold=coalesce($2,po_approval_threshold),
        po_approvals_required_above=coalesce($3,po_approvals_required_above),
        po_approvals_required_below=coalesce($4,po_approvals_required_below),
        reminder_interval_days=coalesce($5,reminder_interval_days),
        reminder_interval_km=coalesce($6,reminder_interval_km),
        certificate_min_attendance_ratio=coalesce($7,certificate_min_attendance_ratio)
      where organization_id=$8 returning *`,
    [b.taxRate, b.poApprovalThreshold, b.poApprovalsRequiredAbove, b.poApprovalsRequiredBelow, b.reminderIntervalDays, b.reminderIntervalKm, b.certificateMinAttendanceRatio, orgOf(req)]
  );
  await audit(req, 'SETTINGS_UPDATED', 'org_settings', null, b);
  ok(res, r.rows[0]);
}));

/* ================================================================ WST-FR-13: reconciliation proof */

/**
 * Acceptance evidence for WST-FR-13: dashboard and export totals must reconcile to the source
 * transactions for the same filters. This endpoint recomputes both sides and reports the difference.
 */
analyticsRoutes.get(
  '/dashboards/reconciliation',
  requirePermission('report:read'),
  asyncRoute(async (req: any, res: any) => {
    const org = orgOf(req);
    const [jobs, invoiceHeaders, invoiceLines, stock, attendance] = await Promise.all([
      query('select count(*)::int total, count(*) filter (where status=\'DELIVERED\')::int delivered from job_cards where organization_id=$1', [org]),
      query("select coalesce(sum(subtotal_parts+subtotal_labor+sublet_price),0) gross, coalesce(sum(total_amount),0) total from invoices where organization_id=$1 and status<>'CANCELLED'", [org]),
      query(
        `select coalesce(sum(il.line_total),0) lines_total from invoice_lines il
           join invoices i on i.id=il.invoice_id where i.organization_id=$1 and i.status<>'CANCELLED'`,
        [org]
      ),
      query(
        `select coalesce(sum(sb.on_hand),0) balance_total,
                coalesce((select sum(sm.quantity) from stock_movements sm where sm.organization_id=$1),0) ledger_total
           from stock_balances sb join parts p on p.id=sb.part_id where p.organization_id=$1`,
        [org]
      ),
      query(
        `select count(*)::int records, count(*) filter (where a.status in ('PRESENT','LATE'))::int attended
           from attendances a join training_sessions ts on ts.id=a.session_id where ts.organization_id=$1`,
        [org]
      ),
    ]);

    const round = (n: any) => Math.round(Number(n) * 100) / 100;
    const checks = [
      {
        name: 'invoice lines reconcile to invoice subtotals',
        source: round(invoiceLines.rows[0].lines_total),
        dashboard: round(invoiceHeaders.rows[0].gross),
        difference: round(Number(invoiceLines.rows[0].lines_total) - Number(invoiceHeaders.rows[0].gross)),
      },
      {
        name: 'stock balances reconcile to the movement ledger',
        source: round(stock.rows[0].ledger_total),
        dashboard: round(stock.rows[0].balance_total),
        difference: round(Number(stock.rows[0].balance_total) - Number(stock.rows[0].ledger_total)),
      },
    ];
    ok(res, {
      reconciled: checks.every((c) => Math.abs(c.difference) < 0.01),
      checks,
      counts: { jobs: jobs.rows[0], attendance: attendance.rows[0] },
    });
  })
);

/* ================================================================ WST-FR-14: human override */

/**
 * Records the user's decision on an advisory suggestion (accept, override with a different value, or
 * reject) together with the evaluation outcome. Nothing is ordered or graded automatically.
 */
analyticsRoutes.post(
  '/predictions/runs/:id/decision',
  requirePermission('report:read', 'stock:write', 'training:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        decision: z.enum(['ACCEPTED', 'OVERRIDDEN', 'REJECTED']),
        overrideValue: z.number().optional(),
        note: z.string().optional(),
        outcome: z.record(z.any()).optional(),
      })
      .parse(req.body);
    if (b.decision === 'OVERRIDDEN' && b.overrideValue === undefined)
      throw new DomainError('VALIDATION_ERROR', 'overrideValue is required when overriding a suggestion', 400);
    const run = await query('select * from prediction_runs where id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    if (!run.rowCount) throw new DomainError('NOT_FOUND', 'Prediction run not found', 404);
    const r = await query(
      `update prediction_runs set decision=$1, decided_by=$2, decided_at=now(), override_value=$3,
              decision_note=$4, outcome_json=$5 where id=$6 returning *`,
      [b.decision, currentUser(req).id, b.overrideValue ?? null, b.note ?? null, JSON.stringify(b.outcome ?? {}), req.params.id]
    );
    await audit(req, 'PREDICTION_DECIDED', 'prediction_run', req.params.id, {
      decision: b.decision, overrideValue: b.overrideValue, modelKey: run.rows[0].model_key, modelVersion: run.rows[0].model_version,
    });
    ok(res, r.rows[0]);
  })
);

/** Acceptance/override statistics — the AI release gate asks for evaluation outcomes. */
analyticsRoutes.get(
  '/predictions/evaluation',
  requirePermission('report:read'),
  asyncRoute(async (req: any, res: any) => {
    const r = await query(
      `select model_key, model_version, strategy,
              count(*)::int runs,
              count(*) filter (where decision is not null)::int decided,
              count(*) filter (where decision='ACCEPTED')::int accepted,
              count(*) filter (where decision='OVERRIDDEN')::int overridden,
              count(*) filter (where decision='REJECTED')::int rejected,
              count(*) filter (where fallback_used)::int fallback_runs
         from prediction_runs where organization_id=$1
        group by model_key, model_version, strategy`,
      [orgOf(req)]
    );
    ok(res, r.rows.map((x: any) => ({
      ...x,
      acceptanceRate: x.decided ? Math.round((x.accepted / x.decided) * 100) / 100 : null,
      overrideRate: x.decided ? Math.round((x.overridden / x.decided) * 100) / 100 : null,
    })));
  })
);

/* ================================================================ WST-FR-02: bilingual contract */

/** The error-code catalog the frontend renders in English or Arabic. Public on purpose. */
analyticsRoutes.get(
  '/i18n/error-codes',
  asyncRoute(async (_req: any, res: any) => {
    const { ERROR_CATALOG } = await import('../i18n.js');
    ok(res, ERROR_CATALOG, { locales: ['en', 'ar'], note: 'Identifiers and amounts are never translated and stay LTR.' });
  })
);
