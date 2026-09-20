/**
 * Smoke test. Boots the API on an ephemeral port (or targets BASE_URL if provided) and walks a
 * complete acceptance path over real HTTP: login, open a job, approve, work, issue a part, invoice,
 * deliver, verify a certificate, read a dashboard. Exits non-zero on the first failure.
 */
import app from '../src/app.js';
import { pool } from '../src/db/pool.js';

const results: { name: string; ok: boolean; detail?: string }[] = [];
let base = process.env.BASE_URL || '';
let server: any;

const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`  ✗ ${name} — ${e.message}`);
  }
};

const assert = (cond: any, msg: string) => {
  if (!cond) throw new Error(msg);
};

async function call(method: string, path: string, body?: any, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* CSV or plain text */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  if (!base) {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  console.log(`Smoke testing ${base}\n`);

  let token = '';
  let jobId = '';
  let invoiceTotal = 0;

  await check('health/live responds', async () => {
    const r = await call('GET', '/health/live');
    assert(r.status === 200 && r.body.status === 'ok', `got ${r.status}`);
  });

  await check('health/ready reaches the database', async () => {
    const r = await call('GET', '/health/ready');
    assert(r.status === 200 && r.body.status === 'ready', `got ${r.status}`);
  });

  await check('OpenAPI document is served', async () => {
    const r = await call('GET', '/openapi.json');
    assert(r.status === 200 && Object.keys(r.body.paths).length > 50, `only ${Object.keys(r.body?.paths ?? {}).length} paths`);
  });

  await check('login returns an access and refresh token', async () => {
    const r = await call('POST', '/api/v1/auth/login', { email: 'manager@wst.local', password: 'Password123!' });
    assert(r.status === 200, `got ${r.status}`);
    assert(r.body.data.accessToken && r.body.data.refreshToken, 'missing tokens');
    token = r.body.data.accessToken;
  });

  await check('unauthenticated request is rejected', async () => {
    const r = await call('GET', '/api/v1/jobs');
    assert(r.status === 401, `got ${r.status}`);
  });

  await check('customer and vehicle can be created', async () => {
    const c = await call('POST', '/api/v1/customers', { name: uniq('Smoke Customer'), phone: '01000000000' }, token);
    assert(c.status === 200, `customer ${c.status}`);
    const v = await call('POST', `/api/v1/customers/${c.body.data.id}/vehicles`, {
      plateNo: uniq('SM').slice(0, 14), vin: uniq('VIN'), make: 'Toyota', model: 'Corolla', year: 2022, mileage: 30000,
    }, token);
    assert(v.status === 201, `vehicle ${v.status}`);
    const j = await call('POST', '/api/v1/jobs', {
      customerId: c.body.data.id, vehicleId: v.body.data.id, complaint: 'Smoke test complaint',
      serviceType: 'GENERAL', receivedMileage: 30500,
    }, token);
    assert(j.status === 201 && j.body.data.status === 'RECEIVED', `job ${j.status}`);
    jobId = j.body.data.id;
  });

  await check('work cannot start before customer approval', async () => {
    const r = await call('POST', `/api/v1/jobs/${jobId}/transitions`, { toStatus: 'IN_PROGRESS' }, token);
    assert(r.status === 422 && r.body.error.code === 'CUSTOMER_APPROVAL_REQUIRED', `got ${r.status} ${r.body?.error?.code}`);
  });

  await check('approved job moves through the lifecycle', async () => {
    await call('POST', `/api/v1/jobs/${jobId}/customer-approvals`, { decision: 'APPROVED', channel: 'PHONE', referenceNo: uniq('APR') }, token);
    const start = await call('POST', `/api/v1/jobs/${jobId}/transitions`, { toStatus: 'IN_PROGRESS' }, token);
    assert(start.status === 200, `in progress ${start.status}`);
    await call('POST', `/api/v1/jobs/${jobId}/labor`, { minutes: 90 }, token);
    const qc = await call('POST', `/api/v1/jobs/${jobId}/transitions`, { toStatus: 'QUALITY_CHECK' }, token);
    assert(qc.status === 200, `quality check ${qc.status}`);
    const ready = await call('POST', `/api/v1/jobs/${jobId}/transitions`, { toStatus: 'READY' }, token);
    assert(ready.status === 200, `ready ${ready.status}`);
  });

  await check('a part can be issued and the stock ledger reflects it', async () => {
    const parts = await call('GET', '/api/v1/parts?q=SKU-0020', undefined, token);
    const stores = await call('GET', '/api/v1/stores', undefined, token);
    const part = parts.body.data[0];
    const store = stores.body.data.find((s: any) => s.code === 'MAIN');
    // compare against the MAIN-store balance, not the catalog total across all stores
    const balances = await call('GET', `/api/v1/stock/balances?storeId=${store.id}`, undefined, token);
    const before = Number(balances.body.data.find((b: any) => b.part_id === part.id).on_hand);
    const issue = await call('POST', `/api/v1/jobs/${jobId}/parts/issue`, { partId: part.id, storeId: store.id, quantity: 1 }, token);
    assert(issue.status === 200, `issue ${issue.status} ${JSON.stringify(issue.body?.error)}`);
    assert(issue.body.data.balanceAfter === before - 1, `balance ${issue.body.data.balanceAfter} expected ${before - 1}`);
  });

  await check('invoice is computed from labor and issued parts', async () => {
    const r = await call('POST', `/api/v1/jobs/${jobId}/invoices`, {}, token);
    assert(r.status === 200, `invoice ${r.status} ${JSON.stringify(r.body?.error)}`);
    const labor = Number(r.body.data.subtotal_labor);
    const parts = Number(r.body.data.subtotal_parts);
    // Neither the hourly rate nor the part price was sent by this script: both are resolved by the
    // server from the rate table and the parts catalogue. The expected totals are therefore read
    // back from those stored source rows, which is exactly the rule being smoke-tested.
    const detail = await call('GET', `/api/v1/jobs/${jobId}`, undefined, token);
    const expectedLabor = detail.body.data.labor.reduce(
      (sum: number, l: any) => sum + (Number(l.minutes) / 60) * Number(l.rate_snapshot), 0
    );
    const expectedParts = detail.body.data.parts.reduce(
      (sum: number, p: any) => sum + (Number(p.quantity) - Number(p.reversed_qty)) * Number(p.unit_price_snapshot), 0
    );
    assert(Math.abs(labor - expectedLabor) < 0.01, `labor ${labor} expected ${expectedLabor} from logged labour`);
    assert(Math.abs(parts - expectedParts) < 0.01, `parts ${parts} expected ${expectedParts} from issued parts`);
    assert(labor > 0 && parts > 0, 'invoice must be built from real source rows');
    invoiceTotal = Number(r.body.data.total_amount);
    assert(Math.abs(invoiceTotal - (labor + parts) * 1.14) < 0.01, `total ${invoiceTotal}`);
  });

  await check('delivery is allowed once the invoice exists', async () => {
    const r = await call('POST', `/api/v1/jobs/${jobId}/transitions`, { toStatus: 'DELIVERED' }, token);
    assert(r.status === 200 && r.body.data.status === 'DELIVERED', `got ${r.status}`);
  });

  await check('audit trail captured the sensitive operations', async () => {
    const r = await call('GET', '/api/v1/audit-events?pageSize=50', undefined, token);
    assert(r.status === 200, `got ${r.status}`);
    const actions = r.body.data.map((e: any) => e.action);
    for (const expected of ['JOB_CREATED', 'JOB_TRANSITION', 'INVOICE_ISSUED'])
      assert(actions.includes(expected), `missing ${expected} in recent audit events`);
  });

  await check('seeded certificate verifies publicly without a token', async () => {
    const r = await call('GET', '/api/v1/certificates/verify/wst-demo-certificate-token');
    assert(r.status === 200, `got ${r.status}`);
    assert(r.body.data.valid === true, 'certificate not valid');
    assert(!('fullName' in r.body.data), 'verification leaks student name');
  });

  await check('dashboards and exports respond', async () => {
    for (const path of ['/api/v1/dashboards/workshop', '/api/v1/dashboards/inventory', '/api/v1/dashboards/finance', '/api/v1/dashboards/training']) {
      const r = await call('GET', path, undefined, token);
      assert(r.status === 200, `${path} -> ${r.status}`);
    }
    const csv = await call('GET', '/api/v1/exports/jobs', undefined, token);
    assert(csv.status === 200 && csv.text.split('\n')[0].includes('job_no'), 'jobs export malformed');
  });

  await check('bilingual error contract responds in Arabic', async () => {
    const res = await fetch(`${base}/api/v1/jobs`, { headers: { 'Accept-Language': 'ar' } });
    const body: any = await res.json();
    assert(res.status === 401, `got ${res.status}`);
    assert(/[\u0600-\u06FF]/.test(body.error.message), 'Arabic message missing');
  });

  await check('stock ledger reconciles to balances', async () => {
    const r = await call('GET', '/api/v1/stock/reconciliation', undefined, token);
    assert(r.status === 200, `got ${r.status}`);
    assert(r.body.data.balanced === true, `${r.body.data.mismatches?.length} mismatched balances`);
  });

  await check('dashboard totals reconcile to source transactions', async () => {
    const r = await call('GET', '/api/v1/dashboards/reconciliation', undefined, token);
    assert(r.status === 200 && r.body.data.reconciled === true, 'dashboards do not reconcile');
  });

  await check('seeded certificate exposes a QR code', async () => {
    const list = await call('GET', '/api/v1/certificates', undefined, token);
    assert(list.status === 200 && list.body.data.length > 0, 'no certificates seeded');
    const demo = list.body.data.find((c: any) => c.student_no === 'S-001') ?? list.body.data[0];
    const id = demo.id;
    const qr = await fetch(`${base}/api/v1/certificates/${id}/qr?token=wst-demo-certificate-token`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const svg = await qr.text();
    assert(qr.status === 200 && svg.includes('<svg'), `QR not rendered (${qr.status})`);
  });

  await check('reorder baseline returns explainable suggestions', async () => {
    const r = await call('GET', '/api/v1/stock/alerts', undefined, token);
    assert(r.status === 200, `got ${r.status}`);
    if (r.body.data.length) {
      assert(r.body.data[0].explanation?.features, 'suggestion is not explainable');
      assert(r.body.data[0].model?.version, 'suggestion is not versioned');
    }
  });

  await check('predictions declare the non-AI fallback when no model is configured', async () => {
    const r = await call('GET', '/api/v1/predictions/training-risk', undefined, token);
    assert(r.status === 200, `got ${r.status}`);
    assert(r.body.meta.fallbackUsed === true && r.body.meta.source === 'RULE_BASELINE', 'fallback state not reported');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
  if (server) server.close();
  await pool.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  if (server) server.close();
  await pool.end();
  process.exit(1);
});
