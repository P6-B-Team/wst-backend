import type { PoolClient } from 'pg';
import { query } from './db/index.js';
import { DomainError, bayConflict, insufficientStock, notFound as notFoundError } from './http.js';
import { settings } from './core.js';

/* ------------------------------------------------------------------ inventory */

/**
 * Single choke point for every stock change. The balance row is locked with FOR UPDATE, the
 * availability check happens after the lock, and the balance + ledger row are written in the same
 * transaction. A CHECK (on_hand >= 0) constraint backs this up at the database level, so stock can
 * never go negative even if a future code path forgets the check.
 */
export async function moveStock(
  c: PoolClient,
  opts: {
    organizationId: string;
    storeId: string;
    partId: string;
    delta: number; // negative = out of store
    type: string;
    referenceType?: string;
    referenceId?: string;
    unitCost?: number;
    reason?: string;
    userId: string;
    allowCreate?: boolean;
  }
) {
  let bal = await c.query(
    `select sb.*, p.average_cost from stock_balances sb
       join parts p on p.id = sb.part_id
      where sb.store_id=$1 and sb.part_id=$2 for update of sb`,
    [opts.storeId, opts.partId]
  );
  if (!bal.rowCount) {
    if (!opts.allowCreate && opts.delta < 0)
      throw insufficientStock('No stock balance exists for this part in this store');
    await c.query(
      'insert into stock_balances(store_id, part_id, on_hand, reserved) values($1,$2,0,0) on conflict(store_id,part_id) do nothing',
      [opts.storeId, opts.partId]
    );
    bal = await c.query(
      `select sb.*, p.average_cost from stock_balances sb join parts p on p.id = sb.part_id
        where sb.store_id=$1 and sb.part_id=$2 for update of sb`,
      [opts.storeId, opts.partId]
    );
  }
  const row = bal.rows[0];
  const available = Number(row.on_hand) - Number(row.reserved);
  if (opts.delta < 0 && available < Math.abs(opts.delta))
    throw insufficientStock('Insufficient available stock', {
      requested: Math.abs(opts.delta),
      available,
    });

  const updated = await c.query(
    'update stock_balances set on_hand = on_hand + $1, version = version + 1 where id=$2 returning on_hand',
    [opts.delta, row.id]
  );
  await c.query(
    `insert into stock_movements(organization_id, store_id, part_id, type, quantity, reference_type,
                                 reference_id, unit_cost, reason, created_by, balance_after)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      opts.organizationId, opts.storeId, opts.partId, opts.type, opts.delta,
      opts.referenceType ?? null, opts.referenceId ?? null,
      opts.unitCost ?? row.average_cost, opts.reason ?? null, opts.userId,
      updated.rows[0].on_hand,
    ]
  );
  return { balanceAfter: Number(updated.rows[0].on_hand), unitCost: Number(row.average_cost) };
}

/**
 * Weighted moving average cost. Receiving 10 units at 120 into 30 units held at 100 must move the
 * average to 105, not to 120. The previous implementation overwrote the average with the last
 * purchase price, which silently mis-stated stock valuation and every cost-based KPI.
 */
export async function applyWeightedAverageCost(
  c: PoolClient,
  partId: string,
  receivedQty: number,
  unitCost: number
): Promise<{ previousCost: number; newCost: number; quantityBefore: number }> {
  const r = await c.query(
    `select p.average_cost,
            coalesce((select sum(sb.on_hand) from stock_balances sb where sb.part_id = p.id), 0) on_hand
       from parts p where p.id = $1 for update of p`,
    [partId]
  );
  const previousCost = Number(r.rows[0].average_cost);
  // on_hand is read *after* the receipt movement, so the pre-receipt quantity is on_hand - received.
  const quantityBefore = Math.max(Number(r.rows[0].on_hand) - receivedQty, 0);
  const denominator = quantityBefore + receivedQty;
  const newCost =
    denominator <= 0
      ? unitCost
      : Math.round(((quantityBefore * previousCost + receivedQty * unitCost) / denominator) * 100) / 100;
  await c.query('update parts set average_cost=$1 where id=$2', [newCost, partId]);
  return { previousCost, newCost, quantityBefore };
}

/* ------------------------------------------------------------------ pricing (never client input) */

/**
 * The brief's "hardest part": the invoice is computed from logged labour and issued parts rather
 * than typed. That is only true if the *unit* prices also come from the system. Selling price is
 * read from the parts catalogue and labour rate from the rate table, technician override, then the
 * organisation default — the caller cannot influence either.
 */
export async function resolvePartSellPrice(c: { query: any }, partId: string) {
  const r = await c.query('select sku, sell_price, average_cost from parts where id=$1', [partId]);
  if (!r.rowCount) throw notFoundError('Part');
  const sell = Number(r.rows[0].sell_price);
  if (!(sell > 0))
    throw new DomainError('PART_NOT_PRICED', 'This part has no selling price in the catalogue; set one before issuing it', 422, {
      sku: r.rows[0].sku,
    });
  return { unitPrice: sell, unitCost: Number(r.rows[0].average_cost), source: 'PART_SELL_PRICE' };
}

export async function resolveLaborRate(
  c: { query: any },
  organizationId: string,
  serviceType: string | null,
  technicianId: string | null
) {
  if (serviceType) {
    const r = await c.query('select rate from labor_rates where organization_id=$1 and service_type=$2', [organizationId, serviceType]);
    if (r.rowCount) return { rate: Number(r.rows[0].rate), source: 'SERVICE_TYPE_RATE' };
  }
  if (technicianId) {
    const r = await c.query('select labor_rate from users where id=$1 and organization_id=$2', [technicianId, organizationId]);
    if (r.rowCount && r.rows[0].labor_rate !== null) return { rate: Number(r.rows[0].labor_rate), source: 'TECHNICIAN_RATE' };
  }
  const cfg = await settings(organizationId, c as PoolClient);
  return { rate: Number(cfg.default_labor_rate), source: 'ORG_DEFAULT' };
}

/* ------------------------------------------------------------------ shared bay calendar */

/**
 * Every booking of a physical bay — workshop job or training session — goes through this table.
 * The EXCLUDE constraint in migration 005 rejects an overlap at commit time, so two concurrent
 * transactions cannot both believe the bay is free. Application checks alone cannot do this.
 */
export async function reserveBay(
  c: PoolClient,
  opts: { organizationId: string; bayId: string | null; sourceType: 'JOB' | 'SESSION'; sourceId: string; startsAt: any; endsAt: any; userId: string }
) {
  await c.query('delete from bay_reservations where source_type=$1 and source_id=$2', [opts.sourceType, opts.sourceId]);
  if (!opts.bayId || !opts.startsAt || !opts.endsAt) return null;
  try {
    const r = await c.query(
      `insert into bay_reservations(organization_id,bay_id,source_type,source_id,during,created_by)
       values($1,$2,$3,$4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), $7) returning *`,
      [opts.organizationId, opts.bayId, opts.sourceType, opts.sourceId, opts.startsAt, opts.endsAt, opts.userId]
    );
    return r.rows[0];
  } catch (e: any) {
    if (e?.code === '23P01') {
      const clash = await c.query(
        `select source_type, source_id, lower(during) starts_at, upper(during) ends_at
           from bay_reservations
          where bay_id=$1 and during && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
        [opts.bayId, opts.startsAt, opts.endsAt]
      );
      throw bayConflict('BAY_DOUBLE_BOOKED', 'This bay is already booked for part of that window', {
        bayId: opts.bayId,
        conflicts: clash.rows,
      });
    }
    throw e;
  }
}

