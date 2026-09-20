/**
 * The brief's "hardest part": a commercial rule enforced by the system, not by a note in the UI —
 * "the invoice is computed from logged labour and issued parts rather than typed". These tests
 * prove the prices themselves are also system facts, plus the inventory rules that feed them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { approvedJob, as, createStockedPart, login, uniq } from './helpers.js';
import { query } from '../src/db/index.js';

let manager: any, buyer: any, approver1: any, approver2: any, keeper: any;
const m = () => as(manager.token);

/** Above the organisation threshold an order needs two approvals, so both approvers sign. */
async function approveFully(po: any) {
  await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
  if (Number(po.approvals_required) > 1)
    await as(approver2.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
}

beforeAll(async () => {
  manager = await login('manager@wst.local');
  buyer = await login('buyer@wst.local');
  approver1 = await login('approver1@wst.local');
  approver2 = await login('approver2@wst.local');
  keeper = await login('store@wst.local');
});

/* ================================================================ prices are never client input */

describe('invoice prices come from the catalogue, not from the request body', () => {
  it('rejects a client supplied unit price on a part issue', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10, 80);
    const r = await m().post(`/api/v1/jobs/${job.id}/parts/issue`, {
      partId: part.id, storeId: store.id, quantity: 1, unitPrice: 5,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a client supplied labour rate', async () => {
    const { job } = await approvedJob(manager.token);
    const r = await m().post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60, rateSnapshot: 1 });
    expect(r.status).toBe(400);
  });

  it('snapshots the catalogue selling price and records where it came from', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10, 137.5);
    const issued = await m().post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 2 });
    expect(issued.status).toBe(200);
    expect(Number(issued.body.data.unit_price_snapshot)).toBe(137.5);
    expect(issued.body.data.price_source).toBe('PART_SELL_PRICE');
  });

  it('refuses to issue a part that has no catalogue selling price', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10, 0);
    const r = await m().post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PART_NOT_PRICED');
  });

  it('resolves the labour rate from the service type rate table', async () => {
    const { job } = await approvedJob(manager.token); // approvedJob opens a BRAKES job
    const expected = Number((await query(
      "select rate from labor_rates where organization_id='00000000-0000-0000-0000-000000000001' and service_type='BRAKES'"
    )).rows[0].rate);
    const r = await m().post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60 });
    expect(Number(r.body.data.rate_snapshot)).toBe(expected);
    expect(r.body.data.rate_source).toBe('SERVICE_TYPE_RATE');
  });

  it('falls back to the organisation default for a service type with no rate', async () => {
    const customer = (await m().post('/api/v1/customers', { name: uniq('C') })).body.data;
    const vehicle = (await m().post(`/api/v1/customers/${customer.id}/vehicles`, {
      plateNo: uniq('PL').slice(0, 14), vin: uniq('VIN'), make: 'Kia', model: 'Cerato', year: 2022, mileage: 100,
    })).body.data;
    const job = (await m().post('/api/v1/jobs', {
      customerId: customer.id, vehicleId: vehicle.id, complaint: 'Unusual noise',
      serviceType: uniq('EXOTIC'), receivedMileage: 200,
    })).body.data;
    await m().post(`/api/v1/jobs/${job.id}/customer-approvals`, {
      decision: 'APPROVED', channel: 'PHONE', referenceNo: uniq('APR'), approvedAmount: 100,
    });
    const r = await m().post(`/api/v1/jobs/${job.id}/labor`, { minutes: 30 });
    const cfg = (await m().get('/api/v1/settings')).body.data;
    expect(Number(r.body.data.rate_snapshot)).toBe(Number(cfg.default_labor_rate));
    expect(r.body.data.rate_source).toBe('ORG_DEFAULT');
  });

  it('keeps the price that applied on the day, when the catalogue changes later', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 10, 100);
    await m().post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 1 });
    await m().patch(`/api/v1/parts/${part.id}/price`, { sellPrice: 999, reason: 'Supplier increase' });

    await m().post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60 });
    await m().post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m().post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m().post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    const inv = await m().post(`/api/v1/jobs/${job.id}/invoices`, {});
    expect(Number(inv.body.data.subtotal_parts)).toBe(100);
  });

  it('audits a catalogue price change with both the old and the new value', async () => {
    const { part } = await createStockedPart(manager.token, 1, 50);
    await m().patch(`/api/v1/parts/${part.id}/price`, { sellPrice: 75, reason: 'Annual review' });
    const ev = await query("select * from audit_events where action='PART_PRICE_CHANGED' and entity_id=$1", [part.id]);
    expect(ev.rowCount).toBe(1);
    expect(Number(ev.rows[0].metadata_json.from)).toBe(50);
    expect(Number(ev.rows[0].metadata_json.to)).toBe(75);
  });
});

