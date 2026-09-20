import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/index.js';
import { auth, currentUser, orgOf, requirePermission } from '../auth.js';
import { asyncRoute, created, DomainError, insufficientStock, notFound, ok, pageParams, uuid } from '../http.js';
import { audit, inScope, nextDocNo, notify, scoped } from '../core.js';
import {
  computeInvoice, moveStock, reserveBay, releaseBay, findJobConflicts, conflictError,
  resolvePartSellPrice, resolveLaborRate,
} from '../services.js';

export const jobRoutes = Router();
jobRoutes.use(auth);

export const TRANSITIONS: Record<string, string[]> = {
  RECEIVED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['QUALITY_CHECK'],
  QUALITY_CHECK: ['READY', 'IN_PROGRESS'],
  READY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

jobRoutes.post(
  '/jobs',
  requirePermission('job:create'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        customerId: uuid,
        vehicleId: uuid,
        complaint: z.string().min(3),
        serviceType: z.string().min(1),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
        receivedMileage: z.number().int().nonnegative(),
        expectedAt: z.string().datetime().optional(),
        scheduledStartAt: z.string().datetime().optional(),
        scheduledEndAt: z.string().datetime().optional(),
        estimateAmount: z.number().nonnegative().optional(),
        bayId: uuid.optional(),
        technicianId: uuid.optional(),
      })
      .parse(req.body);
    if (b.scheduledStartAt && b.scheduledEndAt && new Date(b.scheduledEndAt) <= new Date(b.scheduledStartAt))
      throw new DomainError('INVALID_WINDOW', 'scheduledEndAt must be after scheduledStartAt');

    const job = await tx(async (c) => {
      const vehicle = await c.query('select * from vehicles where id=$1 and customer_id=$2 and organization_id=$3', [
        b.vehicleId, b.customerId, orgOf(req),
      ]);
      if (!vehicle.rowCount) throw notFound('Vehicle for this customer');
      const jobNo = await nextDocNo(c, orgOf(req), 'job_cards', 'job_no', 'WST');
      const j = await c.query(
        `insert into job_cards(organization_id,job_no,customer_id,vehicle_id,complaint,service_type,priority,
                               received_mileage,expected_at,scheduled_start_at,scheduled_end_at,estimate_amount,
                               bay_id,assigned_technician_id,created_by)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
        [orgOf(req), jobNo, b.customerId, b.vehicleId, b.complaint, b.serviceType, b.priority || 'NORMAL',
         b.receivedMileage, b.expectedAt ?? null, b.scheduledStartAt ?? null, b.scheduledEndAt ?? null,
         b.estimateAmount ?? 0, b.bayId ?? null, b.technicianId ?? null, currentUser(req).id]
      );
      await c.query('insert into job_stage_history(job_card_id,to_status,changed_by,reason) values($1,$2,$3,$4)', [
        j.rows[0].id, 'RECEIVED', currentUser(req).id, 'Vehicle received',
      ]);
      await c.query('update vehicles set mileage = greatest(mileage, $1) where id=$2', [b.receivedMileage, b.vehicleId]);
      // A job must not be opened into a bay that a published training session already holds.
      // The check runs in both directions now; the exclusion constraint inside reserveBay is the
      // authority under concurrency, this call only produces the explanatory payload.
      const clashes = await findJobConflicts(c, orgOf(req), j.rows[0]);
      if (clashes.length) throw conflictError(clashes);
      await reserveBay(c, {
        organizationId: orgOf(req), bayId: j.rows[0].bay_id, sourceType: 'JOB', sourceId: j.rows[0].id,
        startsAt: j.rows[0].scheduled_start_at, endsAt: j.rows[0].scheduled_end_at, userId: currentUser(req).id,
      });
      await audit(req, 'JOB_CREATED', 'job_card', j.rows[0].id, { jobNo }, c);
      return j.rows[0];
    });
    created(res, job);
  })
);

jobRoutes.get(
  '/jobs',
  requirePermission('job:read'),
  asyncRoute(async (req: any, res: any) => {
    const { page, pageSize, offset } = pageParams(req);
    const params = [orgOf(req), String(req.query.status || ''), String(req.query.q || '')];
    const where = `j.organization_id=$1 and ($2='' or j.status=$2) and ($3='' or j.job_no ilike '%'||$3||'%' or v.plate_no ilike '%'||$3||'%')`;
    const rows = await query(
      `select j.*, v.plate_no, v.make, v.model, c.name customer_name, u.display_name technician, b.code bay_code
         from job_cards j
         join vehicles v on v.id=j.vehicle_id
         join customers c on c.id=j.customer_id
         left join users u on u.id=j.assigned_technician_id
         left join bays b on b.id=j.bay_id
        where ${where} order by j.created_at desc, j.id desc limit ${pageSize} offset ${offset}`,
      params
    );
    const total = await query(`select count(*) c from job_cards j join vehicles v on v.id=j.vehicle_id where ${where}`, params);
    ok(res, rows.rows, { page, pageSize, total: Number(total.rows[0].c) });
  })
);

jobRoutes.get(
  '/jobs/:id',
  requirePermission('job:read'),
  asyncRoute(async (req: any, res: any) => {
    const job = await inScope.job(orgOf(req), req.params.id);
    const [history, labor, parts, sublet, approvals, invoice] = await Promise.all([
      query('select h.*, u.display_name changed_by_name from job_stage_history h left join users u on u.id=h.changed_by where h.job_card_id=$1 order by h.changed_at', [job.id]),
      query('select l.*, u.display_name technician from labor_entries l left join users u on u.id=l.technician_id where l.job_card_id=$1', [job.id]),
      query('select jp.*, p.sku, p.name from job_parts jp join parts p on p.id=jp.part_id where jp.job_card_id=$1', [job.id]),
      query('select * from job_sublets where job_card_id=$1', [job.id]),
      query('select * from job_approvals where job_card_id=$1 order by approved_at', [job.id]),
      query("select * from invoices where job_card_id=$1 and status<>'CANCELLED'", [job.id]),
    ]);
    ok(res, {
      ...job, timeline: history.rows, labor: labor.rows, parts: parts.rows,
      sublet: sublet.rows, approvals: approvals.rows, invoice: invoice.rows[0] ?? null,
      allowedTransitions: TRANSITIONS[job.status] ?? [],
    });
  })
);

/** Rule 1: no billable work may start before a recorded customer approval. */
/**
 * Step 2 of the primary workflow: "Workshop manager assigns bay and technician". Without this the
 * bay and technician could only ever be set at reception. Assignment re-books the shared bay
 * calendar, so moving a job out of a bay frees it for training and vice versa.
 */
jobRoutes.patch(
  '/jobs/:id',
  requirePermission('job:transition', 'job:create'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        bayId: uuid.nullable().optional(),
        technicianId: uuid.nullable().optional(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
        expectedAt: z.string().datetime().nullable().optional(),
        scheduledStartAt: z.string().datetime().nullable().optional(),
        scheduledEndAt: z.string().datetime().nullable().optional(),
        estimateAmount: z.number().nonnegative().optional(),
        complaint: z.string().min(3).optional(),
        serviceType: z.string().min(1).optional(),
      })
      .parse(req.body);
    if (!Object.keys(b).length) throw new DomainError('NOTHING_TO_UPDATE', 'Provide at least one field to update', 400);

    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (['DELIVERED', 'CANCELLED'].includes(job.status))
        throw new DomainError('JOB_CLOSED', 'A delivered or cancelled job card cannot be reassigned');

      if (b.bayId) {
        const bay = await c.query('select 1 from bays where id=$1 and organization_id=$2 and active', [b.bayId, orgOf(req)]);
        if (!bay.rowCount) throw notFound('Bay');
      }
      if (b.technicianId) {
        const t = await c.query('select 1 from users where id=$1 and organization_id=$2 and is_active', [b.technicianId, orgOf(req)]);
        if (!t.rowCount) throw notFound('Technician');
      }

      const next = {
        bay_id: b.bayId === undefined ? job.bay_id : b.bayId,
        assigned_technician_id: b.technicianId === undefined ? job.assigned_technician_id : b.technicianId,
        scheduled_start_at: b.scheduledStartAt === undefined ? job.scheduled_start_at : b.scheduledStartAt,
        scheduled_end_at: b.scheduledEndAt === undefined ? job.scheduled_end_at : b.scheduledEndAt,
      };
      if (next.scheduled_start_at && next.scheduled_end_at && new Date(next.scheduled_end_at) <= new Date(next.scheduled_start_at))
        throw new DomainError('INVALID_WINDOW', 'scheduledEndAt must be after scheduledStartAt');

      const clashes = await findJobConflicts(c, orgOf(req), { id: job.id, ...next });
      if (clashes.length) throw conflictError(clashes);

      const upd = await c.query(
        `update job_cards set
            bay_id=$1, assigned_technician_id=$2, scheduled_start_at=$3, scheduled_end_at=$4,
            priority=coalesce($5,priority),
            expected_at = case when $6::boolean then $7::timestamptz else expected_at end,
            estimate_amount=coalesce($8,estimate_amount),
            complaint=coalesce($9,complaint),
            service_type=coalesce($10,service_type),
            updated_at=now()
          where id=$11 returning *`,
        [
          next.bay_id, next.assigned_technician_id, next.scheduled_start_at, next.scheduled_end_at,
          b.priority ?? null, b.expectedAt !== undefined, b.expectedAt ?? null,
          b.estimateAmount ?? null, b.complaint ?? null, b.serviceType ?? null, job.id,
        ]
      );
      await reserveBay(c, {
        organizationId: orgOf(req), bayId: upd.rows[0].bay_id, sourceType: 'JOB', sourceId: job.id,
        startsAt: upd.rows[0].scheduled_start_at, endsAt: upd.rows[0].scheduled_end_at, userId: currentUser(req).id,
      });
      await audit(req, 'JOB_UPDATED', 'job_card', job.id, {
        changed: b,
        previous: {
          bayId: job.bay_id, technicianId: job.assigned_technician_id,
          scheduledStartAt: job.scheduled_start_at, scheduledEndAt: job.scheduled_end_at,
        },
      }, c);
      if (b.technicianId && b.technicianId !== job.assigned_technician_id)
        await notify(orgOf(req), b.technicianId, 'JOB_ASSIGNED', { jobId: job.id, jobNo: job.job_no }, c);
      return upd.rows[0];
    });
    ok(res, out);
  })
);

jobRoutes.post(
  '/jobs/:id/customer-approvals',
  requirePermission('job:approve'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        decision: z.enum(['APPROVED', 'REJECTED']),
        channel: z.enum(['PHONE', 'IN_PERSON', 'SMS', 'EMAIL', 'PORTAL']),
        referenceNo: z.string().min(1),
        approvedAmount: z.number().nonnegative().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (['DELIVERED', 'CANCELLED'].includes(job.status))
        throw new DomainError('JOB_CLOSED', 'Closed job cards cannot be re-approved');
      await c.query('insert into job_approvals(job_card_id,approval_type,approved_by,decision,channel,reference_no,approved_amount,note) values($1,$2,$3,$4,$5,$6,$7,$8)', [
        job.id, 'CUSTOMER', currentUser(req).id, b.decision, b.channel, b.referenceNo, b.approvedAmount ?? null, b.note ?? null,
      ]);
      const upd = await c.query('update job_cards set customer_approval_status=$1, updated_at=now() where id=$2 returning *', [b.decision, job.id]);
      await audit(req, `JOB_CUSTOMER_${b.decision}`, 'job_card', job.id, { channel: b.channel, referenceNo: b.referenceNo, approvedAmount: b.approvedAmount }, c);
      return upd.rows[0];
    });
    ok(res, out);
  })
);

jobRoutes.post(
  '/jobs/:id/transitions',
  requirePermission('job:transition'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({ toStatus: z.enum(['IN_PROGRESS', 'QUALITY_CHECK', 'READY', 'DELIVERED', 'CANCELLED']), reason: z.string().optional() })
      .parse(req.body);
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      const allowed = TRANSITIONS[job.status] ?? [];
      if (!allowed.includes(b.toStatus))
        throw new DomainError('JOB_INVALID_TRANSITION', `Cannot move from ${job.status} to ${b.toStatus}`, 422, { from: job.status, allowed });

      if (b.toStatus === 'IN_PROGRESS' && job.customer_approval_status !== 'APPROVED')
        throw new DomainError('CUSTOMER_APPROVAL_REQUIRED', 'Billable work cannot start before customer approval');
      if (b.toStatus === 'QUALITY_CHECK') {
        const work = await c.query('select count(*) c from labor_entries where job_card_id=$1', [job.id]);
        if (!Number(work.rows[0].c)) throw new DomainError('NO_WORK_RECORDED', 'Record labor before quality check');
        const openItems = await c.query(
          "select count(*) c from work_items where job_card_id=$1 and required and status not in ('COMPLETED','NOT_APPLICABLE')",
          [job.id]
        );
        if (Number(openItems.rows[0].c))
          throw new DomainError('WORK_ITEMS_INCOMPLETE', 'All required checklist items must be completed first', 422, {
            outstanding: Number(openItems.rows[0].c),
          });
      }
      if (job.status === 'QUALITY_CHECK' && b.toStatus === 'IN_PROGRESS' && !b.reason)
        throw new DomainError('REASON_REQUIRED', 'Rework from quality check requires a reason');
      if (b.toStatus === 'DELIVERED') {
        const inv = await c.query("select 1 from invoices where job_card_id=$1 and status in ('ISSUED','PAID')", [job.id]);
        if (!inv.rowCount) throw new DomainError('INVOICE_REQUIRED', 'An issued invoice is required before delivery');
      }

      const upd = await c.query(
        `update job_cards set status=$1, updated_at=now(), closed_at = case when $1 in ('DELIVERED','CANCELLED') then now() else closed_at end
          where id=$2 returning *`,
        [b.toStatus, job.id]
      );
      await c.query('insert into job_stage_history(job_card_id,from_status,to_status,changed_by,reason) values($1,$2,$3,$4,$5)', [
        job.id, job.status, b.toStatus, currentUser(req).id, b.reason ?? null,
      ]);
      // A delivered or cancelled job no longer occupies its bay; the shared calendar must be freed
      // or a cancelled job would block training for the rest of its window.
      if (['DELIVERED', 'CANCELLED'].includes(b.toStatus)) await releaseBay(c, 'JOB', job.id);
      await audit(req, 'JOB_TRANSITION', 'job_card', job.id, { from: job.status, to: b.toStatus, reason: b.reason }, c);
      if (b.toStatus === 'READY') await notify(orgOf(req), job.created_by, 'JOB_READY', { jobId: job.id, jobNo: job.job_no }, c);
      return upd.rows[0];
    });
    ok(res, out);
  })
);

jobRoutes.post(
  '/jobs/:id/labor',
  requirePermission('labor:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        minutes: z.number().int().positive().max(24 * 60),
        billable: z.boolean().optional(),
        technicianId: uuid.optional(),
        note: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (['DELIVERED', 'CANCELLED'].includes(job.status))
        throw new DomainError('JOB_CLOSED', 'Cannot add labor to a closed job card');
      const billable = b.billable ?? true;
      if (billable && job.customer_approval_status !== 'APPROVED')
        throw new DomainError('CUSTOMER_APPROVAL_REQUIRED', 'Billable labor requires customer approval');
      const technicianId = b.technicianId ?? currentUser(req).id;
      if (b.technicianId) {
        const t = await c.query('select 1 from users where id=$1 and organization_id=$2', [b.technicianId, orgOf(req)]);
        if (!t.rowCount) throw notFound('Technician');
      }
      // The hourly rate is never taken from the request. It is resolved from the service-type rate
      // table, the technician's own rate, then the organisation default, and the source is stored
      // alongside it so the invoice can prove where the number came from.
      const rate = await resolveLaborRate(c, orgOf(req), job.service_type, technicianId);
      const r = await c.query(
        'insert into labor_entries(job_card_id,technician_id,minutes,rate_snapshot,rate_source,billable,note) values($1,$2,$3,$4,$5,$6,$7) returning *',
        [job.id, technicianId, b.minutes, rate.rate, rate.source, billable, b.note ?? null]
      );
      await audit(req, 'LABOR_RECORDED', 'labor_entry', r.rows[0].id, {
        jobId: job.id, minutes: b.minutes, rate: rate.rate, rateSource: rate.source,
      }, c);
      return r.rows[0];
    });
    ok(res, out);
  })
);

jobRoutes.post(
  '/jobs/:id/sublet',
  requirePermission('job:transition', 'invoice:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({ vendorId: uuid.optional(), description: z.string().min(2), cost: z.number().nonnegative(), price: z.number().nonnegative(), billable: z.boolean().optional() })
      .parse(req.body);
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (job.customer_approval_status !== 'APPROVED')
        throw new DomainError('CUSTOMER_APPROVAL_REQUIRED', 'Sublet work requires customer approval');
      const r = await c.query(
        'insert into job_sublets(job_card_id,vendor_id,description,cost,price,billable,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *',
        [job.id, b.vendorId ?? null, b.description, b.cost, b.price, b.billable ?? true, currentUser(req).id]
      );
      await audit(req, 'SUBLET_ADDED', 'job_sublet', r.rows[0].id, { jobId: job.id, cost: b.cost }, c);
      return r.rows[0];
    });
    ok(res, out);
  })
);

/** Rule 3: issuing parts locks the balance row, so concurrent issues can never oversell stock. */
jobRoutes.post(
  '/jobs/:id/parts/issue',
  // Blueprint phase 2: "Storekeeper / Tech". `part:issue` lets a technician issue to a job card only;
  // reservations, releases and reversals keep their own (stock-staff) permissions.
  requirePermission('stock:issue', 'part:issue'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({ partId: uuid, storeId: uuid, quantity: z.number().positive() })
      .strict()
      .parse(req.body);
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (['DELIVERED', 'CANCELLED'].includes(job.status)) throw new DomainError('JOB_CLOSED', 'Job card is closed');
      if (job.customer_approval_status !== 'APPROVED')
        throw new DomainError('CUSTOMER_APPROVAL_REQUIRED', 'Parts cannot be issued before customer approval');
      await inScope.store(orgOf(req), b.storeId, c);
      await inScope.part(orgOf(req), b.partId, c);

      // Selling price comes from the parts catalogue, never from the caller: a typed price is
      // exactly what the brief forbids when it says the invoice is computed rather than entered.
      const price = await resolvePartSellPrice(c, b.partId);
      const jp = await c.query(
        `insert into job_parts(job_card_id,part_id,store_id,quantity,unit_cost_snapshot,unit_price_snapshot,price_source,issued_by)
         values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [job.id, b.partId, b.storeId, b.quantity, price.unitCost, price.unitPrice, price.source, currentUser(req).id]
      );
      // consume any active reservation for this job/part first, so reserved stock becomes issuable
      const reservation = await c.query(
        "select * from stock_reservations where job_card_id=$1 and part_id=$2 and store_id=$3 and status='ACTIVE' order by created_at for update",
        [job.id, b.partId, b.storeId]
      );
      let toConsume = b.quantity;
      for (const r of reservation.rows) {
        if (toConsume <= 0) break;
        const take = Math.min(Number(r.quantity), toConsume);
        await c.query('update stock_balances set reserved = greatest(reserved - $1, 0), version = version + 1 where store_id=$2 and part_id=$3', [take, b.storeId, b.partId]);
        await c.query("update stock_reservations set status='CONSUMED', released_at=now() where id=$1", [r.id]);
        toConsume -= take;
      }
      const moved = await moveStock(c, {
        organizationId: orgOf(req), storeId: b.storeId, partId: b.partId, delta: -b.quantity,
        type: 'ISSUE', referenceType: 'JOB_PART', referenceId: jp.rows[0].id, userId: currentUser(req).id,
      });
      await audit(req, 'PART_ISSUED', 'job_part', jp.rows[0].id, {
        jobId: job.id, partId: b.partId, quantity: b.quantity, unitPrice: price.unitPrice,
        priceSource: price.source, balanceAfter: moved.balanceAfter,
      }, c);
      return { ...jp.rows[0], balanceAfter: moved.balanceAfter };
    });
    ok(res, out);
  })
);

