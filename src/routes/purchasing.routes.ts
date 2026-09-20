import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/index.js';
import { auth, currentUser, orgOf, requirePermission } from '../auth.js';
import { asyncRoute, DomainError, ok, pageParams, uuid } from '../http.js';
import { audit, inScope, nextDocNo, notify, settings } from '../core.js';
import { applyWeightedAverageCost, moveStock } from '../services.js';

export const purchasingRoutes = Router();
purchasingRoutes.use(auth);

purchasingRoutes.get('/vendors', requirePermission('purchase:read', 'purchase:write'), asyncRoute(async (req: any, res: any) => {
  const { page, pageSize, offset } = pageParams(req);
  const params = [orgOf(req), String(req.query.q || '')];
  const where = `organization_id=$1 and ($2='' or name ilike '%'||$2||'%')`;
  const r = await query(`select * from vendors where ${where} order by name limit ${pageSize} offset ${offset}`, params);
  const total = await query(`select count(*) c from vendors where ${where}`, params);
  ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

purchasingRoutes.post('/vendors', requirePermission('purchase:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ name: z.string().min(2), contact: z.string().optional() }).parse(req.body);
  const r = await query('insert into vendors(organization_id,name,contact) values($1,$2,$3) returning *', [orgOf(req), b.name, b.contact ?? null]);
  await audit(req, 'VENDOR_CREATED', 'vendor', r.rows[0].id, { name: b.name });
  ok(res, r.rows[0]);
}));

/** Rule 5: the number of approvals required is derived from the org threshold at creation time. */
purchasingRoutes.post(
  '/purchase-orders',
  requirePermission('purchase:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        vendorId: uuid,
        lines: z.array(z.object({ partId: uuid, quantity: z.number().positive(), unitCost: z.number().nonnegative() })).min(1),
      })
      .parse(req.body);
    const out = await tx(async (c) => {
      const vendor = await c.query('select id from vendors where id=$1 and organization_id=$2', [b.vendorId, orgOf(req)]);
      if (!vendor.rowCount) throw new DomainError('NOT_FOUND', 'Vendor not found', 404);
      for (const l of b.lines) await inScope.part(orgOf(req), l.partId, c);
      const cfg = await settings(orgOf(req), c);
      const total = Math.round(b.lines.reduce((s, x) => s + x.quantity * x.unitCost, 0) * 100) / 100;
      const required = total > Number(cfg.po_approval_threshold)
        ? Number(cfg.po_approvals_required_above)
        : Number(cfg.po_approvals_required_below);
      const poNo = await nextDocNo(c, orgOf(req), 'purchase_orders', 'po_no', 'PO');
      const po = await c.query(
        `insert into purchase_orders(organization_id,po_no,vendor_id,status,total_amount,approvals_required,created_by)
         values($1,$2,$3,'DRAFT',$4,$5,$6) returning *`,
        [orgOf(req), poNo, b.vendorId, total, required, currentUser(req).id]
      );
      for (const l of b.lines)
        await c.query('insert into purchase_order_lines(purchase_order_id,part_id,ordered_qty,unit_cost) values($1,$2,$3,$4)', [
          po.rows[0].id, l.partId, l.quantity, l.unitCost,
        ]);
      await audit(req, 'PO_CREATED', 'purchase_order', po.rows[0].id, { total, approvalsRequired: required, threshold: Number(cfg.po_approval_threshold) }, c);
      return po.rows[0];
    });
    ok(res, out);
  })
);

