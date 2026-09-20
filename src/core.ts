import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { query } from './db/index.js';
import { currentUser, orgOf } from './auth.js';
import { notFound } from './http.js';

type Q = { query: (text: string, params?: any[]) => Promise<any> };
const runner = (c?: Q): Q => c ?? { query: (t, p) => query(t, p) };

/** Writes an immutable audit event. Every sensitive mutation calls this inside its transaction. */
export async function audit(
  req: Request,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: any = {},
  client?: PoolClient
) {
  await runner(client as any).query(
    `insert into audit_events(organization_id, actor_id, action, entity_type, entity_id, request_id, metadata_json)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [orgOf(req), currentUser(req).id, action, entityType, entityId, (req as any).requestId ?? null, JSON.stringify(metadata)]
  );
}

export async function notify(
  organizationId: string,
  recipientId: string | null,
  topic: string,
  payload: any,
  client?: PoolClient
) {
  await runner(client as any).query(
    `insert into notifications(organization_id, recipient_id, topic, payload_json) values($1,$2,$3,$4)`,
    [organizationId, recipientId, topic, JSON.stringify(payload)]
  );
}

export async function settings(organizationId: string, client?: PoolClient) {
  const c = runner(client as any);
  const r = await c.query('select * from org_settings where organization_id=$1', [organizationId]);
  if (r.rowCount) return r.rows[0];
  const ins = await c.query('insert into org_settings(organization_id) values($1) returning *', [organizationId]);
  return ins.rows[0];
}

/**
 * Row-level scope guard. Any row reached through a child table (labor, assessments, invoice lines,
 * stock rows...) must be proven to belong to the caller's organisation before it is touched.
 */
export async function scoped(
  organizationId: string,
  sql: string,
  params: any[],
  label: string,
  client?: PoolClient
) {
  const r = await runner(client as any).query(sql, [...params, organizationId]);
  if (!r.rowCount) throw notFound(label);
  return r.rows[0];
}

export const inScope = {
  job: (org: string, id: string, c?: PoolClient, lock = false) =>
    scoped(org, `select * from job_cards where id=$1 and organization_id=$2${lock ? ' for update' : ''}`, [id], 'Job card', c),
  jobPart: (org: string, id: string, c?: PoolClient, lock = false) =>
    scoped(
      org,
      `select jp.* from job_parts jp join job_cards j on j.id = jp.job_card_id
        where jp.id=$1 and j.organization_id=$2${lock ? ' for update of jp' : ''}`,
      [id],
      'Issued part',
      c
    ),
  invoice: (org: string, id: string, c?: PoolClient) =>
    scoped(org, 'select * from invoices where id=$1 and organization_id=$2', [id], 'Invoice', c),
  purchaseOrder: (org: string, id: string, c?: PoolClient, lock = false) =>
    scoped(org, `select * from purchase_orders where id=$1 and organization_id=$2${lock ? ' for update' : ''}`, [id], 'Purchase order', c),
  session: (org: string, id: string, c?: PoolClient, lock = false) =>
    scoped(org, `select * from training_sessions where id=$1 and organization_id=$2${lock ? ' for update' : ''}`, [id], 'Training session', c),
  assessment: (org: string, id: string, c?: PoolClient, lock = false) =>
    scoped(
      org,
      `select a.* from assessments a
         join training_sessions ts on ts.id = a.session_id
        where a.id=$1 and ts.organization_id=$2${lock ? ' for update of a' : ''}`,
      [id],
      'Assessment',
      c
    ),
  student: (org: string, id: string, c?: PoolClient) =>
    scoped(org, 'select * from students where id=$1 and organization_id=$2', [id], 'Student', c),
  vehicle: (org: string, id: string, c?: PoolClient) =>
    scoped(org, 'select * from vehicles where id=$1 and organization_id=$2', [id], 'Vehicle', c),
  store: (org: string, id: string, c?: PoolClient) =>
    scoped(org, 'select * from stores where id=$1 and organization_id=$2', [id], 'Store', c),
  part: (org: string, id: string, c?: PoolClient) =>
    scoped(org, 'select * from parts where id=$1 and organization_id=$2', [id], 'Part', c),
  goodsReceipt: (org: string, id: string, c?: PoolClient, lock = false) =>
    scoped(org, `select * from goods_receipts where id=$1 and organization_id=$2${lock ? ' for update' : ''}`, [id], 'Goods receipt', c),
  course: (org: string, id: string, c?: PoolClient) =>
    scoped(org, 'select * from courses where id=$1 and organization_id=$2', [id], 'Course', c),
};

/** Human readable document numbers, generated inside the caller's transaction. */
export async function nextDocNo(c: PoolClient, organizationId: string, _table: string, _column: string, prefix: string) {
  const r = await c.query(
    `insert into doc_counters(organization_id, doc_type, value) values($1,$2,1)
     on conflict(organization_id, doc_type) do update set value = doc_counters.value + 1
     returning value`,
    [organizationId, prefix]
  );
  return `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(r.rows[0].value).padStart(5, '0')}`;
}

export const scopeOf = orgOf;
export const actor = currentUser;