/** Rule 4: reversal returns the quantity, requires authorisation plus a reason, and is audited. */
jobRoutes.post(
  '/job-parts/:id/reversals',
  requirePermission('stock:reverse'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ quantity: z.number().positive(), reason: z.string().min(5) }).parse(req.body);
    const out = await tx(async (c) => {
      const jp = await inScope.jobPart(orgOf(req), req.params.id, c, true);
      const remaining = Number(jp.quantity) - Number(jp.reversed_qty);
      if (b.quantity > remaining)
        throw new DomainError('REVERSAL_EXCEEDS_ISSUED', 'Cannot reverse more than the outstanding issued quantity', 422, { remaining });
      const invoiced = await c.query("select 1 from invoices where job_card_id=$1 and status in ('ISSUED','PAID')", [jp.job_card_id]);
      if (invoiced.rowCount) throw new DomainError('ALREADY_INVOICED', 'Credit the invoice before reversing issued parts');

      await moveStock(c, {
        organizationId: orgOf(req), storeId: jp.store_id, partId: jp.part_id, delta: b.quantity,
        type: 'REVERSAL', referenceType: 'JOB_PART', referenceId: jp.id, reason: b.reason,
        userId: currentUser(req).id, allowCreate: true,
      });
      const rev = await c.query('insert into part_reversals(job_part_id,quantity,reason,authorized_by) values($1,$2,$3,$4) returning *', [
        jp.id, b.quantity, b.reason, currentUser(req).id,
      ]);
      const upd = await c.query(
        `update job_parts set reversed_qty = reversed_qty + $1,
                status = case when reversed_qty + $1 >= quantity then 'REVERSED' else 'PARTIALLY_REVERSED' end
          where id=$2 returning *`,
        [b.quantity, jp.id]
      );
      await audit(req, 'PART_REVERSED', 'job_part', jp.id, { quantity: b.quantity, reason: b.reason, authorizedBy: currentUser(req).id }, c);
      return { reversal: rev.rows[0], jobPart: upd.rows[0] };
    });
    ok(res, out);
  })
);

