# WST Backend — Workshop Management & Student Practical Training

Standalone REST backend for Project 6. It runs, migrates, seeds and tests itself with no frontend
and no other team member's work in place. Every business rule listed in the brief is enforced
server side; the UI cannot bypass any of them.

- **Stack:** Node 22, TypeScript, Express 4, PostgreSQL 16, Zod, JWT, Vitest + Supertest
- **API base:** `http://localhost:4000/api/v1`
- **Interactive docs:** `http://localhost:4000/docs` — raw spec at `/openapi.json`

---

## 1. Quick start

### Local

```bash
cp .env.example .env
npm install
npm run db:migrate      # applies 001..003
npm run db:seed         # base data + acceptance scenario data
npm run dev             # http://localhost:4000
```

### Docker

```bash
cp .env.example .env
docker compose up --build
```

The container runs migrations, both seeds and then the API. A healthcheck polls `/health/ready`.

### Verify everything

```bash
npm run verify          # build + full test suite + smoke test
```

Individual commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run db:migrate` | Apply pending SQL migrations (idempotent) |
| `npm run db:seed` | Base RBAC/master data **and** the acceptance scenario dataset |
| `npm run db:seed:base` / `db:seed:scenarios` | Run either seed on its own |
| `npm run db:reset` | Drop and rebuild the schema, then migrate and seed (blocked in production) |
| `npm test` | 217 integration tests against a real PostgreSQL |
| `npm run smoke` | 20 end-to-end HTTP checks on a booted server |
| `npm run audit` | Dependency vulnerability scan (common-pack NFR) |

---

## 2. Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` disables `db:reset` |
| `PORT` | `4000` | HTTP port |
| `DATABASE_URL` | `postgres://wst:wst@localhost:5432/wst` | PostgreSQL connection string |
| `PG_POOL_MAX` | `20` | Connection pool size |
| `JWT_ACCESS_SECRET` | `dev-access-secret` | **Change in production** |
| `JWT_REFRESH_SECRET` | `dev-refresh-secret` | Reserved for future asymmetric rotation |
| `ACCESS_TOKEN_TTL` | `15m` | Access token lifetime |
| `REFRESH_TOKEN_TTL` | `7d` | Refresh token lifetime |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma separated allowed origins |
| `PUBLIC_URL` | `http://localhost:4000` | Server URL in the OpenAPI document and inside certificate QR codes |
| `RATE_LIMIT_AUTH` / `RATE_LIMIT_API` | `30` / `600` | Requests per minute per IP (auth vs the rest); disabled automatically under `NODE_ENV=test` |
| `AI_SERVICE_URL` | empty | Optional model service. Empty means the deterministic baselines are used and responses report `fallbackUsed: true` |
| `AI_TIMEOUT_MS` | `1500` | Model call timeout before falling back to the baseline |

Tax rate, purchase approval thresholds, reminder intervals and certification minimums are **not**
environment variables — they live in the `org_settings` table per organization and are editable
through `GET/PATCH /api/v1/settings`.

---

## 3. Seeded accounts

Password for every account: `Password123!`

| Email | Role | Notable permissions |
| --- | --- | --- |
| `manager@wst.local` | WORKSHOP_MANAGER | Broad workshop + finance + admin |
| `advisor@wst.local` | SERVICE_ADVISOR | Job intake, customer approval, invoicing |
| `tech@wst.local` | TECHNICIAN | Labor, transitions, issue parts to a job |
| `qc@wst.local` | QUALITY_CHECKER | Quality transitions |
| `store@wst.local` | STOREKEEPER | Issue, adjust, receive |
| `store.supervisor@wst.local` | STORE_SUPERVISOR | **Reversal authorisation** |
| `buyer@wst.local` | PROCUREMENT | Create and submit purchase orders |
| `approver1@wst.local`, `approver2@wst.local` | PROCUREMENT_APPROVER | Approve purchase orders |
| `supervisor@wst.local` | TRAINING_SUPERVISOR | Sign-off, certificates |
| `mentor@wst.local` | MENTOR | Attendance, assessments, create draft training sessions |
| `auditor@wst.local` | AUDITOR | Read-only + audit trail |
| `student@wst.local` | STUDENT | Own dashboard only |
| `manager@rival.local` | WORKSHOP_MANAGER in **ORG B** | Exists so cross-organization isolation is testable |

