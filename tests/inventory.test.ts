import { describe, it, expect, beforeAll } from 'vitest';
import { approvedJob, as, createStockedPart, login, uniq } from './helpers.js';
import { query } from '../src/db/index.js';

let manager: any, supervisor: any, m: ReturnType<typeof as>;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  supervisor = await login('store.supervisor@wst.local');
  m = as(manager.token);
});

describe('stock issue', () => {
  it('deducts stock atomically and writes a ledger row', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10);
    const issue = await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 3 });
    expect(issue.status).toBe(200);
    expect(issue.body.data.balanceAfter).toBe(7);

    const ledger = await m.get(`/api/v1/stock/movements?partId=${part.id}`);
    const issueRow = ledger.body.data.find((r: any) => r.type === 'ISSUE');
    expect(Number(issueRow.quantity)).toBe(-3);
    expect(Number(issueRow.balance_after)).toBe(7);
  });

  it('refuses an issue larger than the available quantity', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 2);
    const r = await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  /**
   * The real concurrency check: two simultaneous requests for 3 units against 5 units of stock.
   * Exactly one must succeed and the balance must never go below zero.
   */
  it('never allows negative stock under concurrent issues', async () => {
    const [{ job: jobA }, { job: jobB }] = await Promise.all([approvedJob(manager.token), approvedJob(manager.token)]);
    const { part, store } = await createStockedPart(manager.token, 5);

    const results = await Promise.all([
      m.post(`/api/v1/jobs/${jobA.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 3 }),
      m.post(`/api/v1/jobs/${jobB.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 3 }),
    ]);

    const okCount = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 400);
    expect(okCount).toBe(1);
    expect(rejected[0].body.error.code).toBe('INSUFFICIENT_STOCK');

    const balance = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(balance.rows[0].on_hand)).toBe(2);
    expect(Number(balance.rows[0].on_hand)).toBeGreaterThanOrEqual(0);
  });

  it('holds the invariant across ten parallel requests', async () => {
    const { part, store } = await createStockedPart(manager.token, 10);
    const jobs = await Promise.all(Array.from({ length: 10 }, () => approvedJob(manager.token)));
    const results = await Promise.all(
      jobs.map(({ job }) => m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 2 }))
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    const balance = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(balance.rows[0].on_hand)).toBe(0);
  });
});

describe('reversal of issued parts', () => {
  it('requires authorisation, returns the quantity, and records reason plus audit event', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10);
    const jp = (await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 4 })).body.data;

    const technician = await login('tech@wst.local');
    const denied = await as(technician.token).post(`/api/v1/job-parts/${jp.id}/reversals`, { quantity: 1, reason: 'Wrong part issued' });
    expect(denied.status).toBe(403);

    const noReason = await as(supervisor.token).post(`/api/v1/job-parts/${jp.id}/reversals`, { quantity: 1 });
    expect(noReason.status).toBe(400);

    const tooMuch = await as(supervisor.token).post(`/api/v1/job-parts/${jp.id}/reversals`, { quantity: 9, reason: 'Wrong part issued' });
    expect(tooMuch.body.error.code).toBe('REVERSAL_EXCEEDS_ISSUED');

    const rev = await as(supervisor.token).post(`/api/v1/job-parts/${jp.id}/reversals`, { quantity: 4, reason: 'Wrong part issued to job' });
    expect(rev.status).toBe(200);
    expect(rev.body.data.jobPart.status).toBe('REVERSED');

    const balance = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(balance.rows[0].on_hand)).toBe(10);

    const events = await query("select * from audit_events where action='PART_REVERSED' and entity_id=$1", [jp.id]);
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].metadata_json.reason).toBe('Wrong part issued to job');

    // reversed quantity must disappear from the invoice basis
    const preview = await m.get(`/api/v1/jobs/${job.id}/invoice-preview`);
    expect(Number(preview.body.data.subtotalParts)).toBe(0);
  });
});

describe('reorder baseline', () => {
  it('returns explainable, versioned suggestions for parts at or below minimum', async () => {
    const { part, store } = await createStockedPart(manager.token, 0);
    await m.patch(`/api/v1/parts/${part.id}/levels`, { minLevel: 5, maxLevel: 20 });
    const r = await m.get('/api/v1/stock/alerts');
    const row = r.body.data.find((x: any) => x.partId === part.id);
    expect(row).toBeTruthy();
    expect(row.suggestedReorderQty).toBe(20);
    expect(row.model.version).toBe('min-max-open-po-v2');
    expect(row.explanation.features).toHaveProperty('averageDailyUse');
    void store;
  });

  it('persists a versioned prediction run', async () => {
    const run = await m.post('/api/v1/predictions/reorder/runs', {});
    expect(run.status).toBe(200);
    const history = await m.get('/api/v1/predictions/reorder/runs');
    expect(history.body.data.length).toBeGreaterThan(0);
    expect(history.body.data[0].model_version).toBe('min-max-open-po-v2');
  });
});

describe('stock adjustments', () => {
  it('requires a reason and refuses to drive the balance negative', async () => {
    const { part, store } = await createStockedPart(manager.token, 3);
    const bad = await m.post('/api/v1/stock/adjustments', { storeId: store.id, partId: part.id, delta: -10, reason: uniq('shrinkage') });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INSUFFICIENT_STOCK');
    const balance = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(balance.rows[0].on_hand)).toBe(3);
  });
});
