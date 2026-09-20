import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db/index.js';
import { auth, currentUser, orgOf, requirePermission } from '../auth.js';
import { asyncRoute, DomainError, ok, pageParams, uuid } from '../http.js';
import { audit, inScope, nextDocNo } from '../core.js';
import { moveStock, reorderSuggestions } from '../services.js';

export const inventoryRoutes = Router();
inventoryRoutes.use(auth);

inventoryRoutes.get(
  '/parts',
  requirePermission('stock:read'),
  asyncRoute(async (req: any, res: any) => {
    const { page, pageSize, offset } = pageParams(req);
    const q = String(req.query.q || '');
    const rows = await query(
      `select p.*, coalesce(sum(sb.on_hand),0) on_hand, coalesce(sum(sb.reserved),0) reserved,
              coalesce(sum(sb.on_hand),0) - coalesce(sum(sb.reserved),0) available
         from parts p left join stock_balances sb on sb.part_id=p.id
        where p.organization_id=$1 and ($2='' or p.sku ilike '%'||$2||'%' or p.name ilike '%'||$2||'%')
        group by p.id order by p.sku limit ${pageSize} offset ${offset}`,
      [orgOf(req), q]
    );
    const total = await query(
      `select count(*) c from parts p where p.organization_id=$1 and ($2='' or p.sku ilike '%'||$2||'%' or p.name ilike '%'||$2||'%')`,
      [orgOf(req), q]
    );
    ok(res, rows.rows, { page, pageSize, total: Number(total.rows[0].c) });
  })
);

inventoryRoutes.post(
  '/parts',
  requirePermission('stock:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        sku: z.string().min(1), name: z.string().min(2), category: z.string().optional(), barcode: z.string().optional(),
        nameAr: z.string().optional(),
        minLevel: z.number().nonnegative().default(0), maxLevel: z.number().nonnegative().default(0),
        averageCost: z.number().nonnegative().default(0),
        // The catalogue selling price. Invoices read this; the price is never sent per issue.
        sellPrice: z.number().nonnegative().default(0),
      })
      .parse(req.body);
    if (b.maxLevel < b.minLevel) throw new DomainError('INVALID_LEVELS', 'maxLevel must be >= minLevel');
    const r = await query(
      'insert into parts(organization_id,sku,name,name_ar,category,barcode,min_level,max_level,average_cost,sell_price) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',
      [orgOf(req), b.sku, b.name, b.nameAr ?? null, b.category ?? null, b.barcode ?? null, b.minLevel, b.maxLevel, b.averageCost, b.sellPrice]
    );
    await audit(req, 'PART_CREATED', 'part', r.rows[0].id, { sku: b.sku, sellPrice: b.sellPrice });
    ok(res, r.rows[0]);
  })
);

inventoryRoutes.patch(
  '/parts/:id/levels',
  requirePermission('stock:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ minLevel: z.number().nonnegative(), maxLevel: z.number().nonnegative() }).parse(req.body);
    if (b.maxLevel < b.minLevel) throw new DomainError('INVALID_LEVELS', 'maxLevel must be >= minLevel');
    await inScope.part(orgOf(req), req.params.id);
    const r = await query('update parts set min_level=$1, max_level=$2 where id=$3 and organization_id=$4 returning *', [
      b.minLevel, b.maxLevel, req.params.id, orgOf(req),
    ]);
    await audit(req, 'PART_LEVELS_CHANGED', 'part', req.params.id, b);
    ok(res, r.rows[0]);
  })
);

/**
 * The only way a selling price changes. It is a catalogue decision with its own permission and its
 * own audit entry, deliberately separate from issuing a part to a job card.
 */
inventoryRoutes.patch(
  '/parts/:id/price',
  requirePermission('stock:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ sellPrice: z.number().nonnegative(), reason: z.string().min(3).optional() }).parse(req.body);
    const part = await inScope.part(orgOf(req), req.params.id);
    const r = await query('update parts set sell_price=$1 where id=$2 and organization_id=$3 returning *', [
      b.sellPrice, part.id, orgOf(req),
    ]);
    await audit(req, 'PART_PRICE_CHANGED', 'part', part.id, {
      from: Number(part.sell_price), to: b.sellPrice, reason: b.reason ?? null,
    });
    ok(res, r.rows[0]);
  })
);