A second organization is seeded deliberately: every isolation test proves that ORG B cannot read or
write ORG A data.

### Acceptance scenario data

`db:seed:scenarios` creates job cards sitting in **every** lifecycle stage (RECEIVED → DELIVERED with
a paid invoice), a purchase order approved twice with a goods receipt still `PENDING`, a second
purchase order waiting for its 2nd approval, a published training session with a cohort, one student
fully signed off **and certified**, one student deliberately blocked by an unsigned assessment, a
draft session that overlaps the published one (so the conflict rule can be demonstrated on the spot),
parts below their minimum level, and a generated service reminder.

Public certificate check, no token needed:

```
GET /api/v1/certificates/verify/wst-demo-certificate-token
```

---

## 3b. Official requirement mapping

`REQUIREMENTS_MAPPING.md` maps every `WST-FR-01 … WST-FR-14`, all eight acceptance scenarios, the data
requirements, the security section and the common-pack NFRs to the exact file and the exact test that
proves it. Read that document first if you are evaluating against the PDF.

Newly added since the first delivery, after mapping against the official brief: bilingual error
contract and Arabic reference data (FR-02), vehicle detail with the next-service rule and archiving
(FR-03), job work checklist (FR-04), stock reservations (FR-06), part compatibility, physical stock
counts and a ledger reconciliation endpoint (FR-07), invoice statement export as JSON/PDF (FR-09),
QR-verifiable certificates (FR-12), six more export datasets plus PDF output and a dashboard
reconciliation endpoint (FR-13), and human override + evaluation statistics + an optional AI adapter
with a declared fallback (FR-14, scenario 8).

## 4. Business rules — where each one is enforced

| Rule | Enforcement point | Test |
| --- | --- | --- |
| 1. No billable work before customer approval | `jobs.routes.ts` transitions, labor, parts issue, sublet | `jobs.test.ts`, `smoke` |
| 2. Invoice computed from source data | `services.ts › computeInvoice` — only `discount` accepted from the client | `jobs.test.ts` |
| 3. Stock can never go negative | `services.ts › moveStock` (`FOR UPDATE OF sb`) + `CHECK (on_hand >= 0)` | `concurrency.test.ts` |
| 4. Reversal returns stock with reason + audit | `POST /job-parts/:id/reversals`, `stock:reverse` permission | `inventory.test.ts`, `audit.test.ts` |
| 5. Above-threshold purchases need N approvals | `purchasing.routes.ts`, `org_settings.po_approval_threshold` | `purchasing.test.ts` |
| 6. Separation of duties on approvals | Requester ≠ approver, one decision per user, `UNIQUE(po, approver)` | `purchasing.test.ts`, `concurrency.test.ts` |
| 7. Goods receipt moves stock only on accept | `POST /goods-receipts/:id/accept` is the only path that calls `moveStock` | `purchasing.test.ts` |
| 8. No publishing a conflicting session | `services.ts › findSessionConflicts` (bay, mentor, technician, jobs) | `training.test.ts` |
| 9. Unsigned assessments never certify | `services.ts › certificationStatus`; mentor cannot sign own entry | `training.test.ts` |
| 10. No access outside org/role scope | `auth.ts › requirePermission` + `core.ts › inScope` guards on every child row | `security.test.ts` |

Extra rules enforced beyond the ten: rework from quality check requires a reason, quality check
requires recorded labor, delivery requires an issued invoice, one invoice per job, payments cannot
exceed the invoice total, enrollment respects session capacity, receipts cannot exceed the ordered
quantity, and reversal is blocked once the job is invoiced.

---

## 5. Architecture