/* ================================================================ reorder baseline inputs */

describe('the reorder baseline counts stock already on order', () => {
  async function partAtMinimum() {
    const { part, store } = await createStockedPart(manager.token, 2, 80);
    await as(manager.token).patch(`/api/v1/parts/${part.id}/levels`, { minLevel: 5, maxLevel: 40 });
    return { part, store };
  }
  const suggestionFor = async (partId: string) =>
    (await as(manager.token).get('/api/v1/stock/alerts')).body.data.find((x: any) => x.partId === partId);

  it('suggests topping up to the maximum when nothing is on order', async () => {
    const { part } = await partAtMinimum();
    const s = await suggestionFor(part.id);
    expect(s).toBeTruthy();
    expect(s.onOrder).toBe(0);
    expect(s.suggestedReorderQty).toBe(38); // 40 max - 2 available
  });

  it('subtracts open purchase order quantities instead of ordering the same stock twice', async () => {
    const { part } = await partAtMinimum();
    const vendor = (await as(manager.token).get('/api/v1/vendors')).body.data[0];
    const po = (await as(buyer.token).post('/api/v1/purchase-orders', {
      vendorId: vendor.id, lines: [{ partId: part.id, quantity: 30, unitCost: 10 }],
    })).body.data;
    await as(buyer.token).post(`/api/v1/purchase-orders/${po.id}/submit`, {});
    await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });

    const s = await suggestionFor(part.id);
    expect(s.onOrder).toBe(30);
    expect(s.inventoryPosition).toBe(32);
    expect(s.suggestedReorderQty).toBe(8); // 40 - (2 available + 30 already coming)
    expect(s.explanation.features.onOrder).toBe(30);
  });

  it('reports average weekly consumption, which the brief lists as an input', async () => {
    const { part } = await partAtMinimum();
    const s = await suggestionFor(part.id);
    expect(s).toHaveProperty('averageWeeklyConsumption');
    expect(s.explanation.features).toHaveProperty('averageWeeklyConsumption');
    expect(s.explanation.features).toHaveProperty('reserved');
  });

  it('states its version and its explanation so the suggestion is auditable', async () => {
    const { part } = await partAtMinimum();
    const s = await suggestionFor(part.id);
    expect(s.model.version).toBe('min-max-open-po-v2');
    expect(s.explanation.formula).toContain('onOrder');
  });
});

/* ================================================================ weighted average cost */

describe('receiving stock moves the average cost, it does not overwrite it', () => {
  async function receive(partId: string, storeId: string, quantity: number, unitCost: number) {
    const vendor = (await as(manager.token).get('/api/v1/vendors')).body.data[0];
    const po = (await as(buyer.token).post('/api/v1/purchase-orders', {
      vendorId: vendor.id, lines: [{ partId, quantity, unitCost }],
    })).body.data;
    await as(buyer.token).post(`/api/v1/purchase-orders/${po.id}/submit`, {});
    await approveFully(po);
    const full = (await as(manager.token).get(`/api/v1/purchase-orders/${po.id}`)).body.data;
    const grn = (await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId, lines: [{ purchaseOrderLineId: full.lines[0].id, acceptedQty: quantity }],
    })).body.data;
    return { po, grn, accept: () => as(keeper.token).post(`/api/v1/goods-receipts/${grn.id}/accept`, {}) };
  }

  it('computes a weighted average across the quantity already held', async () => {
    const { part, store } = await createStockedPart(manager.token, 0, 200);
    // 10 units at 100 on hand, then 10 more received at 200 -> the average is 150, not 200.
    await as(manager.token).patch(`/api/v1/parts/${part.id}/price`, { sellPrice: 300 });
    await query('update parts set average_cost=100 where id=$1', [part.id]);
    await as(manager.token).post('/api/v1/stock/adjustments', {
      storeId: store.id, partId: part.id, delta: 10, reason: 'Opening balance for weighted cost test',
    });

    const r = await receive(part.id, store.id, 10, 200);
    const accepted = await r.accept();
    expect(accepted.status).toBe(200);

    const after = Number((await query('select average_cost from parts where id=$1', [part.id])).rows[0].average_cost);
    expect(after).toBeCloseTo(150, 2);
    expect(accepted.body.data.costing[0].previousCost).toBeCloseTo(100, 2);
    expect(accepted.body.data.costing[0].newCost).toBeCloseTo(150, 2);
  });

  it('adopts the purchase price when there was no stock to average against', async () => {
    const { part, store } = await createStockedPart(manager.token, 0, 300);
    await query('update parts set average_cost=0 where id=$1', [part.id]);
    const r = await receive(part.id, store.id, 5, 77);
    await r.accept();
    const after = Number((await query('select average_cost from parts where id=$1', [part.id])).rows[0].average_cost);
    expect(after).toBeCloseTo(77, 2);
  });
});

