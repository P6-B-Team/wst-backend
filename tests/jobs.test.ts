import { describe, it, expect, beforeAll } from 'vitest';
import { as, approvedJob, createStockedPart, login, uniq } from './helpers.js';

let manager: any, m: ReturnType<typeof as>;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  m = as(manager.token);
});

async function newJob() {
  const customer = (await m.post('/api/v1/customers', { name: uniq('C') })).body.data;
  const vehicle = (await m.post(`/api/v1/customers/${customer.id}/vehicles`, {
    plateNo: uniq('P').slice(0, 14), vin: uniq('V'), make: 'Kia', model: 'Cerato', year: 2020, mileage: 10000,
  })).body.data;
  return (await m.post('/api/v1/jobs', {
    customerId: customer.id, vehicleId: vehicle.id, complaint: 'Noise', serviceType: 'GENERAL', receivedMileage: 10500,
  })).body.data;
}

describe('job card state machine', () => {
  it('opens a job in RECEIVED and records the first stage history row', async () => {
    const job = await newJob();
    expect(job.status).toBe('RECEIVED');
    const detail = await m.get(`/api/v1/jobs/${job.id}`);
    expect(detail.body.data.timeline).toHaveLength(1);
    expect(detail.body.data.timeline[0].to_status).toBe('RECEIVED');
    expect(detail.body.data.timeline[0].changed_by).toBe(manager.user.id);
  });

  it('refuses a skipping transition (RECEIVED -> READY)', async () => {
    const job = await newJob();
    const r = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('JOB_INVALID_TRANSITION');
  });

  it('refuses to start work before the customer approves', async () => {
    const job = await newJob();
    const r = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CUSTOMER_APPROVAL_REQUIRED');
  });

  it('refuses billable labor before approval but starts work once approved', async () => {
    const job = await newJob();
    const early = await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 30 });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('CUSTOMER_APPROVAL_REQUIRED');

    await m.post(`/api/v1/jobs/${job.id}/customer-approvals`, { decision: 'APPROVED', channel: 'PHONE', referenceNo: uniq('R') });
    const started = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe('IN_PROGRESS');
  });

  it('requires a reason for rework from quality check and records every stage change', async () => {
    const { job } = await approvedJob(manager.token);
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });

    const noReason = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe('REASON_REQUIRED');

    const rework = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS', reason: 'Pad seated badly' });
    expect(rework.status).toBe(200);
    const detail = await m.get(`/api/v1/jobs/${job.id}`);
    expect(detail.body.data.timeline.map((t: any) => t.to_status)).toEqual(['RECEIVED', 'IN_PROGRESS', 'QUALITY_CHECK', 'IN_PROGRESS']);
  });
});

describe('invoice is computed from source data', () => {
  it('derives totals from labor and issued parts and refuses a client supplied total', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10);

    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 90 });
    await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 2 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });

    // Neither the hourly rate nor the part price was supplied by this test; both are system facts.
    // The expected totals are therefore recomputed from those stored facts rather than hard-coded,
    // which is the whole point of the rule: the invoice follows the source rows.
    const detail = (await m.get(`/api/v1/jobs/${job.id}`)).body.data;
    const expectedLabor = (90 / 60) * Number(detail.labor[0].rate_snapshot);
    const expectedParts = 2 * Number(detail.parts[0].unit_price_snapshot);
    const gross = expectedLabor + expectedParts;

    // A caller trying to dictate the total gets ignored: only `discount` is accepted.
    const inv = await m.post(`/api/v1/jobs/${job.id}/invoices`, { totalAmount: 1, discount: 0 });
    expect(inv.status).toBe(200);
    expect(Number(inv.body.data.subtotal_labor)).toBeCloseTo(expectedLabor, 2);
    expect(Number(inv.body.data.subtotal_parts)).toBeCloseTo(expectedParts, 2);
    expect(Number(inv.body.data.tax_amount)).toBeCloseTo(gross * 0.14, 2);
    expect(Number(inv.body.data.total_amount)).toBeCloseTo(gross * 1.14, 2);
    expect(inv.body.data.lines).toHaveLength(2);
  });

  it('refuses a second invoice for the same job', async () => {
    const { job } = await approvedJob(manager.token);
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    expect((await m.post(`/api/v1/jobs/${job.id}/invoices`, {})).status).toBe(200);
    const second = await m.post(`/api/v1/jobs/${job.id}/invoices`, {});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('INVOICE_EXISTS');
  });

  it('refuses invoicing before the job is READY and delivery before an invoice exists', async () => {
    const { job } = await approvedJob(manager.token);
    const early = await m.post(`/api/v1/jobs/${job.id}/invoices`, {});
    expect(early.body.error.code).toBe('JOB_NOT_READY');

    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 30 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });

    const noInvoice = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'DELIVERED' });
    expect(noInvoice.body.error.code).toBe('INVOICE_REQUIRED');

    const inv = (await m.post(`/api/v1/jobs/${job.id}/invoices`, {})).body.data;
    const delivered = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'DELIVERED' });
    expect(delivered.status).toBe(200);

    const pay = await m.post(`/api/v1/invoices/${inv.id}/payment-references`, {
      referenceNo: uniq('PAY'), amount: Number(inv.total_amount), method: 'CASH',
    });
    expect(pay.status).toBe(200);
    const after = await m.get(`/api/v1/invoices/${inv.id}`);
    expect(after.body.data.status).toBe('PAID');
    expect(after.body.data.outstanding).toBeCloseTo(0, 2);

    const over = await m.post(`/api/v1/invoices/${inv.id}/payment-references`, { referenceNo: uniq('PAY'), amount: 10, method: 'CASH' });
    expect(over.body.error.code).toBe('OVERPAYMENT');
  });
});

describe('service history and reminders', () => {
  it('shows the delivered job in the vehicle history and generates the next reminder', async () => {
    const { job, vehicle } = await approvedJob(manager.token);
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 45 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    await m.post(`/api/v1/jobs/${job.id}/invoices`, {});
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'DELIVERED' });

    const history = await m.get(`/api/v1/vehicles/${vehicle.id}/service-history`);
    expect(history.body.data[0].job_no).toBe(job.job_no);
    expect(history.body.data[0].invoice_no).toBeTruthy();

    const reminder = await m.post(`/api/v1/vehicles/${vehicle.id}/reminders/generate`, {});
    expect(reminder.status).toBe(200);
    expect(reminder.body.data.due_date).toBeTruthy();
  });
});