purchasingRoutes.get('/purchase-orders', requirePermission('purchase:read', 'purchase:write'), asyncRoute(async (req: any, res: any) => {
  const { page, pageSize, offset } = pageParams(req);
  const r = await query(
    `select po.*, v.name vendor_name,
            (select count(*) from purchase_approvals pa where pa.purchase_order_id=po.id and pa.decision='APPROVED') approvals_given
       from purchase_orders po join vendors v on v.id=po.vendor_id
      where po.organization_id=$1 and ($2='' or po.status=$2) order by po.po_no desc, po.id desc limit ${pageSize} offset ${offset}`,
    [orgOf(req), String(req.query.status || '')]
  );
  const total = await query("select count(*) c from purchase_orders where organization_id=$1 and ($2='' or status=$2)", [
    orgOf(req), String(req.query.status || ''),
  ]);
  ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

purchasingRoutes.get('/purchase-orders/:id', requirePermission('purchase:read', 'purchase:write'), asyncRoute(async (req: any, res: any) => {
  const po = await inScope.purchaseOrder(orgOf(req), req.params.id);
  const [lines, approvals, receipts] = await Promise.all([
    query('select pol.*, p.sku, p.name from purchase_order_lines pol join parts p on p.id=pol.part_id where pol.purchase_order_id=$1', [po.id]),
    query('select pa.*, u.display_name approver from purchase_approvals pa left join users u on u.id=pa.approved_by where pa.purchase_order_id=$1 order by pa.approved_at', [po.id]),
    query('select * from goods_receipts where purchase_order_id=$1', [po.id]),
  ]);
  ok(res, { ...po, lines: lines.rows, approvals: approvals.rows, receipts: receipts.rows });
}));

purchasingRoutes.post('/purchase-orders/:id/submit', requirePermission('purchase:write'), asyncRoute(async (req: any, res: any) => {
  const out = await tx(async (c) => {
    const po = await inScope.purchaseOrder(orgOf(req), req.params.id, c, true);
    if (po.status !== 'DRAFT') throw new DomainError('INVALID_STATE', `Only DRAFT orders can be submitted (current: ${po.status})`);
    const r = await c.query("update purchase_orders set status='PENDING_APPROVAL', submitted_at=now(), submitted_by=$1 where id=$2 returning *", [currentUser(req).id, po.id]);
    await audit(req, 'PO_SUBMITTED', 'purchase_order', po.id, { total: Number(po.total_amount), approvalsRequired: po.approvals_required }, c);
    return r.rows[0];
  });
  ok(res, out);
}));

/**
 * Rule 6: separation of duties. The creator/submitter cannot approve their own order and no user
 * may approve the same order twice; both checks run inside the transaction that locks the PO, and a
 * UNIQUE(purchase_order_id, approved_by) constraint backs them at the database level.
 */
purchasingRoutes.post(
  '/purchase-orders/:id/approvals',
  requirePermission('purchase:approve'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().optional() }).parse(req.body);
    const out = await tx(async (c) => {
      const po = await inScope.purchaseOrder(orgOf(req), req.params.id, c, true);
      if (po.status !== 'PENDING_APPROVAL')
        throw new DomainError('INVALID_STATE', `Order is not awaiting approval (current: ${po.status})`);
      if (po.created_by === currentUser(req).id || po.submitted_by === currentUser(req).id)
        throw new DomainError('SEPARATION_OF_DUTIES', 'The requester of a purchase order cannot approve it', 409);
      const dup = await c.query('select 1 from purchase_approvals where purchase_order_id=$1 and approved_by=$2', [po.id, currentUser(req).id]);
      if (dup.rowCount) throw new DomainError('DUPLICATE_APPROVAL', 'This user has already decided on this purchase order', 409);

      const level = (await c.query('select count(*) c from purchase_approvals where purchase_order_id=$1', [po.id])).rows[0].c;
      await c.query('insert into purchase_approvals(purchase_order_id,approval_level,approved_by,decision) values($1,$2,$3,$4)', [
        po.id, Number(level) + 1, currentUser(req).id, b.decision,
      ]);

      if (b.decision === 'REJECTED') {
        const r = await c.query("update purchase_orders set status='REJECTED', decided_at=now(), reject_reason=$1 where id=$2 returning *", [b.note ?? 'Rejected', po.id]);
        await audit(req, 'PO_REJECTED', 'purchase_order', po.id, { note: b.note }, c);
        return { purchaseOrder: r.rows[0], approvalsGiven: Number(level) + 1, approvalsRequired: Number(po.approvals_required) };
      }

      const given = Number((await c.query("select count(*) c from purchase_approvals where purchase_order_id=$1 and decision='APPROVED'", [po.id])).rows[0].c);
      let updated = po;
      if (given >= Number(po.approvals_required)) {
        updated = (await c.query("update purchase_orders set status='APPROVED', decided_at=now() where id=$1 returning *", [po.id])).rows[0];
        await notify(orgOf(req), po.created_by, 'PO_APPROVED', { purchaseOrderId: po.id, poNo: po.po_no }, c);
      }
      await audit(req, 'PO_APPROVAL_RECORDED', 'purchase_order', po.id, { approvalsGiven: given, approvalsRequired: Number(po.approvals_required), finalStatus: updated.status }, c);
      return { purchaseOrder: updated, approvalsGiven: given, approvalsRequired: Number(po.approvals_required) };
    });
    ok(res, out);
  })
);