```
src/
  app.ts                  Express assembly, request ids, Swagger, error handling
  server.ts               Entry point
  auth.ts                 JWT, refresh-token rotation, DB-backed permissions, lockout
  core.ts                 audit(), notify(), settings(), inScope guards, document numbering
  services.ts             moveStock, computeInvoice, conflicts, certification, predictions
  http.ts                 Response envelope, DomainError, validation and error mapping
  openapi.ts              Full contract, generated from one route table
  routes/                 auth, customers, jobs, inventory, purchasing, training, analytics
  db/                     pool (with deadlock retry), migrate, seed, seed-scenarios, reset
      migrations/         001_init, 002_extend, 003_doc_counters, 004_pdf_gaps, 005_hardening
  i18n.ts                 Bilingual error catalog and Accept-Language negotiation (WST-FR-02)
  ai-adapter.ts           Optional model call with timeout and declared non-AI fallback
  pdf.ts                  Invoice statement and tabular PDF exports
  logger.ts               Structured JSON logging with secret redaction
  crypto.ts               AES-256-GCM for re-renderable certificate QR tokens
tests/                    security, security-hardening, jobs, inventory, purchasing, training,
                          audit, concurrency, contract, pdf-requirements, commercial-rules,
                          scheduling, student-self-service, pagination, blueprint-alignment  (217 tests)
scripts/smoke.ts          20 end-to-end HTTP checks
```

Every response uses the same envelope:

```json
{ "data": {}, "meta": { "page": 1, "pageSize": 50, "total": 120 }, "error": null }
```

Errors return `data: null` and a stable machine-readable code:

```json
{ "data": null, "meta": {},
  "error": { "code": "CUSTOMER_APPROVAL_REQUIRED",
             "message": "Billable work cannot start before customer approval",
             "details": { "requestId": "…" } } }
```

Codes the frontend should handle explicitly: `VALIDATION_ERROR`, `AUTH_REQUIRED`, `AUTH_INVALID`,
`AUTH_LOCKED`, `FORBIDDEN`, `NOT_FOUND`, `JOB_INVALID_TRANSITION`, `CUSTOMER_APPROVAL_REQUIRED`,
`INSUFFICIENT_STOCK`, `REVERSAL_EXCEEDS_ISSUED`, `INVOICE_REQUIRED`, `INVOICE_EXISTS`,
`JOB_NOT_READY`, `OVERPAYMENT`, `DUPLICATE_APPROVAL`, `SEPARATION_OF_DUTIES`, `PO_NOT_APPROVED`,
`RESOURCE_CONFLICT`, `CAPACITY_EXCEEDED`, `NOT_ELIGIBLE`, `ALREADY_SIGNED`.

---

## 6. Endpoint map

Full parameter and payload detail is in Swagger (`/docs`). Summary:

- **Auth** — `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /me`, `GET|POST /users`, `PATCH /users/:id/roles`
- **Customers** — `GET|POST /customers`, `GET|PATCH /customers/:id`, `GET|POST /customers/:id/vehicles`, `GET /vehicles/:id/service-history`, `POST /vehicles/:id/reminders/generate`, `GET /reminders`
- **Jobs** — `GET|POST /jobs`, `GET /jobs/:id`, `POST /jobs/:id/customer-approvals`, `/transitions`, `/labor`, `/sublet`, `/parts/issue`, `POST /job-parts/:id/reversals`
- **Invoicing** — `GET /jobs/:id/invoice-preview`, `POST /jobs/:id/invoices`, `GET /invoices/:id`, `POST /invoices/:id/payment-references`
- **Inventory** — `GET|POST /parts`, `PATCH /parts/:id/levels`, `GET|POST /stores`, `GET /stock/balances`, `/stock/movements`, `POST /stock/adjustments`, `/stock/transfers`, `GET /stock/alerts`
- **Purchasing** — `GET|POST /vendors`, `GET|POST /purchase-orders`, `GET /purchase-orders/:id`, `POST /purchase-orders/:id/submit`, `/approvals`, `/goods-receipts`, `POST /goods-receipts/:id/accept`, `/reject`
- **Training** — terms, courses, competencies, `courses/:id/tasks`, student groups, students, training sessions, `/conflicts`, `/publish`, `/enrollments`, `/attendance`, `/assessments`, `POST /assessments/:id/signoff`, `GET /students/:id/competency-coverage`, `POST /certificates`, `/certificates/:id/revoke`, `GET /certificates/verify/:token` *(public)*
- **Analytics** — `GET /dashboards/{workshop|inventory|finance|training|student}`, `GET /exports/{jobs|invoices|stock|assessments|audit}`, `GET /predictions/reorder`, `/predictions/training-risk`, `GET|POST /predictions/:model/runs`, `GET /audit-events`, notifications, attachments, bays, `GET|PATCH /settings`
- **Health** — `GET /health/live`, `GET /health/ready`

