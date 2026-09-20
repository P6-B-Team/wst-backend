import crypto from 'node:crypto';
import { pool, tx } from './pool.js';
import { computeInvoice, reserveBay, resolveLaborRate } from '../services.js';
import { encryptToken } from '../crypto.js';

/**
 * Builds the dataset the acceptance scenarios are demonstrated against:
 *   - job cards sitting in every lifecycle stage, including a delivered+paid one
 *   - an approved purchase order with a receipt still waiting for acceptance
 *   - a published training session with a cohort, one student fully signed off and certified
 *     and one student deliberately left with an unsigned assessment
 *   - parts below their minimum level so the reorder baseline has real input
 * Running it twice is a no-op.
 */

const ORG_A = '00000000-0000-0000-0000-000000000001';

const one = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows[0];
const userId = async (email: string) => (await one('select id from users where email=$1', [email])).id;

async function docNo(c: any, prefix: string) {
  const r = await c.query(
    `insert into doc_counters(organization_id, doc_type, value) values($1,$2,1)
     on conflict(organization_id, doc_type) do update set value = doc_counters.value + 1 returning value`,
    [ORG_A, prefix]
  );
  return `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(r.rows[0].value).padStart(5, '0')}`;
}

const audit = (c: any, actor: string, action: string, type: string, id: string | null, meta: any = {}) =>
  c.query(
    `insert into audit_events(organization_id, actor_id, action, entity_type, entity_id, request_id, metadata_json)
     values($1,$2,$3,$4,$5,'seed',$6)`,
    [ORG_A, actor, action, type, id, JSON.stringify(meta)]
  );