/** Rule 7: a goods receipt is recorded as PENDING and moves no stock until it is accepted. */
purchasingRoutes.post(
  '/purchase-orders/:id/goods-receipts',
  requirePermission('purchase:receive'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        storeId: uuid,
        lines: z.array(z.object({ purchaseOrderLineId: uuid, acceptedQty: z.number().nonnegative(), rejectedQty: z.number().nonnegative().default(0) })).min(1),
      })
      .parse(req.body);
    const out = await tx(async (c) => {
      const po = await inScope.purchaseOrder(orgOf(req), req.params.id, c, true);
      if (po.status !== 'APPROVED' && po.status !== 'PARTIALLY_RECEIVED')
        throw new DomainError('PO_NOT_APPROVED', 'Goods can only be received against an approved purchase order', 422, { status: po.status });
      await inScope.store(orgOf(req), b.storeId, c);
      const grNo = await nextDocNo(c, orgOf(req), 'goods_receipts', 'gr_no', 'GRN');
      const gr = await c.query(
        `insert into goods_receipts(organization_id,purchase_order_id,store_id,received_by,status,gr_no)
         values($1,$2,$3,$4,'PENDING',$5) returning *`,
        [orgOf(req), po.id, b.storeId, currentUser(req).id, grNo]
      );
      const seen = new Set<string>();
      for (const l of b.lines) {
        if (seen.has(l.purchaseOrderLineId))
          throw new DomainError('DUPLICATE_LINE', 'The same purchase order line appears twice in this receipt', 422);
        seen.add(l.purchaseOrderLineId);
        // FOR UPDATE serialises two receipts recorded against the same line at the same moment.
        const line = await c.query('select * from purchase_order_lines where id=$1 and purchase_order_id=$2 for update', [l.purchaseOrderLineId, po.id]);
        if (!line.rowCount) throw new DomainError('NOT_FOUND', 'Purchase order line not found', 404);
        // Quantities sitting on other PENDING receipts are already committed against this line.
        // Ignoring them allowed two pending receipts for the full quantity to both be accepted,
        // receiving twice what was ordered.
        const pending = Number((await c.query(
          `select coalesce(sum(grl.accepted_qty),0) q
             from goods_receipt_lines grl
             join goods_receipts gr on gr.id = grl.goods_receipt_id
            where grl.purchase_order_line_id=$1 and gr.status='PENDING'`,
          [l.purchaseOrderLineId]
        )).rows[0].q);
        const outstanding = Number(line.rows[0].ordered_qty) - Number(line.rows[0].received_qty) - pending;
        if (l.acceptedQty > outstanding)
          throw new DomainError('OVER_RECEIPT', 'Accepted quantity exceeds the outstanding ordered quantity', 422, {
            outstanding, ordered: Number(line.rows[0].ordered_qty), received: Number(line.rows[0].received_qty), pendingOnOtherReceipts: pending,
          });
        await c.query('insert into goods_receipt_lines(goods_receipt_id,purchase_order_line_id,accepted_qty,rejected_qty,unit_cost) values($1,$2,$3,$4,$5)', [
          gr.rows[0].id, l.purchaseOrderLineId, l.acceptedQty, l.rejectedQty, line.rows[0].unit_cost,
        ]);
      }
      await audit(req, 'GRN_RECORDED', 'goods_receipt', gr.rows[0].id, { poId: po.id, status: 'PENDING', stockMoved: false }, c);
      return gr.rows[0];
    });
    ok(res, out);
  })
);