inventoryRoutes.get('/stores', requirePermission('stock:read'), asyncRoute(async (req: any, res: any) => {
  const { page, pageSize, offset } = pageParams(req);
  const r = await query(`select * from stores where organization_id=$1 order by code limit ${pageSize} offset ${offset}`, [orgOf(req)]);
  const total = await query('select count(*) c from stores where organization_id=$1', [orgOf(req)]);
  ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
}));

inventoryRoutes.post('/stores', requirePermission('stock:write'), asyncRoute(async (req: any, res: any) => {
  const b = z.object({ code: z.string().min(1), name: z.string().min(2) }).parse(req.body);
  const r = await query('insert into stores(organization_id,code,name) values($1,$2,$3) returning *', [orgOf(req), b.code, b.name]);
  ok(res, r.rows[0]);
}));

inventoryRoutes.get(
  '/stock/balances',
  requirePermission('stock:read'),
  asyncRoute(async (req: any, res: any) => {
    const { page, pageSize, offset } = pageParams(req);
    const r = await query(
      `select sb.*, p.sku, p.name, s.code store_code, sb.on_hand - sb.reserved available
         from stock_balances sb join parts p on p.id=sb.part_id join stores s on s.id=sb.store_id
        where p.organization_id=$1 and ($2::uuid is null or sb.store_id=$2::uuid)
        order by p.sku limit ${pageSize} offset ${offset}`,
      [orgOf(req), req.query.storeId || null]
    );
    const total = await query(
      `select count(*) c from stock_balances sb join parts p on p.id=sb.part_id
        where p.organization_id=$1 and ($2::uuid is null or sb.store_id=$2::uuid)`,
      [orgOf(req), req.query.storeId || null]
    );
    ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
  })
);

inventoryRoutes.get(
  '/stock/movements',
  requirePermission('stock:read'),
  asyncRoute(async (req: any, res: any) => {
    const { page, pageSize, offset } = pageParams(req);
    const r = await query(
      `select sm.*, p.sku, u.display_name created_by_name
         from stock_movements sm join parts p on p.id=sm.part_id left join users u on u.id=sm.created_by
        where sm.organization_id=$1 and ($2::uuid is null or sm.part_id=$2::uuid)
        order by sm.created_at desc, sm.id desc limit ${pageSize} offset ${offset}`,
      [orgOf(req), req.query.partId || null]
    );
    const total = await query(
      'select count(*) c from stock_movements where organization_id=$1 and ($2::uuid is null or part_id=$2::uuid)',
      [orgOf(req), req.query.partId || null]
    );
    ok(res, r.rows, { page, pageSize, total: Number(total.rows[0].c) });
  })
);

inventoryRoutes.post(
  '/stock/adjustments',
  requirePermission('stock:adjust'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ storeId: uuid, partId: uuid, delta: z.number().refine((n) => n !== 0, 'delta cannot be zero'), reason: z.string().min(5) }).parse(req.body);
    const out = await tx(async (c) => {
      await inScope.store(orgOf(req), b.storeId, c);
      await inScope.part(orgOf(req), b.partId, c);
      const moved = await moveStock(c, {
        organizationId: orgOf(req), storeId: b.storeId, partId: b.partId, delta: b.delta,
        type: 'ADJUSTMENT', reason: b.reason, userId: currentUser(req).id, allowCreate: true,
      });
      const r = await c.query('insert into stock_adjustments(organization_id,store_id,part_id,delta,reason,approved_by) values($1,$2,$3,$4,$5,$6) returning *', [
        orgOf(req), b.storeId, b.partId, b.delta, b.reason, currentUser(req).id,
      ]);
      await audit(req, 'STOCK_ADJUSTED', 'stock_adjustment', r.rows[0].id, { ...b, balanceAfter: moved.balanceAfter }, c);
      return { ...r.rows[0], balanceAfter: moved.balanceAfter };
    });
    ok(res, out);
  })
);