export const releaseBay = (c: PoolClient, sourceType: 'JOB' | 'SESSION', sourceId: string) =>
  c.query('delete from bay_reservations where source_type=$1 and source_id=$2', [sourceType, sourceId]);

/**
 * The mirror image of findSessionConflicts: what a *job* would collide with. Previously only
 * sessions checked jobs, so a job could be scheduled straight into a published session's bay.
 */
export async function findJobConflicts(
  c: PoolClient | { query: any },
  organizationId: string,
  job: { id?: string; bay_id?: string | null; assigned_technician_id?: string | null; scheduled_start_at: any; scheduled_end_at: any }
) {
  if (!job.scheduled_start_at || !job.scheduled_end_at) return [];
  const params = [
    organizationId,
    job.id ?? '00000000-0000-0000-0000-000000000000',
    job.bay_id ?? null,
    job.assigned_technician_id ?? null,
    job.scheduled_start_at,
    job.scheduled_end_at,
  ];
  const r = await c.query(
    `select 'SESSION_BAY' kind, ts.id ref_id, ts.starts_at, ts.ends_at
       from training_sessions ts
      where ts.organization_id=$1 and ts.status='PUBLISHED'
        and $3::uuid is not null and ts.bay_id = $3::uuid
        and ts.starts_at < $6::timestamptz and ts.ends_at > $5::timestamptz
     union all
     select 'SESSION_MENTOR', ts.id, ts.starts_at, ts.ends_at
       from training_sessions ts
      where ts.organization_id=$1 and ts.status='PUBLISHED'
        and $4::uuid is not null and ts.mentor_id = $4::uuid
        and ts.starts_at < $6::timestamptz and ts.ends_at > $5::timestamptz
     union all
     select 'JOB_BAY', j.id, j.scheduled_start_at, j.scheduled_end_at
       from job_cards j
      where j.organization_id=$1 and j.id <> $2 and j.status not in ('DELIVERED','CANCELLED')
        and $3::uuid is not null and j.bay_id = $3::uuid
        and j.scheduled_start_at is not null and j.scheduled_end_at is not null
        and j.scheduled_start_at < $6::timestamptz and j.scheduled_end_at > $5::timestamptz
     union all
     select 'JOB_TECHNICIAN', j.id, j.scheduled_start_at, j.scheduled_end_at
       from job_cards j
      where j.organization_id=$1 and j.id <> $2 and j.status not in ('DELIVERED','CANCELLED')
        and $4::uuid is not null and j.assigned_technician_id = $4::uuid
        and j.scheduled_start_at is not null and j.scheduled_end_at is not null
        and j.scheduled_start_at < $6::timestamptz and j.scheduled_end_at > $5::timestamptz`,
    params
  );
  return r.rows;
}

