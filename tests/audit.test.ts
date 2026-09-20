import { describe, it, expect, beforeAll } from 'vitest';
import { approvedJob, as, createStockedPart, login, uniq } from './helpers.js';
import { query } from '../src/db/index.js';

let manager: any, supervisor: any, storeSup: any, buyer: any, approver1: any, approver2: any, keeper: any, mentor: any;
let m: ReturnType<typeof as>;

const auditFor = async (action: string, entityId: string) =>
  query('select * from audit_events where action=$1 and entity_id=$2', [action, entityId]);

beforeAll(async () => {
  manager = await login('manager@wst.local');
  supervisor = await login('supervisor@wst.local');
  storeSup = await login('store.supervisor@wst.local');
  buyer = await login('buyer@wst.local');
  approver1 = await login('approver1@wst.local');
  approver2 = await login('approver2@wst.local');
  keeper = await login('store@wst.local');
  mentor = await login('mentor@wst.local');
  m = as(manager.token);
});

describe('audit events are written for sensitive operations', () => {
  it('records the actor, organization and request id on every event', async () => {
    const customer = (await m.post('/api/v1/customers', { name: uniq('Audited') })).body.data;
    const events = await auditFor('CUSTOMER_CREATED', customer.id);
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].actor_id).toBe(manager.user.id);
    expect(events.rows[0].organization_id).toBe(manager.user.organizationId);
    expect(events.rows[0].request_id).toBeTruthy();
  });

  it('records customer approval, transitions, part issue and invoicing across a full job', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10);

    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60 });
    const jp = (await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 2 })).body.data;
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    const inv = (await m.post(`/api/v1/jobs/${job.id}/invoices`, {})).body.data;
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'DELIVERED' });

    expect((await auditFor('JOB_CREATED', job.id)).rowCount).toBe(1);
    expect((await auditFor('JOB_CUSTOMER_APPROVED', job.id)).rowCount).toBe(1);
    expect((await auditFor('JOB_TRANSITION', job.id)).rowCount).toBe(4);
    expect((await auditFor('PART_ISSUED', jp.id)).rowCount).toBe(1);

    const invoiceEvent = await auditFor('INVOICE_ISSUED', inv.id);
    expect(invoiceEvent.rowCount).toBe(1);
    expect(invoiceEvent.rows[0].metadata_json.total).toBeCloseTo(Number(inv.total_amount), 2);
    expect(invoiceEvent.rows[0].metadata_json.computedFrom).toBeTruthy();
  });

  it('records the reason and the authorising user on a part reversal', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 6);
    const jp = (await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 2 })).body.data;
    await as(storeSup.token).post(`/api/v1/job-parts/${jp.id}/reversals`, { quantity: 2, reason: 'Customer declined the repair' });

    const ev = await auditFor('PART_REVERSED', jp.id);
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].metadata_json.reason).toBe('Customer declined the repair');
    expect(ev.rows[0].metadata_json.authorizedBy).toBe(storeSup.user.id);
    expect(ev.rows[0].actor_id).toBe(storeSup.user.id);
  });

  it('records stock adjustments with reason and resulting balance', async () => {
    const { part, store } = await createStockedPart(manager.token, 5);
    const adj = (await m.post('/api/v1/stock/adjustments', { storeId: store.id, partId: part.id, delta: -2, reason: 'Stock count correction' })).body.data;
    const ev = await auditFor('STOCK_ADJUSTED', adj.id);
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0].metadata_json.reason).toBe('Stock count correction');
    expect(ev.rows[0].metadata_json.balanceAfter).toBe(3);
  });

  it('records the purchase approval chain and the goods receipt lifecycle', async () => {
    const { part, store } = await createStockedPart(manager.token, 0);
    const vendor = (await m.get('/api/v1/vendors')).body.data[0];
    const po = (await as(buyer.token).post('/api/v1/purchase-orders', { vendorId: vendor.id, lines: [{ partId: part.id, quantity: 3, unitCost: 4000 }] })).body.data;
    await as(buyer.token).post(`/api/v1/purchase-orders/${po.id}/submit`, {});
    await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    await as(approver2.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });

    expect((await auditFor('PO_CREATED', po.id)).rowCount).toBe(1);
    expect((await auditFor('PO_SUBMITTED', po.id)).rowCount).toBe(1);
    expect((await auditFor('PO_APPROVAL_RECORDED', po.id)).rowCount).toBe(2);

    const line = (await as(buyer.token).get(`/api/v1/purchase-orders/${po.id}`)).body.data.lines[0];
    const grn = (await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId: store.id, lines: [{ purchaseOrderLineId: line.id, acceptedQty: 3 }],
    })).body.data;
    const recorded = await auditFor('GRN_RECORDED', grn.id);
    expect(recorded.rows[0].metadata_json.stockMoved).toBe(false);

    await as(keeper.token).post(`/api/v1/goods-receipts/${grn.id}/accept`, {});
    const acceptedEv = await auditFor('GRN_ACCEPTED', grn.id);
    expect(acceptedEv.rows[0].metadata_json.stockMoved).toBe(true);
  });

  it('records assessment recording, sign-off and certificate issuance', async () => {
    const sup = as(supervisor.token);
    const course = (await sup.post('/api/v1/courses', { code: uniq('C'), name: 'Audited course' })).body.data;
    const task = (await sup.post(`/api/v1/courses/${course.id}/tasks`, { code: uniq('T'), title: 'Audited task' })).body.data;
    const bay = (await m.get('/api/v1/bays')).body.data[0];
    // A fixed offset makes the test collide with the session it published on the previous run,
    // now that publishing takes a real lock on the shared bay calendar. The window is unique.
    const offset = 200 * 3600_000 + Math.floor(Math.random() * 5000) * 3600_000;
    const start = new Date(Date.now() + offset).toISOString();
    const end = new Date(Date.now() + offset + 2 * 3600_000).toISOString();
    const session = (await sup.post('/api/v1/training-sessions', { courseId: course.id, startsAt: start, endsAt: end, bayId: bay.id, capacity: 5, title: uniq('S') })).body.data;
    await sup.post(`/api/v1/training-sessions/${session.id}/publish`, {});
    const student = (await sup.post('/api/v1/students', { studentNo: uniq('S'), fullName: 'Audited Student' })).body.data;
    await sup.post(`/api/v1/training-sessions/${session.id}/enrollments`, { studentIds: [student.id] });
    await sup.post(`/api/v1/training-sessions/${session.id}/attendance`, { studentId: student.id, status: 'PRESENT' });

    const assessment = (await as(mentor.token).post(`/api/v1/training-sessions/${session.id}/assessments`, {
      studentId: student.id, taskId: task.id, result: 'PASS', timeOnTask: 30,
    })).body.data;
    expect((await auditFor('ASSESSMENT_RECORDED', assessment.id)).rows[0].metadata_json.status).toBe('PENDING_SIGNATURE');

    await sup.post(`/api/v1/assessments/${assessment.id}/signoff`, {});
    expect((await auditFor('ASSESSMENT_SIGNED', assessment.id)).rowCount).toBe(1);

    const cert = (await sup.post('/api/v1/certificates', { studentId: student.id, courseId: course.id })).body.data;
    expect((await auditFor('CERTIFICATE_ISSUED', cert.id)).rowCount).toBe(1);
    expect((await auditFor('SESSION_PUBLISHED', session.id)).rowCount).toBe(1);
  });

  it('records data exports', async () => {
    await m.get('/api/v1/exports/invoices');
    const ev = await query("select * from audit_events where action='DATA_EXPORTED' order by occurred_at desc limit 1");
    expect(ev.rows[0].metadata_json.dataset).toBe('invoices');
  });

  it('exposes the trail through the audit API with filters', async () => {
    const auditor = await login('auditor@wst.local');
    const r = await as(auditor.token).get('/api/v1/audit-events?action=JOB_TRANSITION&pageSize=5');
    expect(r.status).toBe(200);
    expect(r.body.data.every((e: any) => e.action === 'JOB_TRANSITION')).toBe(true);
  });
});