inventoryRoutes.post(
  '/stock/transfers',
  requirePermission('stock:adjust'),
  asyncRoute(async (req: any, res: any) => {
    const b = z.object({ fromStoreId: uuid, toStoreId: uuid, partId: uuid, quantity: z.number().positive(), reason: z.string().min(3) }).parse(req.body);
    if (b.fromStoreId === b.toStoreId) throw new DomainError('INVALID_TRANSFER', 'Source and destination stores must differ');
    const out = await tx(async (c) => {
      await inScope.store(orgOf(req), b.fromStoreId, c);
      await inScope.store(orgOf(req), b.toStoreId, c);
      await inScope.part(orgOf(req), b.partId, c);
      await moveStock(c, { organizationId: orgOf(req), storeId: b.fromStoreId, partId: b.partId, delta: -b.quantity, type: 'TRANSFER_OUT', reason: b.reason, userId: currentUser(req).id });
      const into = await moveStock(c, { organizationId: orgOf(req), storeId: b.toStoreId, partId: b.partId, delta: b.quantity, type: 'TRANSFER_IN', reason: b.reason, userId: currentUser(req).id, allowCreate: true });
      await audit(req, 'STOCK_TRANSFERRED', 'part', b.partId, b, c);
      return { transferred: b.quantity, destinationBalance: into.balanceAfter };
    });
    ok(res, out);
  })
);

inventoryRoutes.get(
  '/stock/alerts',
  requirePermission('stock:read'),
  asyncRoute(async (req: any, res: any) => {
    const rows = await reorderSuggestions(orgOf(req));
    ok(res, rows, { model: rows[0]?.model ?? { key: 'inventory_reorder', version: 'min-max-v1', strategy: 'RULE_BASELINE' } });
  })
);

/* ================================================================ WST-FR-07: compatibility & stock counts */

inventoryRoutes.post(
  '/parts/:id/compatibilities',
  requirePermission('stock:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({ make: z.string().min(1), model: z.string().optional(), yearFrom: z.number().int().optional(), yearTo: z.number().int().optional() })
      .parse(req.body);
    const part = await inScope.part(orgOf(req), req.params.id);
    const r = await query(
      `insert into part_compatibilities(part_id, make, model, year_from, year_to) values($1,$2,$3,$4,$5)
       on conflict do nothing returning *`,
      [part.id, b.make, b.model ?? null, b.yearFrom ?? null, b.yearTo ?? null]
    );
    ok(res, r.rows[0] ?? { part_id: part.id, ...b, note: 'already recorded' });
  })
);

/** Which parts fit a given vehicle — used by the advisor when adding parts to a job card. */
inventoryRoutes.get(
  '/vehicles/:id/compatible-parts',
  requirePermission('stock:read'),
  asyncRoute(async (req: any, res: any) => {
    const vehicle = await inScope.vehicle(orgOf(req), req.params.id);
    const r = await query(
      `select distinct p.id, p.sku, p.name, p.name_ar, p.category, p.average_cost,
              coalesce(sum(sb.on_hand),0) - coalesce(sum(sb.reserved),0) available
         from parts p
         join part_compatibilities pc on pc.part_id = p.id
         left join stock_balances sb on sb.part_id = p.id
        where p.organization_id=$1 and lower(pc.make)=lower($2)
          and (pc.model is null or lower(pc.model)=lower($3))
          and (pc.year_from is null or $4::int is null or $4::int >= pc.year_from)
          and (pc.year_to is null or $4::int is null or $4::int <= pc.year_to)
        group by p.id order by p.sku`,
      [orgOf(req), vehicle.make, vehicle.model, vehicle.year]
    );
    ok(res, r.rows);
  })
);

/** Physical stock count: recorded first, then approved — approval is what writes the ledger. */
inventoryRoutes.post(
  '/stock-counts',
  requirePermission('stock:adjust', 'stock:write'),
  asyncRoute(async (req: any, res: any) => {
    const b = z
      .object({
        storeId: uuid,
        reason: z.string().min(3),
        lines: z.array(z.object({ partId: uuid, countedQty: z.number().nonnegative() })).min(1),
      })
      .parse(req.body);
    const out = await tx(async (c) => {
      await inScope.store(orgOf(req), b.storeId, c);
      const no = await nextDocNo(c, orgOf(req), 'stock_counts', 'count_no', 'SC');
      const sc = await c.query(
        'insert into stock_counts(organization_id,store_id,count_no,counted_by,reason) values($1,$2,$3,$4,$5) returning *',
        [orgOf(req), b.storeId, no, currentUser(req).id, b.reason]
      );
      for (const l of b.lines) {
        await inScope.part(orgOf(req), l.partId, c);
        const bal = await c.query('select on_hand from stock_balances where store_id=$1 and part_id=$2', [b.storeId, l.partId]);
        const systemQty = bal.rowCount ? Number(bal.rows[0].on_hand) : 0;
        await c.query(
          'insert into stock_count_lines(stock_count_id,part_id,system_qty,counted_qty,variance) values($1,$2,$3,$4,$5)',
          [sc.rows[0].id, l.partId, systemQty, l.countedQty, l.countedQty - systemQty]
        );
      }
      await audit(req, 'STOCK_COUNT_RECORDED', 'stock_count', sc.rows[0].id, { storeId: b.storeId, lines: b.lines.length, stockMoved: false }, c);
      return sc.rows[0];
    });
    ok(res, out);
  })
);

