import { describe, it, expect, beforeAll } from 'vitest';
import { approvedJob, as, createStockedPart, login, uniq } from './helpers.js';
import { query } from '../src/db/index.js';

let manager: any, supervisor: any, m: ReturnType<typeof as>;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  supervisor = await login('store.supervisor@wst.local');
  m = as(manager.token);
});

describe('concurrency — stock can never go negative', () => {
  it('serialises twenty simultaneous issues of one unit against twelve units', async () => {
    const { part, store } = await createStockedPart(manager.token, 12);
    const jobs = await Promise.all(Array.from({ length: 20 }, () => approvedJob(manager.token)));
    const results = await Promise.all(
      jobs.map(({ job }) => m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 1 }))
    );
    const accepted = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 400);

    expect(accepted).toHaveLength(12);
    expect(rejected).toHaveLength(8);
    expect(rejected.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true); // no 500s, no deadlock leaks

    const balance = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(balance.rows[0].on_hand)).toBe(0);

    // the ledger must reconcile exactly with the balance
    const ledger = await query("select coalesce(sum(quantity),0) net from stock_movements where part_id=$1 and store_id=$2", [part.id, store.id]);
    expect(Number(ledger.rows[0].net)).toBe(0); // +12 opening adjustment, -12 issued
  });

  it('refuses to oversell when mixed quantities compete for the last units', async () => {
    const { part, store } = await createStockedPart(manager.token, 7);
    const jobs = await Promise.all(Array.from({ length: 4 }, () => approvedJob(manager.token)));
    const quantities = [5, 4, 3, 2];
    const results = await Promise.all(
      jobs.map(({ job }, i) => m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: quantities[i] }))
    );
    const issued = results.filter((r) => r.status === 200).reduce((s, r, i) => s + quantities[results.indexOf(r)], 0);
    const balance = Number((await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id])).rows[0].on_hand);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(7 - issued);
  });

  it('keeps the database CHECK constraint as a last line of defence', async () => {
    const { part, store } = await createStockedPart(manager.token, 1);
    const balance = await query('select id from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    await expect(
      query('update stock_balances set on_hand = on_hand - 5 where id=$1', [balance.rows[0].id])
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('concurrency — reversal', () => {
  it('never returns more than was issued when reversals race each other', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10);
    const jp = (await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 4 })).body.data;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        as(supervisor.token).post(`/api/v1/job-parts/${jp.id}/reversals`, { quantity: 3, reason: 'Concurrent reversal attempt' })
      )
    );
    const accepted = results.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(1); // 3 of the 4 outstanding units; a second reversal of 3 would exceed

    const balance = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(balance.rows[0].on_hand)).toBe(9); // 10 - 4 issued + 3 reversed
    const jobPart = await query('select quantity, reversed_qty from job_parts where id=$1', [jp.id]);
    expect(Number(jobPart.rows[0].reversed_qty)).toBeLessThanOrEqual(Number(jobPart.rows[0].quantity));
  });
});

describe('concurrency — document numbering', () => {
  it('produces unique job numbers under parallel creation', async () => {
    const customer = (await m.post('/api/v1/customers', { name: uniq('Fleet') })).body.data;
    const vehicles = await Promise.all(
      Array.from({ length: 12 }, () =>
        m.post(`/api/v1/customers/${customer.id}/vehicles`, { plateNo: uniq('P').slice(0, 14), vin: uniq('V'), make: 'Kia', model: 'Rio' })
      )
    );
    const results = await Promise.all(
      vehicles.map((v) =>
        m.post('/api/v1/jobs', {
          customerId: customer.id, vehicleId: v.body.data.id, complaint: 'Fleet service', serviceType: 'GENERAL', receivedMileage: 1000,
        })
      )
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.data.job_no);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('produces unique invoice numbers under parallel issuing', async () => {
    const jobs = await Promise.all(Array.from({ length: 6 }, () => approvedJob(manager.token)));
    for (const { job } of jobs) {
      await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
      await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 30 });
      await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
      await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    }
    const invoices = await Promise.all(jobs.map(({ job }) => m.post(`/api/v1/jobs/${job.id}/invoices`, {})));
    expect(invoices.every((r) => r.status === 200)).toBe(true);
    const numbers = invoices.map((r) => r.body.data.invoice_no);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('concurrency — approvals and duplicate submissions', () => {
  it('records only one approval when the same approver fires twice at once', async () => {
    const buyer = await login('buyer@wst.local');
    const approver = await login('approver1@wst.local');
    const { part } = await createStockedPart(manager.token, 0);
    const vendor = (await m.get('/api/v1/vendors')).body.data[0];
    const po = (await as(buyer.token).post('/api/v1/purchase-orders', { vendorId: vendor.id, lines: [{ partId: part.id, quantity: 1, unitCost: 5000 }] })).body.data;
    await as(buyer.token).post(`/api/v1/purchase-orders/${po.id}/submit`, {});

    const results = await Promise.all([
      as(approver.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' }),
      as(approver.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const stored = await query('select count(*) c from purchase_approvals where purchase_order_id=$1', [po.id]);
    expect(Number(stored.rows[0].c)).toBe(1);
    const status = await query('select status from purchase_orders where id=$1', [po.id]);
    expect(status.rows[0].status).toBe('PENDING_APPROVAL'); // one approval is not enough above threshold
  });

  it('creates only one invoice when two requests race for the same job', async () => {
    const { job } = await approvedJob(manager.token);
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });

    const results = await Promise.all([
      m.post(`/api/v1/jobs/${job.id}/invoices`, {}),
      m.post(`/api/v1/jobs/${job.id}/invoices`, {}),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const count = await query("select count(*) c from invoices where job_card_id=$1 and status<>'CANCELLED'", [job.id]);
    expect(Number(count.rows[0].c)).toBe(1);
  });
});