/** Rule 2: the invoice is computed from source rows; the client can only supply a discount. */
jobRoutes.get(
  '/jobs/:id/invoice-preview',
  requirePermission('invoice:read', 'invoice:write'),
  asyncRoute(async (req: any, res: any) => {
    const job = await inScope.job(orgOf(req), req.params.id);
    ok(res, await computeInvoice({ query: (t: string, p: any[]) => query(t, p) }, orgOf(req), job.id, Number(req.query.discount || 0)));
  })
);

jobRoutes.post(
  '/jobs/:id/invoices',
  requirePermission('invoice:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ discount: z.number().nonnegative().optional() }).parse(req.body ?? {});
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (!['READY', 'DELIVERED'].includes(job.status))
        throw new DomainError('JOB_NOT_READY', 'Job must reach READY before invoicing', 422, { status: job.status });
      const existing = await c.query("select * from invoices where job_card_id=$1 and status<>'CANCELLED'", [job.id]);
      if (existing.rowCount) throw new DomainError('INVOICE_EXISTS', 'This job card already has an invoice', 409, { invoiceId: existing.rows[0].id });

      const totals = await computeInvoice(c, orgOf(req), job.id, b.discount ?? 0);
      const invoiceNo = await nextDocNo(c, orgOf(req), 'invoices', 'invoice_no', 'INV');
      const inv = await c.query(
        `insert into invoices(organization_id,invoice_no,job_card_id,status,subtotal_parts,subtotal_labor,sublet_price,
                              discount_amount,tax_rate,tax_amount,total_amount,issued_at,created_by)
         values($1,$2,$3,'ISSUED',$4,$5,$6,$7,$8,$9,$10,now(),$11) returning *`,
        [orgOf(req), invoiceNo, job.id, totals.subtotalParts, totals.subtotalLabor, totals.subletPrice,
         totals.discount, totals.taxRate, totals.taxAmount, totals.total, currentUser(req).id]
      );
      for (const line of [...totals.partLines, ...totals.laborLines, ...totals.subletLines]) {
        await c.query(
          'insert into invoice_lines(invoice_id,source_type,source_id,description,quantity,unit_price,line_total) values($1,$2,$3,$4,$5,$6,$7)',
          [inv.rows[0].id, line.sourceType, line.sourceId, line.description, line.quantity, line.unitPrice, line.lineTotal]
        );
      }
      await audit(req, 'INVOICE_ISSUED', 'invoice', inv.rows[0].id, { jobId: job.id, total: totals.total, computedFrom: { parts: totals.partLines.length, labor: totals.laborLines.length, sublet: totals.subletLines.length } }, c);
      return { ...inv.rows[0], lines: [...totals.partLines, ...totals.laborLines, ...totals.subletLines] };
    });
    ok(res, out);
  })
);

