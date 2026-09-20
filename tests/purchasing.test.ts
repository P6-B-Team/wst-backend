import { describe, it, expect, beforeAll } from 'vitest';
import { as, createStockedPart, login } from './helpers.js';
import { query } from '../src/db/index.js';

let manager: any, buyer: any, approver1: any, approver2: any, keeper: any;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  buyer = await login('buyer@wst.local');
  approver1 = await login('approver1@wst.local');
  approver2 = await login('approver2@wst.local');
  keeper = await login('store@wst.local');
});

async function draftPo(unitCost: number, quantity = 1) {
  const { part, store } = await createStockedPart(manager.token, 0);
  const vendor = (await as(manager.token).get('/api/v1/vendors')).body.data[0];
  const po = (await as(buyer.token).post('/api/v1/purchase-orders', {
    vendorId: vendor.id, lines: [{ partId: part.id, quantity, unitCost }],
  })).body.data;
  await as(buyer.token).post(`/api/v1/purchase-orders/${po.id}/submit`, {});
  return { po, part, store };
}

describe('purchase approval thresholds', () => {
  it('needs a single approval below the threshold', async () => {
    const { po } = await draftPo(100); // total 100, threshold 1000
    expect(po.approvals_required).toBe(1);
    const r = await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    expect(r.status).toBe(200);
    expect(r.body.data.purchaseOrder.status).toBe('APPROVED');
  });

  it('needs two approvals above the threshold and stays pending after the first', async () => {
    const { po } = await draftPo(5000); // total 5000 > 1000
    expect(po.approvals_required).toBe(2);

    const first = await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    expect(first.status).toBe(200);
    expect(first.body.data.purchaseOrder.status).toBe('PENDING_APPROVAL');
    expect(first.body.data.approvalsGiven).toBe(1);

    const second = await as(approver2.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    expect(second.body.data.purchaseOrder.status).toBe('APPROVED');
  });

  it('refuses a duplicate approval from the same user', async () => {
    const { po } = await draftPo(5000);
    await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    const again = await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_APPROVAL');
    const count = await query("select count(*) c from purchase_approvals where purchase_order_id=$1 and decision='APPROVED'", [po.id]);
    expect(Number(count.rows[0].c)).toBe(1);
  });

  it('refuses the requester approving their own purchase order', async () => {
    const vendor = (await as(manager.token).get('/api/v1/vendors')).body.data[0];
    const { part } = await createStockedPart(manager.token, 0);
    const po = (await as(manager.token).post('/api/v1/purchase-orders', {
      vendorId: vendor.id, lines: [{ partId: part.id, quantity: 1, unitCost: 100 }],
    })).body.data;
    await as(manager.token).post(`/api/v1/purchase-orders/${po.id}/submit`, {});
    const r = await as(manager.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('refuses approval on a draft that was never submitted', async () => {
    const vendor = (await as(manager.token).get('/api/v1/vendors')).body.data[0];
    const { part } = await createStockedPart(manager.token, 0);
    const po = (await as(buyer.token).post('/api/v1/purchase-orders', {
      vendorId: vendor.id, lines: [{ partId: part.id, quantity: 1, unitCost: 100 }],
    })).body.data;
    const r = await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    expect(r.body.error.code).toBe('INVALID_STATE');
  });
});

describe('goods receipts', () => {
  it('does not move stock until the receipt is accepted', async () => {
    const { po, part, store } = await draftPo(200, 10);
    await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    await as(approver2.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });

    const detail = await as(buyer.token).get(`/api/v1/purchase-orders/${po.id}`);
    const line = detail.body.data.lines[0];

    const before = await query('select coalesce(sum(on_hand),0) q from stock_balances where part_id=$1', [part.id]);
    const grn = await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId: store.id, lines: [{ purchaseOrderLineId: line.id, acceptedQty: 10, rejectedQty: 0 }],
    });
    expect(grn.status).toBe(200);
    expect(grn.body.data.status).toBe('PENDING');

    const during = await query('select coalesce(sum(on_hand),0) q from stock_balances where part_id=$1', [part.id]);
    expect(Number(during.rows[0].q)).toBe(Number(before.rows[0].q)); // still untouched

    const accepted = await as(keeper.token).post(`/api/v1/goods-receipts/${grn.body.data.id}/accept`, {});
    expect(accepted.status).toBe(200);
    const after = await query('select coalesce(sum(on_hand),0) q from stock_balances where part_id=$1', [part.id]);
    expect(Number(after.rows[0].q)).toBe(Number(before.rows[0].q) + 10);

    const poAfter = await as(buyer.token).get(`/api/v1/purchase-orders/${po.id}`);
    expect(poAfter.body.data.status).toBe('RECEIVED');
  });

  it('leaves stock untouched when the receipt is rejected', async () => {
    const { po, part, store } = await draftPo(200, 5);
    await as(approver1.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    await as(approver2.token).post(`/api/v1/purchase-orders/${po.id}/approvals`, { decision: 'APPROVED' });
    const line = (await as(buyer.token).get(`/api/v1/purchase-orders/${po.id}`)).body.data.lines[0];
    const grn = (await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId: store.id, lines: [{ purchaseOrderLineId: line.id, acceptedQty: 5 }],
    })).body.data;

    const rejected = await as(keeper.token).post(`/api/v1/goods-receipts/${grn.id}/reject`, { reason: 'Damaged packaging' });
    expect(rejected.body.data.status).toBe('REJECTED');
    const after = await query('select coalesce(sum(on_hand),0) q from stock_balances where part_id=$1', [part.id]);
    expect(Number(after.rows[0].q)).toBe(0);
  });

  it('refuses receiving against an unapproved purchase order', async () => {
    const { po, store } = await draftPo(5000, 2);
    const line = (await as(buyer.token).get(`/api/v1/purchase-orders/${po.id}`)).body.data.lines[0];
    const r = await as(keeper.token).post(`/api/v1/purchase-orders/${po.id}/goods-receipts`, {
      storeId: store.id, lines: [{ purchaseOrderLineId: line.id, acceptedQty: 2 }],
    });
    expect(r.body.error.code).toBe('PO_NOT_APPROVED');
  });
});