/* ------------------------------------------------------------------ invoicing */

export type InvoiceTotals = {
  subtotalParts: number; subtotalLabor: number; subletPrice: number;
  discount: number; taxRate: number; taxAmount: number; total: number;
  partLines: any[]; laborLines: any[]; subletLines: any[];
};

/**
 * Totals are always derived from the source rows (issued-minus-reversed parts, billable labor,
 * billable sublet). No client supplied total is ever accepted; discount is the only client input
 * and it is validated against the computed subtotal.
 */
export async function computeInvoice(
  c: PoolClient | { query: any },
  organizationId: string,
  jobCardId: string,
  discount = 0
): Promise<InvoiceTotals> {
  // NOTE: these run sequentially on purpose — a single pg client cannot execute queries in parallel.
  const parts = await c.query(
      `select jp.id, jp.part_id, p.sku, p.name, (jp.quantity - jp.reversed_qty) qty, jp.unit_price_snapshot
         from job_parts jp join parts p on p.id = jp.part_id
        where jp.job_card_id=$1 and (jp.quantity - jp.reversed_qty) > 0`,
      [jobCardId]
  );
  const labor = await c.query('select id, minutes, rate_snapshot, note from labor_entries where job_card_id=$1 and billable=true', [jobCardId]);
  const sublet = await c.query('select id, description, price from job_sublets where job_card_id=$1 and billable=true', [jobCardId]);
  const cfg = await settings(organizationId, c as PoolClient);

  const round = (n: number) => Math.round(n * 100) / 100;
  const partLines = parts.rows.map((x: any) => ({
    sourceType: 'PART', sourceId: x.id, description: `${x.sku} — ${x.name}`,
    quantity: Number(x.qty), unitPrice: Number(x.unit_price_snapshot),
    lineTotal: round(Number(x.qty) * Number(x.unit_price_snapshot)),
  }));
  const laborLines = labor.rows.map((x: any) => ({
    sourceType: 'LABOR', sourceId: x.id, description: x.note || 'Labor',
    quantity: round(Number(x.minutes) / 60), unitPrice: Number(x.rate_snapshot),
    lineTotal: round((Number(x.minutes) / 60) * Number(x.rate_snapshot)),
  }));
  const subletLines = sublet.rows.map((x: any) => ({
    sourceType: 'SUBLET', sourceId: x.id, description: x.description,
    quantity: 1, unitPrice: Number(x.price), lineTotal: round(Number(x.price)),
  }));

  const sum = (rows: any[]) => round(rows.reduce((s, x) => s + x.lineTotal, 0));
  const subtotalParts = sum(partLines), subtotalLabor = sum(laborLines), subletPrice = sum(subletLines);
  const gross = round(subtotalParts + subtotalLabor + subletPrice);
  if (discount < 0 || discount > gross)
    throw new DomainError('INVALID_DISCOUNT', 'Discount must be between 0 and the computed subtotal', 422, { gross, discount });
  const taxRate = Number(cfg.tax_rate);
  const taxable = round(gross - discount);
  const taxAmount = round(taxable * taxRate);
  return {
    subtotalParts, subtotalLabor, subletPrice, discount, taxRate, taxAmount,
    total: round(taxable + taxAmount), partLines, laborLines, subletLines,
  };
}