jobRoutes.get(
  '/invoices/:id',
  requirePermission('invoice:read', 'invoice:write'),
  asyncRoute(async (req: any, res: any) => {
    const inv = await inScope.invoice(orgOf(req), req.params.id);
    const lines = await query('select * from invoice_lines where invoice_id=$1', [inv.id]);
    const payments = await query('select * from payment_references where invoice_id=$1', [inv.id]);
    const paid = payments.rows.reduce((s: number, p: any) => s + Number(p.amount), 0);
    ok(res, { ...inv, lines: lines.rows, payments: payments.rows, paidAmount: paid, outstanding: Number(inv.total_amount) - paid });
  })
);

jobRoutes.post(
  '/invoices/:id/payment-references',
  requirePermission('payment:write', 'invoice:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ referenceNo: z.string().min(1), amount: z.number().positive(), method: z.enum(['CASH', 'CARD', 'TRANSFER', 'WALLET']), note: z.string().optional() }).parse(req.body);
    const out = await tx(async (c) => {
      const inv = await inScope.invoice(orgOf(req), req.params.id, c);
      const paidRow = await c.query('select coalesce(sum(amount),0) s from payment_references where invoice_id=$1', [inv.id]);
      const paid = Number(paidRow.rows[0].s) + b.amount;
      if (paid > Number(inv.total_amount) + 0.001)
        throw new DomainError('OVERPAYMENT', 'Payment exceeds the invoice total', 422, { total: Number(inv.total_amount), alreadyPaid: Number(paidRow.rows[0].s) });
      const r = await c.query('insert into payment_references(invoice_id,reference_no,amount,method,note) values($1,$2,$3,$4,$5) returning *', [
        inv.id, b.referenceNo, b.amount, b.method, b.note ?? null,
      ]);
      if (paid >= Number(inv.total_amount) - 0.001) await c.query("update invoices set status='PAID' where id=$1", [inv.id]);
      await audit(req, 'PAYMENT_RECORDED', 'invoice', inv.id, { amount: b.amount, method: b.method, referenceNo: b.referenceNo }, c);
      return r.rows[0];
    });
    ok(res, out);
  })
);