Added for the official brief: `GET /vehicles/:id`, `POST /vehicles/:id/archive`,
`POST /customers/:id/archive`, `GET|POST /jobs/:id/work-items`, `PATCH /work-items/:id`,
`POST /jobs/:id/parts/reserve`, `GET /jobs/:id/reservations`, `POST /reservations/:id/release`,
`GET /invoices/:id/statement`, `POST /parts/:id/compatibilities`, `GET /vehicles/:id/compatible-parts`,
`POST /stock-counts`, `GET /stock-counts/:id`, `POST /stock-counts/:id/approve`,
`GET /stock/reconciliation`, `GET /certificates`, `GET /certificates/:id/qr`,
`GET /dashboards/reconciliation`, `POST /predictions/runs/:id/decision`, `GET /predictions/evaluation`,
`GET /i18n/error-codes`.

A contract test fails the build if any mounted route is missing from the OpenAPI document, or if the
document describes a route that does not exist.

---

## 7. Predictions — explainable, versioned, non-AI fallback

Two rule baselines ship in the backend and require no AI service:

- `inventory_reorder` / `min-max-open-po-v2` — triggers when available (on hand minus active
  reservations) ≤ min level, and suggests topping up to max **counting stock already on open purchase
  orders**, so the same stock is never ordered twice. Returns every contributing feature: on hand,
  reserved, on order, inventory position, 90-day usage, average weekly consumption, average daily use
  and estimated cover days.
- `training_completion_risk` / `weighted-rules-v1` — deterministic weighted rules over attendance,
  competency coverage, pending signatures and failed tasks, returning every contribution and its weight.

`POST /predictions/:model/runs` snapshots results into `prediction_runs` with the model key, version
and strategy, so scores stay reproducible. **Integration point for the AI/Data member:** implement a
model that returns the same shape (`score`, `band`, `explanation.contributions`, `model.version`) and
register it alongside these; the rule baselines remain the declared fallback when the model is absent
or errors. Nothing in the backend blocks on that work.

---

## 8. Known integration points (contracts ready, nothing blocked)

| Dependency | What the backend already provides | What is left to the other member |
| --- | --- | --- |
| File storage (DevOps) | `attachments` table + `POST/GET /attachments` own metadata, scope and audit; accepts a `storageKey` | Provision the bucket and issue upload URLs; swap the key format |
| Notification delivery | `notifications` table, queued rows, `GET /notifications`, `POST /notifications/:id/read` | Email/SMS sender that drains `status='QUEUED'` |
| AI models | Versioned, explainable rule baselines + `prediction_runs` history | Plug in a model behind the same contract |
| Frontend | Full REST contract, OpenAPI, seeded demo data, stable error codes | Consume it |

---

## 9. Security notes

- Passwords hashed with bcrypt; 5 failed logins in 15 minutes lock an account (`AUTH_LOCKED`).
- Refresh tokens are random opaque strings stored only as SHA-256 hashes, and rotate on every use —
  replaying a used token is rejected and the chain is recorded via `replaced_by`.
- Permissions are read from the database on each request (15s cache), so revoking a role takes effect
  immediately instead of surviving until the access token expires.
- Every business table carries `organization_id`; child rows are reached only through the `inScope`
  guards, which prove ownership before any read or write.
- Sensitive operations write an `audit_events` row inside the same transaction as the change, with
  actor, request id and operation metadata.
- `helmet` is enabled and CORS is restricted to `CORS_ORIGINS`. There is no `*` fallback: without the
  variable the API allows only `http://localhost:5173`, and in production it refuses to start.
- `JWT_ACCESS_SECRET` and `CERT_TOKEN_KEY` have no hard-coded defaults; production refuses to start
  without them.
- `audit_events` is append-only in the database: `UPDATE`, `DELETE` and `TRUNCATE` all raise `42501`.
- Workshop jobs and training sessions book bays through one `bay_reservations` table with a GiST
  `EXCLUDE` constraint, so a double booking is impossible in either direction even under concurrent
  commits.
- Part selling prices and labour rates are system facts (`parts.sell_price`, `labor_rates`); the API
  rejects a price or rate supplied in a request body.
- Students reach their own record through `/me/*` endpoints that take no identifier at all.
