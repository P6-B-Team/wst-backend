import { describe, it, expect, beforeAll } from 'vitest';
import { api, approvedJob, as, createStockedPart, login, uniq } from './helpers.js';
import { query } from '../src/db/index.js';

let manager: any, storeSup: any, supervisor: any, keeper: any, m: ReturnType<typeof as>;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  storeSup = await login('store.supervisor@wst.local');
  supervisor = await login('supervisor@wst.local');
  keeper = await login('store@wst.local');
  m = as(manager.token);
});

describe('WST-FR-02 — bilingual API contract', () => {
  it('returns Arabic error messages when Accept-Language is ar', async () => {
    const { job } = await approvedJob(manager.token);
    const r = await api()
      .post(`/api/v1/jobs/${job.id}/transitions`)
      .set('Authorization', `Bearer ${manager.token}`)
      .set('Accept-Language', 'ar-EG')
      .send({ toStatus: 'READY' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('JOB_INVALID_TRANSITION');
    expect(r.body.error.message).toMatch(/[\u0600-\u06FF]/); // Arabic script
    expect(r.body.error.messageEn).toMatch(/not allowed|Cannot move/i);
    expect(r.body.meta.locale).toBe('ar');
  });

  it('keeps English as the default locale', async () => {
    const r = await api().get('/api/v1/jobs');
    expect(r.status).toBe(401);
    expect(r.body.error.message).not.toMatch(/[\u0600-\u06FF]/);
  });

  it('publishes the bilingual error catalog for the UI', async () => {
    const r = await m.get('/api/v1/i18n/error-codes');
    expect(r.status).toBe(200);
    expect(r.body.data.CUSTOMER_APPROVAL_REQUIRED.ar).toMatch(/[\u0600-\u06FF]/);
    expect(r.body.meta.locales).toEqual(['en', 'ar']);
  });

  it('stores Arabic names for reference data while keeping SKUs LTR', async () => {
    const r = await m.get('/api/v1/parts?q=SKU-0003');
    const part = r.body.data[0];
    expect(part.sku).toMatch(/^SKU-\d{4}$/); // identifier untouched
    expect(part.name_ar).toMatch(/[\u0600-\u06FF]/);
  });
});

describe('WST-FR-03 — vehicle detail, next service rule and archiving', () => {
  it('returns the complete history and the computed next service rule', async () => {
    const { job, vehicle } = await approvedJob(manager.token);
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 60 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    await m.post(`/api/v1/jobs/${job.id}/invoices`, {});
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'DELIVERED' });

    const r = await m.get(`/api/v1/vehicles/${vehicle.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.serviceHistory[0].job_no).toBe(job.job_no);
    expect(r.body.data.nextServiceRule.intervalKm).toBeGreaterThan(0);
    expect(r.body.data.nextServiceRule.dueDate).toBeTruthy();
    expect(r.body.data.customer).toBeTruthy();
  });

  it('refuses to archive while a job card is open and archives once closed', async () => {
    const { job, vehicle, customer } = await approvedJob(manager.token);
    const blocked = await m.post(`/api/v1/vehicles/${vehicle.id}/archive`, { reason: 'Sold by the customer' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('INVALID_STATE');

    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'CANCELLED' });
    const archived = await m.post(`/api/v1/vehicles/${vehicle.id}/archive`, { reason: 'Sold by the customer' });
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe('ARCHIVED');

    const archivedCustomer = await m.post(`/api/v1/customers/${customer.id}/archive`, { reason: 'Moved away' });
    expect(archivedCustomer.status).toBe(200);
    const list = await m.get(`/api/v1/customers?q=${encodeURIComponent(customer.name)}`);
    expect(list.body.data.some((c: any) => c.id === customer.id)).toBe(false);
    const withArchived = await m.get(`/api/v1/customers?includeArchived=true&q=${encodeURIComponent(customer.name)}`);
    expect(withArchived.body.data.some((c: any) => c.id === customer.id)).toBe(true);
  });
});

describe('WST-FR-04 — work checklist', () => {
  it('blocks quality check until required checklist items are closed', async () => {
    const { job } = await approvedJob(manager.token);
    const items = await m.post(`/api/v1/jobs/${job.id}/work-items`, {
      items: [
        { description: 'Inspect brake discs', descriptionAr: 'فحص الهوبات' },
        { description: 'Road test', required: false },
      ],
    });
    expect(items.status).toBe(200);
    expect(items.body.data).toHaveLength(2);

    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 45 });

    const blocked = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('WORK_ITEMS_INCOMPLETE');

    const done = await m.patch(`/api/v1/work-items/${items.body.data[0].id}`, { status: 'COMPLETED', note: 'Discs within tolerance' });
    expect(done.body.data.completed_by).toBe(manager.user.id);

    const allowed = await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    expect(allowed.status).toBe(200);
  });
});

describe('WST-FR-06 — reservations before issue', () => {
  it('reserves stock, blocks over-reservation and consumes the reservation on issue', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 5);

    const reserved = await m.post(`/api/v1/jobs/${job.id}/parts/reserve`, { partId: part.id, storeId: store.id, quantity: 4 });
    expect(reserved.status).toBe(200);

    const tooMuch = await m.post(`/api/v1/jobs/${job.id}/parts/reserve`, { partId: part.id, storeId: store.id, quantity: 2 });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK'); // only 1 free unit left

    const balance = await query('select on_hand, reserved from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(balance.rows[0].on_hand)).toBe(5); // reservation does not move stock
    expect(Number(balance.rows[0].reserved)).toBe(4);

    const issued = await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 4 });
    expect(issued.status).toBe(200);
    const after = await query('select on_hand, reserved from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(after.rows[0].on_hand)).toBe(1);
    expect(Number(after.rows[0].reserved)).toBe(0);
  });

  it('releases a reservation with a reason and an audit event', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 6);
    const reservation = (await m.post(`/api/v1/jobs/${job.id}/parts/reserve`, { partId: part.id, storeId: store.id, quantity: 3 })).body.data;
    const released = await m.post(`/api/v1/reservations/${reservation.id}/release`, { reason: 'Customer declined the repair' });
    expect(released.body.data.status).toBe('RELEASED');
    const bal = await query('select reserved from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(bal.rows[0].reserved)).toBe(0);
    const ev = await query("select * from audit_events where action='STOCK_RESERVATION_RELEASED' and entity_id=$1", [reservation.id]);
    expect(ev.rowCount).toBe(1);
  });
});

describe('WST-FR-07 — compatibility, stock counts and reconciliation', () => {
  it('finds parts compatible with a vehicle', async () => {
    const { part } = await createStockedPart(manager.token, 5);
    await m.post(`/api/v1/parts/${part.id}/compatibilities`, { make: 'Toyota', model: 'Corolla', yearFrom: 2015, yearTo: 2026 });
    const { vehicle } = await approvedJob(manager.token); // seeded helper creates a Toyota Corolla 2021
    const r = await m.get(`/api/v1/vehicles/${vehicle.id}/compatible-parts`);
    expect(r.status).toBe(200);
    expect(r.body.data.some((p: any) => p.id === part.id)).toBe(true);
  });

  it('records a count without moving stock and adjusts only on approval by a second person', async () => {
    const { part, store } = await createStockedPart(manager.token, 10);
    const count = await as(keeper.token).post('/api/v1/stock-counts', {
      storeId: store.id, reason: 'Quarterly physical count',
      lines: [{ partId: part.id, countedQty: 8 }],
    });
    expect(count.status).toBe(200);
    expect(count.body.data.status).toBe('OPEN');

    const during = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(during.rows[0].on_hand)).toBe(10); // untouched until approved

    const selfApprove = await as(keeper.token).post(`/api/v1/stock-counts/${count.body.data.id}/approve`, {});
    expect(selfApprove.status).toBe(409);
    expect(selfApprove.body.error.code).toBe('SEPARATION_OF_DUTIES');

    const approved = await as(storeSup.token).post(`/api/v1/stock-counts/${count.body.data.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.data.adjustedLines).toBe(1);
    const after = await query('select on_hand from stock_balances where part_id=$1 and store_id=$2', [part.id, store.id]);
    expect(Number(after.rows[0].on_hand)).toBe(8);

    const detail = await m.get(`/api/v1/stock-counts/${count.body.data.id}`);
    expect(Number(detail.body.data.lines[0].variance)).toBe(-2);
  });

  it('proves every balance equals the sum of its ledger movements', async () => {
    const r = await m.get('/api/v1/stock/reconciliation');
    expect(r.status).toBe(200);
    expect(r.body.data.mismatches).toEqual([]);
    expect(r.body.data.balanced).toBe(true);
  });
});

describe('WST-FR-09 / FR-13 — statements, exports and reconciliation', () => {
  it('produces a JSON statement whose lines reconcile to the subtotals, and a PDF', async () => {
    const { job } = await approvedJob(manager.token);
    const { part, store } = await createStockedPart(manager.token, 5);
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'IN_PROGRESS' });
    await m.post(`/api/v1/jobs/${job.id}/labor`, { minutes: 120 });
    await m.post(`/api/v1/jobs/${job.id}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 2 });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'QUALITY_CHECK' });
    await m.post(`/api/v1/jobs/${job.id}/transitions`, { toStatus: 'READY' });
    const inv = (await m.post(`/api/v1/jobs/${job.id}/invoices`, { discount: 50 })).body.data;

    const statement = await m.get(`/api/v1/invoices/${inv.id}/statement`);
    expect(statement.status).toBe(200);
    expect(statement.body.data.reconciliation.linesTotal).toBe(statement.body.data.reconciliation.subtotalsTotal);
    expect(statement.body.data.totals.discount).toBe(50);
    expect(statement.body.data.job.vin).toBeTruthy();

    const pdf = await m.get(`/api/v1/invoices/${inv.id}/statement?format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('serves every export dataset the brief lists, as CSV and PDF', async () => {
    // The auditor is the role that legitimately holds report:read, stock:read and training:read at
    // once. The manager deliberately cannot pull training datasets any more: report:read stopped
    // being a master key when the export guard was tightened.
    const auditor = as((await login('auditor@wst.local')).token);
    for (const dataset of ['jobs', 'invoices', 'stock', 'stock_health', 'turnaround', 'technician_utilization', 'attendance', 'assessments', 'competency', 'certification']) {
      const csv = await auditor.get(`/api/v1/exports/${dataset}`);
      expect(csv.status, `${dataset} csv`).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
    }
    const pdf = await m.get('/api/v1/exports/stock_health?format=pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('reconciles dashboard totals against source transactions', async () => {
    const r = await m.get('/api/v1/dashboards/reconciliation');
    expect(r.status).toBe(200);
    expect(r.body.data.reconciled).toBe(true);
    for (const check of r.body.data.checks) expect(Math.abs(check.difference)).toBeLessThan(0.01);
  });
});

describe('WST-FR-12 — QR verifiable certificate', () => {
  it('renders a QR code that encodes the public verification URL', async () => {
    const cert = await query("select id from certificates where public_token_hash = encode(sha256('wst-demo-certificate-token'::bytea),'hex') limit 1");
    expect(cert.rowCount).toBe(1);
    const svg = await as(supervisor.token).get(`/api/v1/certificates/${cert.rows[0].id}/qr?token=wst-demo-certificate-token`);
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(String(svg.text ?? svg.body)).toContain('<svg');

    const png = await as(supervisor.token).get(`/api/v1/certificates/${cert.rows[0].id}/qr?token=wst-demo-certificate-token&format=png`);
    expect(png.body.data.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(png.body.data.verifyUrl).toContain('/certificates/verify/wst-demo-certificate-token');

    const wrongToken = await as(supervisor.token).get(`/api/v1/certificates/${cert.rows[0].id}/qr?token=not-the-token`);
    expect(wrongToken.status).toBe(400);
  });
});

describe('WST-FR-14 / scenario 8 — advisory predictions with override and fallback', () => {
  it('reports that the rule baseline was used when no AI service is configured', async () => {
    const r = await m.get('/api/v1/predictions/reorder');
    expect(r.status).toBe(200);
    expect(r.body.meta.fallbackUsed).toBe(true);
    expect(r.body.meta.source).toBe('RULE_BASELINE');
    expect(r.body.meta.model.version).toBe('min-max-v1');
  });

  it('records the human decision, override value and evaluation outcome', async () => {
    await m.post('/api/v1/predictions/reorder/runs', {});
    const runs = await m.get('/api/v1/predictions/reorder/runs');
    expect(runs.body.data.length).toBeGreaterThan(0);
    const run = runs.body.data[0];

    const missingValue = await m.post(`/api/v1/predictions/runs/${run.id}/decision`, { decision: 'OVERRIDDEN' });
    expect(missingValue.status).toBe(400);

    const decided = await m.post(`/api/v1/predictions/runs/${run.id}/decision`, {
      decision: 'OVERRIDDEN', overrideValue: 5, note: 'Vendor minimum order is 5', outcome: { orderedQty: 5 },
    });
    expect(decided.status).toBe(200);
    expect(decided.body.data.decision).toBe('OVERRIDDEN');
    expect(Number(decided.body.data.override_value)).toBe(5);

    const ev = await query("select * from audit_events where action='PREDICTION_DECIDED' and entity_id=$1", [run.id]);
    expect(ev.rowCount).toBe(1);

    const evaluation = await m.get('/api/v1/predictions/evaluation');
    const row = evaluation.body.data.find((x: any) => x.model_key === 'inventory_reorder');
    expect(row.overridden).toBeGreaterThan(0);
    expect(row.overrideRate).toBeGreaterThan(0);
    expect(row.fallback_runs).toBeGreaterThan(0);
  });

  it('does not place any order automatically when stock falls below minimum', async () => {
    const { part } = await createStockedPart(manager.token, 0);
    await m.patch(`/api/v1/parts/${part.id}/levels`, { minLevel: 5, maxLevel: 20 });
    const alerts = await m.get('/api/v1/stock/alerts');
    expect(alerts.body.data.some((a: any) => a.partId === part.id)).toBe(true);
    const pos = await query("select count(*) c from purchase_orders po join purchase_order_lines pol on pol.purchase_order_id=po.id where pol.part_id=$1", [part.id]);
    expect(Number(pos.rows[0].c)).toBe(0); // suggestion only, never an automatic order
  });
});

describe('Acceptance scenario 1 — seeded data volumes', () => {
  it('meets every quantity the brief specifies', async () => {
    const org = '00000000-0000-0000-0000-000000000001';
    const counts = await query(
      `select (select count(*) from customers where organization_id=$1) customers,
              (select count(*) from vehicles where organization_id=$1) vehicles,
              (select count(*) from parts where organization_id=$1) parts,
              (select count(*) from stores where organization_id=$1) stores,
              (select count(*) from bays where organization_id=$1) bays,
              (select count(distinct u.id) from users u join user_roles ur on ur.user_id=u.id
                 join roles r on r.id=ur.role_id
                where u.organization_id=$1 and r.code in ('TECHNICIAN','MENTOR')) technicians_mentors,
              (select count(*) from students where organization_id=$1) students,
              (select count(*) from training_sessions
                where organization_id=$1
                  and title in ('Brakes practical — week 1', 'Brakes practical — week 2',
                                 'Diagnostics practical', 'Safety induction')) sessions`,
      [org]
    );
    const c = counts.rows[0];
    // "Seed at least 20 customers, 30 vehicles, 100 parts, two stores, four bays, eight
    // technicians/mentors, 40 students, and four training sessions." The counts below are
    // lower bounds for everything the PDF phrases as a minimum floor for a growing catalog.
    expect(Number(c.customers)).toBeGreaterThanOrEqual(20);
    expect(Number(c.vehicles)).toBeGreaterThanOrEqual(30);
    expect(Number(c.parts)).toBeGreaterThanOrEqual(100);
    expect(Number(c.stores)).toBeGreaterThanOrEqual(2);
    expect(Number(c.bays)).toBeGreaterThanOrEqual(4);
    expect(Number(c.technicians_mentors)).toBeGreaterThanOrEqual(8);
    expect(Number(c.students)).toBeGreaterThanOrEqual(40);
    // Training sessions is seeded to match the official number exactly (4), not "at least 4": the
    // scenario's own conflict-detection story only makes sense against a fixed, known calendar, and
    // the certification cohort is demonstrated on one of these four rather than adding a fifth.
    expect(Number(c.sessions)).toBe(4);
  });
});
