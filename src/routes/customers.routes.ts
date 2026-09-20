import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/index.js';
import { auth, orgOf, requirePermission } from '../auth.js';
import { asyncRoute, created, DomainError, notFound, ok, pageParams, uuid } from '../http.js';
import { audit, inScope, settings } from '../core.js';

export const customerRoutes = Router();
customerRoutes.use(auth);

customerRoutes.get(
  '/customers',
  requirePermission('customer:read'),
  asyncRoute(async (req: any, res: any) => {
    const { page, pageSize, offset } = pageParams(req);
    const q = String(req.query.q || '');
    const params = [orgOf(req), q, `%${q}%`, String(req.query.includeArchived || 'false')];
    const rows = await query(
      `select * from customers
        where organization_id=$1 and ($2='' or name ilike $3 or phone ilike $3 or email ilike $3)
          and (archived_at is null or $4 = 'true')
        order by created_at desc, id desc limit ${pageSize} offset ${offset}`,
      params
    );
    const total = await query(
      `select count(*) c from customers where organization_id=$1 and ($2='' or name ilike $3 or phone ilike $3 or email ilike $3)
         and (archived_at is null or $4 = 'true')`,
      params
    );
    await audit(req, 'CUSTOMERS_LISTED', 'customer', null, { rows: rows.rowCount, query: q || null, page });
    ok(res, rows.rows, { page, pageSize, total: Number(total.rows[0].c) });
  })
);

customerRoutes.post(
  '/customers',
  requirePermission('customer:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        name: z.string().min(2),
        phone: z.string().min(5).optional(),
        email: z.string().email().optional(),
        preferredContact: z.enum(['PHONE', 'EMAIL', 'SMS']).optional(),
      })
      .parse(req.body);
    const r = await query(
      'insert into customers(organization_id,name,phone,email,preferred_contact) values($1,$2,$3,$4,$5) returning *',
      [orgOf(req), b.name, b.phone ?? null, b.email ?? null, b.preferredContact ?? null]
    );
    await audit(req, 'CUSTOMER_CREATED', 'customer', r.rows[0].id, { name: b.name });
    ok(res, r.rows[0]);
  })
);

customerRoutes.get(
  '/customers/:id',
  requirePermission('customer:read'),
  asyncRoute(async (req: any, res: any) => {
    uuid.parse(req.params.id);
    const c = await query('select * from customers where id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    if (!c.rowCount) throw notFound('Customer');
    const v = await query('select * from vehicles where customer_id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    // Customer contact details are personal data; reading one record is a sensitive read.
    await audit(req, 'CUSTOMER_READ', 'customer', req.params.id, { vehicles: v.rowCount });
    ok(res, { ...c.rows[0], vehicles: v.rows });
  })
);

customerRoutes.patch(
  '/customers/:id',
  requirePermission('customer:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        name: z.string().min(2).optional(),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        preferredContact: z.enum(['PHONE', 'EMAIL', 'SMS']).optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
        notes: z.string().max(2000).optional(),
      })
      .strict()
      .parse(req.body);
    uuid.parse(req.params.id);
    const r = await query(
      `update customers set name=coalesce($1,name), phone=coalesce($2,phone), email=coalesce($3,email),
              preferred_contact=coalesce($4,preferred_contact), status=coalesce($5,status),
              notes=coalesce($6,notes), updated_at=now()
        where id=$7 and organization_id=$8 returning *`,
      [b.name, b.phone, b.email, b.preferredContact, b.status, b.notes, req.params.id, orgOf(req)]
    );
    if (!r.rowCount) throw notFound('Customer');
    await audit(req, 'CUSTOMER_UPDATED', 'customer', req.params.id, b);
    ok(res, r.rows[0]);
  })
);