async function main() {
  const marker = await one("select 1 from audit_events where request_id='seed' limit 1");
  if (marker) {
    console.log('Acceptance scenario data already present — skipping.');
    return;
  }

  const [advisor, tech, qc, keeper, buyer, approver1, approver2, supervisor, mentor] = await Promise.all(
    ['advisor@wst.local', 'tech@wst.local', 'qc@wst.local', 'store@wst.local', 'buyer@wst.local',
     'approver1@wst.local', 'approver2@wst.local', 'supervisor@wst.local', 'mentor@wst.local'].map(userId)
  );
  const store = await one("select id from stores where organization_id=$1 and code='MAIN'", [ORG_A]);
  const bays = (await pool.query('select id, code from bays where organization_id=$1 order by code', [ORG_A])).rows;
  const vehicles = (await pool.query(
    'select v.id, v.customer_id, v.mileage from vehicles v where v.organization_id=$1 order by v.plate_no limit 8',
    [ORG_A]
  )).rows;
  const parts = (await pool.query(
    'select p.id, p.average_cost, p.sell_price from parts p where p.organization_id=$1 and p.sku > $2 order by p.sku limit 6',
    [ORG_A, 'SKU-0010']
  )).rows;

  /* ---------------------------------------------------------------- workshop pipeline */
  const stages = ['RECEIVED', 'IN_PROGRESS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY', 'DELIVERED'] as const;

  await tx(async (c) => {
    for (const [i, target] of stages.entries()) {
      const v = vehicles[i % vehicles.length];
      const jobNo = await docNo(c, 'WST');
      const job = (await c.query(
        `insert into job_cards(organization_id, job_no, customer_id, vehicle_id, complaint, service_type, priority,
                               received_mileage, expected_at, scheduled_start_at, scheduled_end_at, estimate_amount,
                               bay_id, assigned_technician_id, status, created_by)
         values($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '2 days',
                now() + ($9 || ' hours')::interval, now() + ($10 || ' hours')::interval,
                $11,$12,$13,'RECEIVED',$14) returning *`,
        [ORG_A, jobNo, v.customer_id, v.id,
         ['Brake noise on braking', 'Engine warning light', 'A/C not cooling', 'Periodic service', 'Suspension knock', 'Oil leak'][i],
         ['BRAKES', 'DIAGNOSTICS', 'AC', 'SERVICE', 'SUSPENSION', 'ENGINE'][i],
         i === 1 ? 'HIGH' : 'NORMAL', Number(v.mileage) + 500,
         String(24 + i * 6), String(27 + i * 6), 1500 + i * 250,
         bays[i % bays.length].id, tech, advisor]
      )).rows[0];
      await c.query('insert into job_stage_history(job_card_id,to_status,changed_by,reason) values($1,$2,$3,$4)', [job.id, 'RECEIVED', advisor, 'Vehicle received']);
      await audit(c, advisor, 'JOB_CREATED', 'job_card', job.id, { jobNo });
      // Active jobs hold their bay in the shared calendar, exactly as the API does.
      if (target !== 'DELIVERED')
        await reserveBay(c, {
          organizationId: ORG_A, bayId: job.bay_id, sourceType: 'JOB', sourceId: job.id,
          startsAt: job.scheduled_start_at, endsAt: job.scheduled_end_at, userId: advisor,
        });

      if (target === 'RECEIVED') continue;

      // customer approval, then the state machine walked stage by stage
      await c.query(
        `insert into job_approvals(job_card_id, approval_type, approved_by, decision, channel, reference_no, approved_amount, note)
         values($1,'CUSTOMER',$2,'APPROVED','PHONE',$3,$4,'Approved by phone')`,
        [job.id, advisor, `APR-${jobNo}`, 1500 + i * 250]
      );
      await c.query("update job_cards set customer_approval_status='APPROVED' where id=$1", [job.id]);
      await audit(c, advisor, 'JOB_CUSTOMER_APPROVED', 'job_card', job.id, { channel: 'PHONE' });

      const path = ['IN_PROGRESS', 'QUALITY_CHECK', 'READY', 'DELIVERED'];
      const stop = path.indexOf(target);
      let current = 'RECEIVED';

      for (let s = 0; s <= stop; s++) {
        const next = path[s];
        if (next === 'QUALITY_CHECK') {
          const laborRate = await resolveLaborRate(c, ORG_A, job.service_type, tech);
          await c.query(
            'insert into labor_entries(job_card_id,technician_id,minutes,rate_snapshot,rate_source,billable,note) values($1,$2,$3,$4,$5,true,$6)',
            [job.id, tech, 60 + i * 15, laborRate.rate, laborRate.source, 'Diagnosis and repair']
          );
          const part = parts[i % parts.length];
          const qty = 1 + (i % 3);
          const jp = (await c.query(
            `insert into job_parts(job_card_id,part_id,store_id,quantity,unit_cost_snapshot,unit_price_snapshot,issued_by)
             values($1,$2,$3,$4,$5,$6,$7) returning *`,
            [job.id, part.id, store.id, qty, part.average_cost, part.sell_price, keeper]
          )).rows[0];
          const bal = (await c.query(
            'update stock_balances set on_hand = on_hand - $1, version = version + 1 where store_id=$2 and part_id=$3 returning on_hand',
            [qty, store.id, part.id]
          )).rows[0];
          await c.query(
            `insert into stock_movements(organization_id,store_id,part_id,type,quantity,reference_type,reference_id,unit_cost,created_by,balance_after)
             values($1,$2,$3,'ISSUE',$4,'JOB_PART',$5,$6,$7,$8)`,
            [ORG_A, store.id, part.id, -qty, jp.id, part.average_cost, keeper, bal.on_hand]
          );
          await audit(c, keeper, 'PART_ISSUED', 'job_part', jp.id, { jobId: job.id, quantity: qty });
        }

        if (next === 'DELIVERED') {
          const totals = await computeInvoice(c, ORG_A, job.id, 0);
          const invoiceNo = await docNo(c, 'INV');
          const inv = (await c.query(
            `insert into invoices(organization_id,invoice_no,job_card_id,status,subtotal_parts,subtotal_labor,sublet_price,
                                  discount_amount,tax_rate,tax_amount,total_amount,issued_at,created_by)
             values($1,$2,$3,'ISSUED',$4,$5,$6,$7,$8,$9,$10,now(),$11) returning *`,
            [ORG_A, invoiceNo, job.id, totals.subtotalParts, totals.subtotalLabor, totals.subletPrice,
             0, totals.taxRate, totals.taxAmount, totals.total, advisor]
          )).rows[0];
          for (const line of [...totals.partLines, ...totals.laborLines])
            await c.query(
              'insert into invoice_lines(invoice_id,source_type,source_id,description,quantity,unit_price,line_total) values($1,$2,$3,$4,$5,$6,$7)',
              [inv.id, line.sourceType, line.sourceId, line.description, line.quantity, line.unitPrice, line.lineTotal]
            );
          await c.query('insert into payment_references(invoice_id,reference_no,amount,method,note) values($1,$2,$3,$4,$5)', [
            inv.id, `PAY-${invoiceNo}`, totals.total, 'CASH', 'Settled at delivery',
          ]);
          await c.query("update invoices set status='PAID' where id=$1", [inv.id]);
          await audit(c, advisor, 'INVOICE_ISSUED', 'invoice', inv.id, { total: totals.total });
        }

        const changedBy = next === 'QUALITY_CHECK' ? tech : next === 'READY' ? qc : advisor;
        await c.query(
          `update job_cards set status=$1, updated_at=now(),
                  closed_at = case when $1='DELIVERED' then now() else closed_at end where id=$2`,
          [next, job.id]
        );
        await c.query('insert into job_stage_history(job_card_id,from_status,to_status,changed_by) values($1,$2,$3,$4)', [job.id, current, next, changedBy]);
        await audit(c, changedBy, 'JOB_TRANSITION', 'job_card', job.id, { from: current, to: next });
        current = next;
      }

      if (target === 'DELIVERED') {
        await c.query(
          `insert into service_reminders(organization_id, vehicle_id, job_card_id, due_date, due_mileage, reason)
           values($1,$2,$3,(current_date + interval '180 days')::date, $4, $5)`,
          [ORG_A, v.id, job.id, Number(v.mileage) + 10000, `Next service after ${jobNo}`]
        );
      }
    }
  });

  /* ---------------------------------------------------------------- purchasing chain */
  await tx(async (c) => {
    const vendor = (await c.query('select id from vendors where organization_id=$1 order by name limit 1', [ORG_A])).rows[0];
    const lowStock = (await c.query('select id, average_cost from parts where organization_id=$1 order by sku limit 3', [ORG_A])).rows;

    // PO 1 — above threshold, fully approved, receipt recorded but NOT yet accepted
    const po1No = await docNo(c, 'PO');
    const total1 = lowStock.reduce((s: number, p: any) => s + 20 * Number(p.average_cost), 0);
    const po1 = (await c.query(
      `insert into purchase_orders(organization_id,po_no,vendor_id,status,total_amount,approvals_required,created_by,submitted_by,submitted_at,decided_at)
       values($1,$2,$3,'APPROVED',$4,2,$5,$5,now(),now()) returning *`,
      [ORG_A, po1No, vendor.id, total1, buyer]
    )).rows[0];
    const lines: any[] = [];
    for (const p of lowStock)
      lines.push((await c.query('insert into purchase_order_lines(purchase_order_id,part_id,ordered_qty,unit_cost) values($1,$2,20,$3) returning *', [po1.id, p.id, p.average_cost])).rows[0]);
    for (const [level, approver] of [[1, approver1], [2, approver2]] as const)
      await c.query("insert into purchase_approvals(purchase_order_id,approval_level,approved_by,decision) values($1,$2,$3,'APPROVED')", [po1.id, level, approver]);
    await audit(c, buyer, 'PO_CREATED', 'purchase_order', po1.id, { total: total1, approvalsRequired: 2 });
    await audit(c, approver2, 'PO_APPROVAL_RECORDED', 'purchase_order', po1.id, { approvalsGiven: 2, approvalsRequired: 2 });

    const grnNo = await docNo(c, 'GRN');
    const grn = (await c.query(
      `insert into goods_receipts(organization_id,purchase_order_id,store_id,received_by,status,gr_no)
       values($1,$2,$3,$4,'PENDING',$5) returning *`,
      [ORG_A, po1.id, store.id, keeper, grnNo]
    )).rows[0];
    for (const l of lines)
      await c.query('insert into goods_receipt_lines(goods_receipt_id,purchase_order_line_id,accepted_qty,rejected_qty,unit_cost) values($1,$2,20,0,$3)', [grn.id, l.id, l.unit_cost]);
    await audit(c, keeper, 'GRN_RECORDED', 'goods_receipt', grn.id, { stockMoved: false });

    // PO 2 — above threshold, one approval only: still waiting for the second approver
    const po2No = await docNo(c, 'PO');
    const po2 = (await c.query(
      `insert into purchase_orders(organization_id,po_no,vendor_id,status,total_amount,approvals_required,created_by,submitted_by,submitted_at)
       values($1,$2,$3,'PENDING_APPROVAL',7500,2,$4,$4,now()) returning *`,
      [ORG_A, po2No, vendor.id, buyer]
    )).rows[0];
    await c.query('insert into purchase_order_lines(purchase_order_id,part_id,ordered_qty,unit_cost) values($1,$2,50,150)', [po2.id, lowStock[0].id]);
    await c.query("insert into purchase_approvals(purchase_order_id,approval_level,approved_by,decision) values($1,1,$2,'APPROVED')", [po2.id, approver1]);
    await audit(c, approver1, 'PO_APPROVAL_RECORDED', 'purchase_order', po2.id, { approvalsGiven: 1, approvalsRequired: 2 });
  });

  /* ---------------------------------------------------------------- training cohort */
  await tx(async (c) => {
    const course = (await c.query("select id from courses where organization_id=$1 and code='C-BRAKES'", [ORG_A])).rows[0];
    const tasks = (await c.query('select id from practical_tasks where course_id=$1 order by code', [course.id])).rows;
    const students = (await c.query('select id from students where organization_id=$1 order by student_no limit 6', [ORG_A])).rows;

    // Acceptance Scenario 1 asks for exactly four training sessions; seed.ts already creates them.
    // The certification cohort is demonstrated on one of those four rather than adding a fifth, so
    // the seeded total stays exactly four, matching the PDF instead of exceeding it as "extra demo data".
    const session = (await c.query(
      "select * from training_sessions where organization_id=$1 and title='Brakes practical — week 1'",
      [ORG_A]
    )).rows[0];
    if (session.status !== 'PUBLISHED') {
      await reserveBay(c, {
        organizationId: ORG_A, bayId: session.bay_id, sourceType: 'SESSION', sourceId: session.id,
        startsAt: session.starts_at, endsAt: session.ends_at, userId: supervisor,
      });
      await c.query("update training_sessions set status='PUBLISHED' where id=$1", [session.id]);
      await audit(c, supervisor, 'SESSION_PUBLISHED', 'training_session', session.id, { bayId: session.bay_id, mentorId: session.mentor_id });
    }
    // The bay/mentor conflict rule itself is proven by the automated test suite (training.test.ts),
    // which creates and publishes its own overlapping session — no extra seeded session is needed
    // here, which is exactly what would have pushed the count past the official four.

    for (const [i, s] of students.entries()) {
      await c.query('insert into enrollments(session_id,student_id) values($1,$2) on conflict do nothing', [session.id, s.id]);
      await c.query('insert into attendances(session_id,student_id,status,recorded_by) values($1,$2,$3,$4) on conflict do nothing', [
        session.id, s.id, i === 5 ? 'ABSENT' : 'PRESENT', mentor,
      ]);

      for (const [t, task] of tasks.entries()) {
        // student 0: every task signed  -> certifiable
        // student 1: all recorded, one left unsigned -> must stay blocked
        // others: partial data for dashboards and risk scoring
        if (i > 2 && t > 0) continue;
        const result = i === 4 && t === 0 ? 'NEEDS_IMPROVEMENT' : 'PASS';
        const a = (await c.query(
          `insert into assessments(session_id,student_id,task_id,result,time_on_task,mentor_note,entered_by,status)
           values($1,$2,$3,$4,$5,'Seeded assessment',$6,'PENDING_SIGNATURE')
           on conflict(session_id,student_id,task_id) do nothing returning *`,
          [session.id, s.id, task.id, result, 40 + t * 5, mentor]
        )).rows[0];
        if (!a) continue;
        await audit(c, mentor, 'ASSESSMENT_RECORDED', 'assessment', a.id, { result, status: 'PENDING_SIGNATURE' });

        const shouldSign = i === 0 || (i === 1 && t < tasks.length - 1) || (i === 2 && t === 0);
        if (shouldSign && result === 'PASS') {
          await c.query("update assessments set status='SIGNED' where id=$1", [a.id]);
          await c.query('insert into assessment_signoffs(assessment_id,signed_by) values($1,$2)', [a.id, supervisor]);
          await audit(c, supervisor, 'ASSESSMENT_SIGNED', 'assessment', a.id, {});
        }
      }
    }

    // student 0 is fully signed off, so a certificate is issued with a known verification token
    const token = 'wst-demo-certificate-token';
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const cert = (await c.query(
      `insert into certificates(organization_id,student_id,course_id,public_token_hash,token_cipher,issued_by,coverage_json)
       values($1,$2,$3,$4,$5,$6,$7) returning *`,
      [ORG_A, students[0].id, course.id, hash, encryptToken(token), supervisor,
       JSON.stringify({ coverage: 1, attendanceRatio: 1, requiredTasks: tasks.length })]
    )).rows[0];
    await audit(c, supervisor, 'CERTIFICATE_ISSUED', 'certificate', cert.id, { studentId: students[0].id });
    await c.query(
      `insert into notifications(organization_id, recipient_id, topic, payload_json) values($1,$2,'CERTIFICATE_ISSUED',$3)`,
      [ORG_A, supervisor, JSON.stringify({ certificateId: cert.id })]
    );
  });

  const counts = await one(`
    select (select count(*) from job_cards where organization_id=$1) jobs,
           (select count(*) from invoices where organization_id=$1) invoices,
           (select count(*) from purchase_orders where organization_id=$1) pos,
           (select count(*) from assessments a join training_sessions t on t.id=a.session_id where t.organization_id=$1) assessments,
           (select count(*) from audit_events where organization_id=$1) audit_events`, [ORG_A]);

  console.log(`Acceptance scenario data created:
  job cards across all stages : ${counts.jobs}
  invoices (incl. one paid)   : ${counts.invoices}
  purchase orders             : ${counts.pos} (one approved with a PENDING goods receipt, one awaiting a 2nd approval)
  assessments                 : ${counts.assessments} (one student fully signed & certified, one blocked by an unsigned task)
  audit events                : ${counts.audit_events}
  certificate verification    : GET /api/v1/certificates/verify/wst-demo-certificate-token`);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