/* ================================================================ WST-FR-04: work checklist */

jobRoutes.get(
  '/jobs/:id/work-items',
  requirePermission('job:read'),
  asyncRoute(async (req: any, res: any) => {
    const job = await inScope.job(orgOf(req), req.params.id);
    const r = await query('select * from work_items where job_card_id=$1 order by sequence', [job.id]);
    ok(res, r.rows);
  })
);

jobRoutes.post(
  '/jobs/:id/work-items',
  requirePermission('job:create', 'job:transition'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        items: z
          .array(z.object({ description: z.string().min(2), descriptionAr: z.string().optional(), required: z.boolean().optional() }))
          .min(1),
      })
      .parse(req.body);
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (['DELIVERED', 'CANCELLED'].includes(job.status)) throw new DomainError('JOB_CLOSED', 'Job card is closed');
      const start = Number((await c.query('select coalesce(max(sequence),0) s from work_items where job_card_id=$1', [job.id])).rows[0].s);
      const created: any[] = [];
      for (const [i, item] of b.items.entries()) {
        const r = await c.query(
          'insert into work_items(job_card_id,sequence,description,description_ar,required) values($1,$2,$3,$4,$5) returning *',
          [job.id, start + i + 1, item.description, item.descriptionAr ?? null, item.required ?? true]
        );
        created.push(r.rows[0]);
      }
      await audit(req, 'WORK_ITEMS_ADDED', 'job_card', job.id, { count: created.length }, c);
      return created;
    });
    ok(res, out);
  })
);