customerRoutes.get(
  '/customers/:id/vehicles',
  requirePermission('customer:read'),
  asyncRoute(async (req: any, res: any) => {
    uuid.parse(req.params.id);
    const { page, pageSize, offset } = pageParams(req);
    const r = await query(
      `select * from vehicles where customer_id=$1 and organization_id=$2 order by plate_no limit ${pageSize} offset ${offset}`,
      [req.params.id, orgOf(req)]
    );
    const total = await query('select count(*) c from vehicles where customer_id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
  })
);

customerRoutes.post(
  '/customers/:id/vehicles',
  requirePermission('customer:write'),
  asyncRoute(async (req: any, res: any) => {
    uuid.parse(req.params.id);
    const b = z
      .object({
        plateNo: z.string().min(2),
        vin: z.string().min(5),
        make: z.string().min(1),
        model: z.string().min(1),
        year: z.number().int().min(1950).max(2100).optional(),
        mileage: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);
    const customer = await query('select id from customers where id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    if (!customer.rowCount) throw notFound('Customer');
    const r = await query(
      `insert into vehicles(organization_id,customer_id,plate_no,vin,make,model,year,mileage)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [orgOf(req), req.params.id, b.plateNo, b.vin, b.make, b.model, b.year ?? null, b.mileage ?? 0]
    );
    await audit(req, 'VEHICLE_CREATED', 'vehicle', r.rows[0].id, { plateNo: b.plateNo });
    created(res, r.rows[0]);
  })
);

/** WST-FR-03 asks for mileage and contact preferences to be maintained; a vehicle had no update
 *  path at all, so a corrected plate, a new mileage reading or a model typo could never be fixed. */
customerRoutes.patch(
  '/vehicles/:id',
  requirePermission('customer:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        plateNo: z.string().min(2).optional(),
        vin: z.string().min(5).optional(),
        make: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        year: z.number().int().min(1950).max(2100).optional(),
        mileage: z.number().int().nonnegative().optional(),
        status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
      })
      .strict()
      .parse(req.body);
    if (!Object.keys(b).length) throw new DomainError('NOTHING_TO_UPDATE', 'Provide at least one field to update', 400);
    const vehicle = await inScope.vehicle(orgOf(req), req.params.id);
    if (b.mileage !== undefined && b.mileage < Number(vehicle.mileage))
      throw new DomainError('MILEAGE_DECREASED', 'Mileage cannot be lowered; record an odometer correction instead', 422, {
        current: Number(vehicle.mileage), submitted: b.mileage,
      });
    const r = await query(
      `update vehicles set plate_no=coalesce($1,plate_no), vin=coalesce($2,vin), make=coalesce($3,make),
              model=coalesce($4,model), year=coalesce($5,year), mileage=coalesce($6,mileage),
              status=coalesce($7,status), updated_at=now()
        where id=$8 and organization_id=$9 returning *`,
      [b.plateNo, b.vin, b.make, b.model, b.year, b.mileage, b.status, vehicle.id, orgOf(req)]
    );
    await audit(req, 'VEHICLE_UPDATED', 'vehicle', vehicle.id, { changed: b });
    ok(res, r.rows[0]);
  })
);

customerRoutes.get(
  '/vehicles/:id/service-history',
  requirePermission('customer:read'),
  asyncRoute(async (req: any, res: any) => {
    await inScope.vehicle(orgOf(req), req.params.id);
    const r = await query(
      `select j.id, j.job_no, j.status, j.complaint, j.service_type, j.received_mileage, j.created_at, j.closed_at,
              i.invoice_no, i.total_amount,
              coalesce((select json_agg(json_build_object('sku',p.sku,'name',p.name,'qty',jp.quantity - jp.reversed_qty))
                          from job_parts jp join parts p on p.id=jp.part_id
                         where jp.job_card_id=j.id and jp.quantity - jp.reversed_qty > 0), '[]') parts
         from job_cards j
         left join invoices i on i.job_card_id = j.id and i.status <> 'CANCELLED'
        where j.vehicle_id=$1 and j.organization_id=$2
        order by j.created_at desc`,
      [req.params.id, orgOf(req)]
    );
    ok(res, r.rows);
  })
);

/** Reminders are generated from the delivered job + org interval settings, not entered by hand. */
customerRoutes.post(
  '/vehicles/:id/reminders/generate',
  requirePermission('customer:write'),
  asyncRoute(async (req: any, res: any) => {
    const vehicle = await inScope.vehicle(orgOf(req), req.params.id);
    const cfg = await settings(orgOf(req));
    const last = await query(
      `select * from job_cards where vehicle_id=$1 and organization_id=$2 and status='DELIVERED' order by created_at desc, id desc limit 1`,
      [req.params.id, orgOf(req)]
    );
    if (!last.rowCount) throw notFound('Delivered job for this vehicle');
    const r = await query(
      `insert into service_reminders(organization_id, vehicle_id, job_card_id, due_date, due_mileage, reason)
       values($1,$2,$3, (current_date + ($4 || ' days')::interval)::date, $5, $6) returning *`,
      [
        orgOf(req), req.params.id, last.rows[0].id, String(cfg.reminder_interval_days),
        Number(vehicle.mileage || 0) + Number(cfg.reminder_interval_km),
        `Next service after ${last.rows[0].job_no}`,
      ]
    );
    await audit(req, 'REMINDER_CREATED', 'service_reminder', r.rows[0].id, { vehicleId: req.params.id });
    ok(res, r.rows[0]);
  })
);

customerRoutes.get(
  '/reminders',
  requirePermission('customer:read'),
  asyncRoute(async (req: any, res: any) => {
    const r = await query(
      `select sr.*, v.plate_no, c.name customer_name, c.phone
         from service_reminders sr
         join vehicles v on v.id = sr.vehicle_id
         join customers c on c.id = v.customer_id
        where sr.organization_id=$1 and ($2='' or sr.status=$2)
        order by sr.due_date`,
      [orgOf(req), String(req.query.status || 'PENDING')]
    );
    ok(res, r.rows);
  })
);

/* ================================================================ WST-FR-03: vehicle detail, next service rule, archiving */

customerRoutes.get(
  '/vehicles/:id',
  requirePermission('customer:read'),
  asyncRoute(async (req: any, res: any) => {
    const vehicle = await inScope.vehicle(orgOf(req), req.params.id);
    const cfg = await settings(orgOf(req));
    const [customer, history, reminders] = await Promise.all([
      query('select id, name, phone, email, preferred_contact, status from customers where id=$1', [vehicle.customer_id]),
      query(
        `select j.id, j.job_no, j.status, j.service_type, j.received_mileage, j.created_at, j.closed_at,
                i.invoice_no, i.total_amount
           from job_cards j left join invoices i on i.job_card_id=j.id and i.status<>'CANCELLED'
          where j.vehicle_id=$1 order by j.created_at desc`,
        [vehicle.id]
      ),
      query("select * from service_reminders where vehicle_id=$1 and status='PENDING' order by due_date", [vehicle.id]),
    ]);
    const lastDelivered = history.rows.find((j: any) => j.status === 'DELIVERED');
    ok(res, {
      ...vehicle,
      customer: customer.rows[0],
      serviceHistory: history.rows,
      reminders: reminders.rows,
      // the "next service rule" the acceptance evidence asks for, computed from org settings
      nextServiceRule: {
        intervalDays: Number(cfg.reminder_interval_days),
        intervalKm: Number(cfg.reminder_interval_km),
        lastServiceAt: lastDelivered?.closed_at ?? null,
        lastServiceMileage: lastDelivered ? Number(lastDelivered.received_mileage) : null,
        dueMileage: Number(vehicle.mileage || 0) + Number(cfg.reminder_interval_km),
        dueDate: lastDelivered?.closed_at
          ? new Date(new Date(lastDelivered.closed_at).getTime() + Number(cfg.reminder_interval_days) * 86400000).toISOString().slice(0, 10)
          : null,
      },
    });
  })
);

customerRoutes.post(
  '/vehicles/:id/archive',
  requirePermission('customer:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ reason: z.string().min(3) }).parse(req.body);
    await inScope.vehicle(orgOf(req), req.params.id);
    const open = await query("select count(*) c from job_cards where vehicle_id=$1 and status not in ('DELIVERED','CANCELLED')", [req.params.id]);
    if (Number(open.rows[0].c)) throw new DomainError('INVALID_STATE', 'Vehicle still has open job cards', 422, { openJobs: Number(open.rows[0].c) });
    const r = await query(
      "update vehicles set status='ARCHIVED', archived_at=now(), updated_at=now() where id=$1 and organization_id=$2 returning *",
      [req.params.id, orgOf(req)]
    );
    await audit(req, 'VEHICLE_ARCHIVED', 'vehicle', req.params.id, { reason: b.reason });
    ok(res, r.rows[0]);
  })
);

customerRoutes.post(
  '/customers/:id/archive',
  requirePermission('customer:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ reason: z.string().min(3) }).parse(req.body);
    const open = await query(
      "select count(*) c from job_cards where customer_id=$1 and organization_id=$2 and status not in ('DELIVERED','CANCELLED')",
      [req.params.id, orgOf(req)]
    );
    if (Number(open.rows[0].c)) throw new DomainError('INVALID_STATE', 'Customer still has open job cards', 422, { openJobs: Number(open.rows[0].c) });
    const r = await query(
      "update customers set status='ARCHIVED', archived_at=now(), updated_at=now() where id=$1 and organization_id=$2 returning *",
      [req.params.id, orgOf(req)]
    );
    if (!r.rowCount) throw notFound('Customer');
    await audit(req, 'CUSTOMER_ARCHIVED', 'customer', req.params.id, { reason: b.reason });
    ok(res, r.rows[0]);
  })
);