inventoryRoutes.get(
  '/stock-counts/:id',
  requirePermission('stock:read'),
  asyncRoute(async (req: any, res: any) => {
    const sc = await query('select * from stock_counts where id=$1 and organization_id=$2', [req.params.id, orgOf(req)]);
    if (!sc.rowCount) throw new DomainError('NOT_FOUND', 'Stock count not found', 404);
    const lines = await query(
      'select scl.*, p.sku, p.name from stock_count_lines scl join parts p on p.id=scl.part_id where scl.stock_count_id=$1',
      [req.params.id]
    );
    ok(res, { ...sc.rows[0], lines: lines.rows });
  })
);

inventoryRoutes.post(
  '/stock-counts/:id/approve',
  requirePermission('stock:adjust'),
  asyncRoute(async (req: any, res: any) => {
    const out = await tx(async (c) => {
      const sc = await c.query("select * from stock_counts where id=$1 and organization_id=$2 and status='OPEN' for update", [req.params.id, orgOf(req)]);
      if (!sc.rowCount) throw new DomainError('INVALID_STATE', 'No open stock count with this id', 422);
      const count = sc.rows[0];
      if (count.counted_by === currentUser(req).id)
        throw new DomainError('SEPARATION_OF_DUTIES', 'The user who counted the stock cannot approve the adjustment', 409);
      const lines = await c.query('select * from stock_count_lines where stock_count_id=$1', [count.id]);
      let adjusted = 0;
      for (const l of lines.rows) {
        if (Number(l.variance) === 0) continue;
        await moveStock(c, {
          organizationId: orgOf(req), storeId: count.store_id, partId: l.part_id, delta: Number(l.variance),
          type: 'COUNT_ADJUSTMENT', referenceType: 'STOCK_COUNT', referenceId: count.id,
          reason: count.reason, userId: currentUser(req).id, allowCreate: true,
        });
        await c.query('insert into stock_adjustments(organization_id,store_id,part_id,delta,reason,approved_by) values($1,$2,$3,$4,$5,$6)', [
          orgOf(req), count.store_id, l.part_id, l.variance, `Stock count ${count.count_no}: ${count.reason}`, currentUser(req).id,
        ]);
        adjusted++;
      }
      const upd = await c.query("update stock_counts set status='APPROVED', approved_by=$1, approved_at=now() where id=$2 returning *", [currentUser(req).id, count.id]);
      await audit(req, 'STOCK_COUNT_APPROVED', 'stock_count', count.id, { adjustedLines: adjusted, stockMoved: true }, c);
      return { ...upd.rows[0], adjustedLines: adjusted };
    });
    ok(res, out);
  })
);

/** Reconciliation proof for WST-FR-07: balance must equal the sum of its ledger movements. */
inventoryRoutes.get(
  '/stock/reconciliation',
  requirePermission('stock:read', 'report:read'),
  asyncRoute(async (req: any, res: any) => {
    const r = await query(
      `select p.sku, s.code store_code, sb.on_hand,
              coalesce((select sum(sm.quantity) from stock_movements sm
                         where sm.part_id=sb.part_id and sm.store_id=sb.store_id),0) ledger_net,
              sb.on_hand - coalesce((select sum(sm.quantity) from stock_movements sm
                         where sm.part_id=sb.part_id and sm.store_id=sb.store_id),0) difference
         from stock_balances sb
         join parts p on p.id=sb.part_id
         join stores s on s.id=sb.store_id
        where p.organization_id=$1
        order by abs(sb.on_hand - coalesce((select sum(sm.quantity) from stock_movements sm
                         where sm.part_id=sb.part_id and sm.store_id=sb.store_id),0)) desc`,
      [orgOf(req)]
    );
    const mismatches = r.rows.filter((x: any) => Number(x.difference) !== 0);
    ok(res, { balanced: mismatches.length === 0, checked: r.rowCount, mismatches });
  })
);