jobRoutes.patch(
  '/work-items/:id',
  requirePermission('job:transition', 'labor:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'NOT_APPLICABLE']), note: z.string().optional() }).parse(req.body);
    const out = await tx(async (c) => {
      const item = await scoped(
        orgOf(req),
        `select wi.* from work_items wi join job_cards j on j.id = wi.job_card_id where wi.id=$1 and j.organization_id=$2 for update of wi`,
        [req.params.id],
        'Work item',
        c
      );
      const r = await c.query(
        `update work_items set status=$1, note=coalesce($2,note),
                completed_by = case when $1 in ('COMPLETED','NOT_APPLICABLE') then $3::uuid else null end,
                completed_at = case when $1 in ('COMPLETED','NOT_APPLICABLE') then now() else null end
          where id=$4 returning *`,
        [b.status, b.note ?? null, currentUser(req).id, item.id]
      );
      await audit(req, 'WORK_ITEM_UPDATED', 'work_item', item.id, { status: b.status }, c);
      return r.rows[0];
    });
    ok(res, out);
  })
);

/* ================================================================ WST-FR-06: reservations */

/** Reserving holds available stock for a job without moving it out of the store. */
jobRoutes.post(
  '/jobs/:id/parts/reserve',
  requirePermission('stock:issue'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ partId: uuid, storeId: uuid, quantity: z.number().positive() }).parse(req.body);
    const out = await tx(async (c) => {
      const job = await inScope.job(orgOf(req), req.params.id, c, true);
      if (['DELIVERED', 'CANCELLED'].includes(job.status)) throw new DomainError('JOB_CLOSED', 'Job card is closed');
      await inScope.store(orgOf(req), b.storeId, c);
      await inScope.part(orgOf(req), b.partId, c);
      const bal = await c.query(
        'select * from stock_balances where store_id=$1 and part_id=$2 for update',
        [b.storeId, b.partId]
      );
      const available = bal.rowCount ? Number(bal.rows[0].on_hand) - Number(bal.rows[0].reserved) : 0;
      if (available < b.quantity)
        throw insufficientStock('Insufficient available stock to reserve', { available, requested: b.quantity });
      await c.query('update stock_balances set reserved = reserved + $1, version = version + 1 where id=$2', [b.quantity, bal.rows[0].id]);
      const r = await c.query(
        'insert into stock_reservations(organization_id,job_card_id,store_id,part_id,quantity,reserved_by) values($1,$2,$3,$4,$5,$6) returning *',
        [orgOf(req), job.id, b.storeId, b.partId, b.quantity, currentUser(req).id]
      );
      await audit(req, 'STOCK_RESERVED', 'stock_reservation', r.rows[0].id, { jobId: job.id, partId: b.partId, quantity: b.quantity }, c);
      return r.rows[0];
    });
    ok(res, out);
  })
);