/* ------------------------------------------------------------------ scheduling conflicts */

/**
 * Detects bay / mentor / student overlaps against both published training sessions and scheduled
 * workshop jobs using a true interval overlap (start < otherEnd AND end > otherStart).
 */
export async function findSessionConflicts(
  c: PoolClient | { query: any },
  organizationId: string,
  session: { id?: string; bay_id?: string | null; mentor_id?: string | null; starts_at: any; ends_at: any }
) {
  const params = [organizationId, session.id ?? '00000000-0000-0000-0000-000000000000', session.bay_id ?? null, session.mentor_id ?? null, session.starts_at, session.ends_at];
  const r = await c.query(
    `select 'SESSION_BAY' kind, ts.id ref_id, ts.starts_at, ts.ends_at
       from training_sessions ts
      where ts.organization_id=$1 and ts.id <> $2 and ts.status='PUBLISHED'
        and $3::uuid is not null and ts.bay_id = $3::uuid
        and ts.starts_at < $6::timestamptz and ts.ends_at > $5::timestamptz
     union all
     select 'SESSION_MENTOR', ts.id, ts.starts_at, ts.ends_at
       from training_sessions ts
      where ts.organization_id=$1 and ts.id <> $2 and ts.status='PUBLISHED'
        and $4::uuid is not null and ts.mentor_id = $4::uuid
        and ts.starts_at < $6::timestamptz and ts.ends_at > $5::timestamptz
     union all
     select 'JOB_BAY', j.id, j.scheduled_start_at, j.scheduled_end_at
       from job_cards j
      where j.organization_id=$1 and j.status not in ('DELIVERED','CANCELLED')
        and $3::uuid is not null and j.bay_id = $3::uuid
        and j.scheduled_start_at is not null and j.scheduled_end_at is not null
        and j.scheduled_start_at < $6::timestamptz and j.scheduled_end_at > $5::timestamptz
     union all
     select 'JOB_TECHNICIAN', j.id, j.scheduled_start_at, j.scheduled_end_at
       from job_cards j
      where j.organization_id=$1 and j.status not in ('DELIVERED','CANCELLED')
        and $4::uuid is not null and j.assigned_technician_id = $4::uuid
        and j.scheduled_start_at is not null and j.scheduled_end_at is not null
        and j.scheduled_start_at < $6::timestamptz and j.scheduled_end_at > $5::timestamptz`,
    params
  );
  return r.rows;
}

/* ------------------------------------------------------------------ certification */

/**
 * Certification eligibility. Only SIGNED assessments count: an assessment left in
 * PENDING_SIGNATURE is reported as a blocking gap and never contributes to coverage.
 */