/* ================================================================ over-receipt */

describe('a purchase order cannot be received twice', () => {
  async function approvedPo(quantity: number) {
    const { part, store } = await createStockedPart(manager.token, 0, 100);
    const vendor = (await as(manager.token).get('/api/v1/vendors')).body.data[0];
    const po = (await as(buyer.token).post('/api/v1/purchase-orders', {
      vendorId: vendor.id, lines: [{ partId: part.id, quantity, unitCost: 10 }],
    })).body.data;
    await as(buyer.token).post(`/api/v1/purchase-orders/${po.id}/submit`, {});
    await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    const full = (await as(manager.token).get(`/api/v1/purchase-orders/${po.id}`)).body.data;
    return { po, part, store, lineId: full.lines[0].id };
  }

  it('refuses a second pending receipt for a quantity already committed on the first', async () => {
    const { po, store, lineId } = await approvedPo(10);
    const first = await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId: store.id, lines: [{ purchaseOrderLineId: lineId, acceptedQty: 10 }],
    });
    expect(first.status).toBe(200);

    // The second receipt moves no stock yet, but the first one has already claimed the quantity.
    // Without counting pending receipts both could be accepted, receiving twice what was ordered.
    const second = await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId: store.id, lines: [{ purchaseOrderLineId: lineId, acceptedQty: 10 }],
    });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('OVER_RECEIPT');
    expect(second.body.error.details.pendingOnOtherReceipts).toBe(10);
  });

  it('never receives more than the ordered quantity into stock', async () => {
    const { po, part, store, lineId } = await approvedPo(10);
    const grns = [];
    for (const qty of [6, 4]) {
      const r = await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
        storeId: store.id, lines: [{ purchaseOrderLineId: lineId, acceptedQty: qty }],
      });
      expect(r.status).toBe(200);
      grns.push(r.body.data.id);
    }
    for (const id of grns) expect((await as(keeper.token).post(`/api/v1/goods-receipts/${id}/accept`, {})).status).toBe(200);

    const received = Number((await query('select received_qty from purchase_order_lines where id=$1', [lineId])).rows[0].received_qty);
    expect(received).toBe(10);
    const onHand = Number((await query('select on_hand from stock_balances where store_id=$1 and part_id=$2', [store.id, part.id])).rows[0].on_hand);
    expect(onHand).toBe(10);
    expect((await as(manager.token).get(`/api/v1/purchase-orders/${po.id}`)).body.data.status).toBe('RECEIVED');
  });

  it('refuses the same order line twice inside one receipt', async () => {
    const { po, store, lineId } = await approvedPo(10);
    const r = await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId: store.id,
      lines: [{ purchaseOrderLineId: lineId, acceptedQty: 5 }, { purchaseOrderLineId: lineId, acceptedQty: 5 }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('DUPLICATE_LINE');
  });

  it('keeps the stock ledger reconciled after all of this', async () => {
    const r = await as(manager.token).get('/api/v1/stock/reconciliation');
    expect(r.body.data.balanced).toBe(true);
  });
});