jobRoutes.post(
  '/reservations/:id/release',
  requirePermission('stock:issue'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ reason: z.string().min(3) }).parse(req.body);
    const out = await tx(async (c) => {
      const r = await c.query("select * from stock_reservations where id=$1 and organization_id=$2 and status='ACTIVE' for update", [req.params.id, orgOf(req)]);
      if (!r.rowCount) throw new DomainError('RESERVATION_NOT_FOUND', 'No active reservation with this id', 404);
      const row = r.rows[0];
      await c.query('update stock_balances set reserved = greatest(reserved - $1, 0), version = version + 1 where store_id=$2 and part_id=$3', [
        row.quantity, row.store_id, row.part_id,
      ]);
      const upd = await c.query("update stock_reservations set status='RELEASED', released_at=now(), released_reason=$1 where id=$2 returning *", [b.reason, row.id]);
      await audit(req, 'STOCK_RESERVATION_RELEASED', 'stock_reservation', row.id, { reason: b.reason }, c);
      return upd.rows[0];
    });
    ok(res, out);
  })
);

jobRoutes.get(
  '/jobs/:id/reservations',
  requirePermission('job:read', 'stock:read'),
  asyncRoute(async (req: any, res: any) => {
    const job = await inScope.job(orgOf(req), req.params.id);
    const r = await query(
      'select sr.*, p.sku, p.name from stock_reservations sr join parts p on p.id=sr.part_id where sr.job_card_id=$1 order by sr.created_at',
      [job.id]
    );
    ok(res, r.rows);
  })
);