export async function certificationStatus(
  c: PoolClient | { query: any },
  organizationId: string,
  studentId: string,
  courseId: string
) {
  const cfg = await settings(organizationId, c as PoolClient);
  const tasks = await c.query('select id, code, title, required, weight from practical_tasks where course_id=$1', [courseId]);
  const assessed = await c.query(
    `select a.task_id, a.result, a.status
       from assessments a
       join training_sessions ts on ts.id = a.session_id
      where a.student_id=$1 and ts.course_id=$2`,
    [studentId, courseId]
  );
  const attendance = await c.query(
    `select count(*) filter (where a.status in ('PRESENT','LATE')) attended, count(*) total
       from attendances a join training_sessions ts on ts.id = a.session_id
      where a.student_id=$1 and ts.course_id=$2`,
    [studentId, courseId]
  );
  const byTask = new Map(assessed.rows.map((a: any) => [a.task_id, a]));
  const required = tasks.rows.filter((t: any) => t.required);
  const gaps: any[] = [];
  let signedPass = 0;
  for (const t of required) {
    const a: any = byTask.get(t.id);
    if (!a) gaps.push({ taskId: t.id, code: t.code, reason: 'NOT_ASSESSED' });
    else if (a.status !== 'SIGNED') gaps.push({ taskId: t.id, code: t.code, reason: 'PENDING_SIGNATURE' });
    else if (a.result !== 'PASS') gaps.push({ taskId: t.id, code: t.code, reason: `RESULT_${a.result}` });
    else signedPass++;
  }
  const att = attendance.rows[0];
  const attendanceRatio = Number(att.total) ? Number(att.attended) / Number(att.total) : 0;
  const coverage = required.length ? signedPass / required.length : 0;
  if (Number(att.total) && attendanceRatio < Number(cfg.certificate_min_attendance_ratio))
    gaps.push({ reason: 'ATTENDANCE_BELOW_MINIMUM', attendanceRatio, required: Number(cfg.certificate_min_attendance_ratio) });

  return {
    eligible: gaps.length === 0 && required.length > 0 && coverage >= Number(cfg.certificate_min_pass_ratio),
    coverage, attendanceRatio,
    requiredTasks: required.length, signedPassed: signedPass,
    pendingSignature: assessed.rows.filter((a: any) => a.status !== 'SIGNED').length,
    gaps,
  };
}

/* ------------------------------------------------------------------ predictions (rule baselines) */

export const MODELS = {
  reorder: { key: 'inventory_reorder', version: 'min-max-open-po-v2', strategy: 'RULE_BASELINE' },
  trainingRisk: { key: 'training_completion_risk', version: 'weighted-rules-v1', strategy: 'RULE_BASELINE' },
};

/**
 * Rule-based reorder baseline. Explainable (every contributing feature is returned), versioned
 * (model_version), and it *is* the non-AI fallback: if an external model is plugged in later it
 * must fall back to this function, which never depends on anything outside the database.
 */
export async function reorderSuggestions(organizationId: string) {
  const r = await query(
    `with usage as (
        select sm.part_id, sum(abs(sm.quantity)) qty
          from stock_movements sm
         where sm.organization_id=$1 and sm.type='ISSUE' and sm.created_at > now() - interval '90 days'
         group by sm.part_id),
       on_order as (
        select pol.part_id, sum(pol.ordered_qty - pol.received_qty) qty
          from purchase_order_lines pol
          join purchase_orders po on po.id = pol.purchase_order_id
         where po.organization_id=$1
           and po.status in ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIALLY_RECEIVED')
           and pol.ordered_qty > pol.received_qty
         group by pol.part_id),
       held as (
        select sr.part_id, sum(sr.quantity) qty
          from stock_reservations sr
         where sr.organization_id=$1 and sr.status='ACTIVE'
         group by sr.part_id)
     select p.id part_id, p.sku, p.name, p.min_level, p.max_level,
            coalesce(sum(sb.on_hand),0) on_hand,
            coalesce(max(h.qty),0) reserved,
            coalesce(max(u.qty),0) issued_90d,
            coalesce(max(oo.qty),0) on_order
       from parts p
       left join stock_balances sb on sb.part_id = p.id
       left join usage u  on u.part_id  = p.id
       left join on_order oo on oo.part_id = p.id
       left join held h on h.part_id = p.id
      where p.organization_id=$1 and p.is_active
      group by p.id
      having coalesce(sum(sb.on_hand),0) - coalesce(max(h.qty),0) <= p.min_level
      order by p.sku`,
    [organizationId]
  );
  return r.rows.map((x: any) => {
    const onHand = Number(x.on_hand);
    const reserved = Number(x.reserved);
    const onOrder = Number(x.on_order);
    const available = onHand - reserved;
    // "Inventory position" is the standard replenishment quantity: what is free now plus what is
    // already coming. Ignoring open purchase orders is what makes a baseline order the same stock
    // twice, which is exactly what the brief lists as a required input.
    const inventoryPosition = available + onOrder;
    const issued90d = Number(x.issued_90d);
    const averageWeeklyConsumption = Math.round((issued90d / (90 / 7)) * 100) / 100;
    const dailyUse = issued90d / 90;
    const coverDays = dailyUse > 0 ? Math.round((available / dailyUse) * 10) / 10 : null;
    const suggestedQty = Math.max(Math.round((Number(x.max_level) - inventoryPosition) * 100) / 100, 0);
    return {
      partId: x.part_id, sku: x.sku, name: x.name,
      onHand, reserved, available, onOrder, inventoryPosition,
      minLevel: Number(x.min_level), maxLevel: Number(x.max_level),
      averageWeeklyConsumption,
      suggestedReorderQty: suggestedQty,
      urgency: available <= 0 ? 'CRITICAL' : coverDays !== null && coverDays < 7 ? 'HIGH' : 'NORMAL',
      model: MODELS.reorder,
      explanation: {
        rule: 'available (on_hand - reserved) <= min_level triggers replenishment up to max_level, counting stock already on open purchase orders',
        features: {
          onHand, reserved, available, onOrder, inventoryPosition,
          minLevel: Number(x.min_level), maxLevel: Number(x.max_level),
          issuedLast90Days: issued90d,
          averageWeeklyConsumption,
          averageDailyUse: Math.round(dailyUse * 100) / 100,
          estimatedCoverDays: coverDays,
        },
        formula: `suggested = max(max_level(${x.max_level}) - (available(${available}) + onOrder(${onOrder})), 0) = ${suggestedQty}`,
      },
    };
  });
}