purchasingRoutes.post(
  '/goods-receipts/:id/accept',
  requirePermission('purchase:receive'),
  asyncRoute(async (req: any, res: any) => {
    const out = await tx(async (c) => {
      const gr = await inScope.goodsReceipt(orgOf(req), req.params.id, c, true);
      if (gr.status !== 'PENDING') throw new DomainError('INVALID_STATE', `Receipt already ${gr.status}`);
      const lines = await c.query(
        `select grl.*, pol.part_id from goods_receipt_lines grl
           join purchase_order_lines pol on pol.id = grl.purchase_order_line_id
          where grl.goods_receipt_id=$1`,
        [gr.id]
      );
      const costing: any[] = [];
      for (const l of lines.rows) {
        if (Number(l.accepted_qty) <= 0) continue;
        // Re-checked at acceptance, not only at recording: the outstanding quantity may have been
        // consumed by another receipt that was accepted in between.
        const poLine = await c.query('select * from purchase_order_lines where id=$1 for update', [l.purchase_order_line_id]);
        const outstanding = Number(poLine.rows[0].ordered_qty) - Number(poLine.rows[0].received_qty);
        if (Number(l.accepted_qty) > outstanding)
          throw new DomainError('OVER_RECEIPT', 'Accepting this receipt would exceed the ordered quantity', 422, {
            outstanding, accepted: Number(l.accepted_qty),
          });
        await moveStock(c, {
          organizationId: orgOf(req), storeId: gr.store_id, partId: l.part_id, delta: Number(l.accepted_qty),
          type: 'RECEIPT', referenceType: 'GOODS_RECEIPT', referenceId: gr.id, unitCost: Number(l.unit_cost),
          userId: currentUser(req).id, allowCreate: true,
        });
        await c.query('update purchase_order_lines set received_qty = received_qty + $1 where id=$2', [l.accepted_qty, l.purchase_order_line_id]);
        // Weighted moving average, not "last price wins" — see applyWeightedAverageCost.
        const costed = await applyWeightedAverageCost(c, l.part_id, Number(l.accepted_qty), Number(l.unit_cost));
        costing.push({ partId: l.part_id, receivedQty: Number(l.accepted_qty), unitCost: Number(l.unit_cost), ...costed });
      }
      const upd = await c.query("update goods_receipts set status='ACCEPTED', accepted_at=now(), accepted_by=$1 where id=$2 returning *", [currentUser(req).id, gr.id]);
      const remaining = await c.query(
        'select coalesce(sum(ordered_qty - received_qty),0) r from purchase_order_lines where purchase_order_id=$1',
        [gr.purchase_order_id]
      );
      await c.query('update purchase_orders set status=$1 where id=$2', [
        Number(remaining.rows[0].r) <= 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED', gr.purchase_order_id,
      ]);
      await audit(req, 'GRN_ACCEPTED', 'goods_receipt', gr.id, { stockMoved: true, lines: lines.rowCount, costing }, c);
      return { ...upd.rows[0], costing };
    });
    ok(res, out);
  })
);

purchasingRoutes.post(
  '/goods-receipts/:id/reject',
  requirePermission('purchase:receive'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ reason: z.string().min(3) }).parse(req.body);
    const out = await tx(async (c) => {
      const gr = await inScope.goodsReceipt(orgOf(req), req.params.id, c, true);
      if (gr.status !== 'PENDING') throw new DomainError('INVALID_STATE', `Receipt already ${gr.status}`);
      const upd = await c.query("update goods_receipts set status='REJECTED' where id=$1 returning *", [gr.id]);
      await audit(req, 'GRN_REJECTED', 'goods_receipt', gr.id, { reason: b.reason, stockMoved: false }, c);
      return upd.rows[0];
    });
    ok(res, out);
  })
);