/* ================================================================ WST-FR-09: invoice statement export */

jobRoutes.get(
  '/invoices/:id/statement',
  requirePermission('invoice:read', 'invoice:write'),
  asyncRoute(async (req: any, res: any) => {
    const inv = await inScope.invoice(orgOf(req), req.params.id);
    const [lines, payments, job] = await Promise.all([
      query('select * from invoice_lines where invoice_id=$1 order by source_type', [inv.id]),
      query('select * from payment_references where invoice_id=$1 order by paid_at', [inv.id]),
      query(
        `select j.job_no, j.complaint, v.plate_no, v.vin, v.make, v.model, c.name customer_name, c.phone
           from job_cards j join vehicles v on v.id=j.vehicle_id join customers c on c.id=j.customer_id where j.id=$1`,
        [inv.job_card_id]
      ),
    ]);
    const paid = payments.rows.reduce((s: number, p: any) => s + Number(p.amount), 0);
    const statement = {
      invoiceNo: inv.invoice_no,
      issuedAt: inv.issued_at,
      status: inv.status,
      job: job.rows[0],
      totals: {
        parts: Number(inv.subtotal_parts), labor: Number(inv.subtotal_labor), sublet: Number(inv.sublet_price),
        discount: Number(inv.discount_amount), taxRate: Number(inv.tax_rate), tax: Number(inv.tax_amount),
        total: Number(inv.total_amount), paid, outstanding: Number(inv.total_amount) - paid,
      },
      lines: lines.rows,
      payments: payments.rows,
      // reconciliation proof: the sum of the lines must equal the computed subtotals
      reconciliation: {
        linesTotal: Math.round(lines.rows.reduce((s: number, l: any) => s + Number(l.line_total), 0) * 100) / 100,
        subtotalsTotal: Math.round((Number(inv.subtotal_parts) + Number(inv.subtotal_labor) + Number(inv.sublet_price)) * 100) / 100,
      },
    };
    await audit(req, 'INVOICE_STATEMENT_EXPORTED', 'invoice', inv.id, { format: String(req.query.format || 'json') });
    if (String(req.query.format || 'json') === 'pdf') {
      const { invoiceStatementPdf } = await import('../pdf.js');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_no}.pdf"`);
      return invoiceStatementPdf(statement).pipe(res);
    }
    ok(res, statement);
  })
);