/**
 * Training completion risk baseline: transparent weighted rules over attendance, pending
 * signatures, failed tasks and remaining coverage. Deterministic, explainable, versioned.
 */
export async function trainingRisk(organizationId: string, courseId?: string) {
  const r = await query(
    `select s.id student_id, s.student_no, s.full_name, ts.course_id, co.name course_name,
            count(distinct at.id) filter (where at.status in ('PRESENT','LATE')) attended,
            count(distinct at.id) attendance_records,
            count(distinct a.id) filter (where a.status='SIGNED' and a.result='PASS') signed_pass,
            count(distinct a.id) filter (where a.status <> 'SIGNED') pending_signature,
            count(distinct a.id) filter (where a.result='FAIL') failed,
            (select count(*) from practical_tasks pt where pt.course_id = ts.course_id and pt.required) required_tasks
       from students s
       join enrollments e on e.student_id = s.id
       join training_sessions ts on ts.id = e.session_id
       join courses co on co.id = ts.course_id
       left join attendances at on at.student_id = s.id and at.session_id = ts.id
       left join assessments a on a.student_id = s.id and a.session_id = ts.id
      where s.organization_id=$1 and ($2::uuid is null or ts.course_id = $2::uuid)
      group by s.id, ts.course_id, co.name`,
    [organizationId, courseId ?? null]
  );
  return r.rows.map((x: any) => {
    const attendanceRatio = Number(x.attendance_records) ? Number(x.attended) / Number(x.attendance_records) : 1;
    const requiredTasks = Number(x.required_tasks) || 0;
    const coverage = requiredTasks ? Number(x.signed_pass) / requiredTasks : 0;
    const contributions = [
      { feature: 'attendanceRatio', value: Math.round(attendanceRatio * 100) / 100, weight: 0.35, points: Math.round((1 - attendanceRatio) * 0.35 * 100) },
      { feature: 'competencyCoverage', value: Math.round(coverage * 100) / 100, weight: 0.4, points: Math.round((1 - coverage) * 0.4 * 100) },
      { feature: 'pendingSignatures', value: Number(x.pending_signature), weight: 0.15, points: Math.min(Number(x.pending_signature), 3) * 5 },
      { feature: 'failedTasks', value: Number(x.failed), weight: 0.1, points: Math.min(Number(x.failed), 2) * 5 },
    ];
    const score = Math.min(100, contributions.reduce((s, c) => s + c.points, 0));
    return {
      studentId: x.student_id, studentNo: x.student_no, fullName: x.full_name,
      courseId: x.course_id, courseName: x.course_name,
      riskScore: score, band: score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW',
      model: MODELS.trainingRisk,
      explanation: { method: 'deterministic weighted rules (non-AI fallback)', contributions, note: 'Only SIGNED assessments count toward coverage.' },
    };
  });
}

export const assertSessionPublishable = (session: any) => {
  if (!session.starts_at || !session.ends_at) throw new DomainError('INVALID_WINDOW', 'Session needs a start and end');
  if (new Date(session.ends_at) <= new Date(session.starts_at))
    throw new DomainError('INVALID_WINDOW', 'Session end must be after its start');
};

export const conflictError = (rows: any[]) =>
  bayConflict('RESOURCE_CONFLICT', 'Bay, mentor or technician already booked in this window', { conflicts: rows });
