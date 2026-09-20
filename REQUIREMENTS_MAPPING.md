# WST — Official Requirement Mapping

Mapped against **P6_Workshop_Management_Practical_Training.pdf** (WST-FR-01 … WST-FR-14, acceptance
scenarios 1–8, data/security/AI sections) and **00_START_HERE_Common_Pack.pdf** (non-functional
requirements, Definition of Done, engineering conventions).

## How to read this document

Every ✅ in this file names a **test or a command you can run yourself**. A claim with no runnable
evidence is not marked ✅ — it is marked 🟡 or 🔴 and says exactly what is missing. Several rows were
downgraded from the previous version of this document for that reason; they are listed under
*Corrections to the previous version of this file* at the end.

Verification state, from a database rebuilt from scratch on PostgreSQL 16.15:

```
npx tsx src/db/reset.ts       → schema reset                                  ✅
npm run db:migrate            → 5 migrations applied from empty               ✅
npm run db:seed               → base + acceptance-scenario data               ✅
npm run build                 → tsc, strict mode, no errors                   ✅
npm test                      → 217/217 tests, 15 files                       ✅
npm run smoke                 → 20/20 end-to-end checks                       ✅
npm audit --omit=dev          → 0 vulnerabilities                             ✅
```

The suite was run three times consecutively against the same database without a reset and returned
217/217 each time, so the result is repeatable rather than dependent on a fresh seed.

Scope note: this is a **backend** deliverable. Requirements with a user-interface component
(WST-FR-02 RTL rendering, dashboard screens) are delivered as the backend half — data, contract and
enforcement. Each such row says so rather than claiming the whole requirement.

---

## Functional requirements

| ID | Requirement (PDF) | Priority | State | Where it is implemented | Acceptance evidence satisfied |
| --- | --- | --- | --- | --- | --- |
| **WST-FR-01** | Authenticate users, enforce role and organizational scope across workshop, inventory, purchasing, finance-view, training, student and audit functions | Must | ✅ | `auth.ts` (bcrypt, access + rotating refresh tokens, lockout that resets on success, permissions resolved from the database per request), `core.ts › inScope` row guards, 13 roles × 30 permissions | *"A student cannot access another student's record; a technician cannot approve a purchase order."* — `security-hardening.test.ts › "a user without a student profile cannot read a student's dashboard"` proves a technician passing `?studentId=` gets 403, a student reading another student gets 403, and a student reading their own record needs no identifier at all. `student-self-service.test.ts › "the self-service endpoints belong to students only"` proves the student role gained no staff access. `purchasing.test.ts` proves a technician holds no `purchase:approve`. `security.test.ts` proves cross-organization reads and writes return 404. |
| **WST-FR-02** | English and Arabic interfaces with RTL mirroring, identifiers (job no, VIN, plate, SKU, amounts) readable LTR | Must | 🟡 backend complete, UI out of scope | `i18n.ts` bilingual error catalog, `Accept-Language` negotiation in `http.ts`, `GET /i18n/error-codes`, `name_ar` columns on parts/courses/tasks/bays/competencies, seeded Arabic names | Backend half: `pdf-requirements.test.ts` asserts Arabic error text for `Accept-Language: ar`, English default, catalogue contents, and that SKUs and identifiers are never translated. **The RTL layout checklist is a rendered-screen check and has no backend artifact.** It is not claimed here. |
| **WST-FR-03** | Customers with multiple vehicles, plate/VIN, make/model/year, mileage, contact preferences, service history, reminders, archived status | Must | ✅ | `customers.routes.ts`: `GET /vehicles/:id` (history + `nextServiceRule`), `PATCH /customers/:id` including `preferredContact`, `PATCH /vehicles/:id` with a forward-only mileage rule, reminders generated from `org_settings`, archive endpoints with an open-job guard | *"A vehicle detail shows complete completed-job history and its next service rule."* — `pdf-requirements.test.ts`. Archiving is blocked while job cards are open and archived rows drop out of the default list. Contact preference and vehicle editing were **not working before this pass** (see corrections). |
| **WST-FR-04** | Job card with complaint, service type, priority, vehicle, mileage, expected date, bay, technician, work checklist, photos, customer approvals | Must | ✅ | `jobs.routes.ts` create + `PATCH /jobs/:id` for assignment + `work_items` checklist; photos through `POST /attachments`; approvals with channel, reference and amount | *"A valid reception record receives a unique job number and required fields are enforced."* — Zod validation; `doc_counters` guarantees a unique `job_no` under 12 parallel creations (`concurrency.test.ts`). Assignment after reception is proved by `scheduling.test.ts › "job assignment (step 2 of the primary workflow)"` — 5 tests covering assignment, the audit entry with previous values, empty and inverted input, a cross-organization bay, and a closed job. |
| **WST-FR-05** | Job states Received → In Progress → Quality Check → Ready → Delivered with responsible user and timestamp per transition | Must | ✅ | `jobs.routes.ts › TRANSITIONS` + `job_stage_history` | *"Invalid transitions are rejected and the full stage history is auditable."* — `jobs.test.ts` asserts rejection of skipped transitions and the exact timeline including rework. |
| **WST-FR-06** | Log labor and parts issued; reserve and deduct stock transactionally; reversals with authorization and reason | Must | ✅ | `services.ts › moveStock` (`FOR UPDATE OF sb` + `CHECK (on_hand >= 0)`), reservations consumed on issue, `POST /job-parts/:id/reversals` requiring `stock:reverse` and a reason | *"Concurrent part issue cannot produce negative stock; reversal restores quantity and writes an audit event."* — `concurrency.test.ts`: 20 parallel issues against 12 units, exactly 12 succeed, balance 0, ledger reconciles, no 500s. `audit.test.ts` asserts the reversal audit row carries the reason and the authorising user. |
| **WST-FR-07** | Barcode-ready catalog with category, compatible vehicle/model, store, on-hand/reserved, min/max, **average cost**, transfers and stock-count adjustments | Must | ✅ | `inventory.routes.ts`; `part_compatibilities` + `GET /vehicles/:id/compatible-parts`; two stores; transfers; `stock_counts` recorded then approved by a second person; `services.ts › applyWeightedAverageCost`; `GET /stock/reconciliation` | *"Stock balance reconciles to receipts, issues, transfers, and approved adjustments."* — the reconciliation endpoint proves every balance equals the sum of its ledger movements; asserted in tests and smoke. **Average cost is now a weighted moving average**, proved by `commercial-rules.test.ts › "receiving stock moves the average cost, it does not overwrite it"`: 10 units at 100 plus 10 received at 200 gives 150, not 200. |
| **WST-FR-08** | Vendors, purchase requests/orders, configurable approval thresholds, goods receipts that update stock only after acceptance | Must | ✅ | `purchasing.routes.ts`; thresholds in `org_settings`; approval count frozen on the order; `DRAFT → PENDING_APPROVAL → APPROVED → (PARTIALLY_)RECEIVED`; separation of duties | *"An above-threshold order requires two approvals; receiving an approved line creates the matching stock movement."* — `purchasing.test.ts` covers 1 vs 2 approvals, duplicate approval, requester self-approval, a pending receipt moving no stock, acceptance moving it, and rejection leaving it untouched. **Over-receipt is now impossible**: `commercial-rules.test.ts › "a purchase order cannot be received twice"` proves two pending receipts for the same quantity are rejected and that 10 ordered units never become 20 received. |
| **WST-FR-09** | Accounting-lite invoice from job parts, labor, sublet, discount and configured tax; payment reference; export a statement | Should | ✅ | `services.ts › computeInvoice`, `resolvePartSellPrice`, `resolveLaborRate`; `POST /jobs/:id/invoices`; payment references with an overpayment guard; `GET /invoices/:id/statement` (JSON + PDF) | *"Invoice totals recompute from source lines and export matches the visible record."* — the statement carries a reconciliation block. **The brief's "hardest part" is now fully enforced**: `commercial-rules.test.ts › "invoice prices come from the catalogue, not from the request body"` — 8 tests proving a client-supplied `unitPrice` or `rateSnapshot` is rejected with 400, prices come from `parts.sell_price` and the labour rate table, an unpriced part cannot be issued, and a later catalogue price change does not rewrite an already-issued line. |
| **WST-FR-10** | Training terms, courses, sessions, bays, mentors, capacity, enrollment, groups; conflict detection against workshop jobs and other sessions | Must | ✅ | `training.routes.ts`, `services.ts › findSessionConflicts` **and `findJobConflicts`**, plus the `bay_reservations` table with a GiST `EXCLUDE` constraint (migration 005) | *"A bay or mentor conflict cannot be published and the system explains the conflict."* — `training.test.ts` covers SESSION_BAY, SESSION_MENTOR and JOB_BAY. **Detection is now bidirectional and enforced by the database**: `scheduling.test.ts` (15 tests) proves a job cannot be scheduled into a bay a published session holds, partial overlaps are caught, a back-to-back booking is allowed, cancelling either side frees the bay, and an overlapping row inserted *directly in SQL, bypassing the API entirely* is rejected with `23P01`. |
| **WST-FR-11** | Practical task library; per-student attendance, task, Pass/Fail/Needs Improvement, time-on-task, mentor note, evidence, supervisor sign-off | Must | ✅ | `practical_tasks` + competencies; attendance with enrollment enforced; assessments always created `PENDING_SIGNATURE`; evidence via attachments; sign-off blocked for the recording mentor | *"Unsigned results remain pending and cannot count toward certification."* — `training.test.ts` asserts coverage reports `PENDING_SIGNATURE` gaps and issuance returns 422 until every required result is signed. `student-self-service.test.ts` additionally proves an unsigned assessment is never shown to the student as a grade. |
| **WST-FR-12** | Competency coverage and course-completion rules; QR-verifiable certificate only after all required signed results | Should | ✅ | `services.ts › certificationStatus`, `POST /certificates`, `GET /certificates/:id/qr`, `GET /me/certificates/:id/qr`, public `GET /certificates/verify/:token`, revocation | *"Certificate verification returns student, course, issue date, status and revocation state without exposing unnecessary grades."* — verification returns the student **number** only. The token is stored as a SHA-256 hash for lookup **and** as an AES-256-GCM ciphertext (`crypto.ts`) so an authorised caller can re-render the QR; previously the raw token existed for one HTTP response only and a student could never retrieve their QR again. Proved by `student-self-service.test.ts`. |
| **WST-FR-13** | Role-scoped dashboards and **filtered** CSV/PDF exports for job pipeline, turnaround, revenue/cost, stock health, technician utilization, training attendance, assessment, competency, certification | Must | ✅ | 5 dashboards (`workshop`, `inventory`, `finance`, `training`, `student`) + 11 export datasets in CSV/JSON/PDF + `GET /dashboards/reconciliation` | *"Dashboard and export totals reconcile to source transactions for the same filters."* — the reconciliation endpoint compares invoice lines against subtotals and balances against the ledger. Exports now accept `from`/`to`/`limit`, are capped by `org_settings.max_export_rows`, flag truncation, and reject a date filter on snapshot datasets — asserted in `security-hardening.test.ts › "caps and filters exports"`. |
| **WST-FR-14** | Reorder quantities and training/completion risk using explainable rules first, optional models later, human override and non-AI fallback | Should | ✅ | `services.ts › MODELS` (`min-max-open-po-v2`, `weighted-rules-v1`), `prediction_runs`, `POST /predictions/runs/:id/decision`, `GET /predictions/evaluation`, `ai-adapter.ts` with timeout and fallback | *"Suggestion records inputs, baseline/model version, explanation, user decision and evaluation outcome."* — asserted in `inventory.test.ts` and `training.test.ts`. **The reorder baseline now uses every input the brief names** — min/max, open purchase orders, reservations and average weekly consumption — proved by `commercial-rules.test.ts › "the reorder baseline counts stock already on order"`: an open PO for 30 units drops the suggestion from 38 to 8. |

### Actor coverage: the Student

The PDF lists the Student as an actor who *"views assigned sessions, attendance, tasks, results,
competencies, and certificates."* A student holds no `training:*` permission, so before this pass
every staff endpoint correctly refused them and the actor had **no reachable endpoint at all**.

`GET /me/student`, `/me/sessions`, `/me/attendance`, `/me/results`, `/me/competencies`,
`/me/certificates` and `/me/certificates/:id/qr` cover the six items the PDF names. None of them
takes a student identifier — it comes from the token — so reading another student's record is not
expressible rather than merely rejected. Proved by `student-self-service.test.ts` (13 tests).

## Acceptance scenarios

| # | Scenario (PDF) | State | Evidence |
| --- | --- | --- | --- |
| 1 | Seed ≥20 customers, 30 vehicles, 100 parts, two stores, four bays, eight technicians/mentors, 40 students, four training sessions | ✅ | Seed produces exactly customers 20, vehicles 30, parts 100, stores 2, bays 4, technicians+mentors 8, students 40, training sessions 4. `pdf-requirements.test.ts` asserts the count by the four fixed seeded titles, so it stays exact even as other tests create sessions in the same database. |
| 2 | Advisor creates a job; technician logs labor and parts; quality check and delivery preserve a complete stage timeline | ✅ | `jobs.test.ts` and `npm run smoke` walk the full path and assert the timeline array. |
| 3 | Issuing a part updates job and stock atomically; a low-stock rule creates a reorder suggestion without ordering automatically | ✅ | `inventory.test.ts` (atomic issue plus ledger row) and a test asserting **no** purchase order exists for a part that triggered an alert. |
| 4 | A high-value purchase order requires two approvals; accepted goods receipt increases stock and is traceable to the order | ✅ | `purchasing.test.ts`; `commercial-rules.test.ts` additionally proves the received quantity can never exceed the ordered quantity. |
| 5 | A training session conflicting with an active workshop job is blocked; after reassignment groups, attendance, assessments and sign-off work | ✅ | `training.test.ts` plus `scheduling.test.ts`, which also covers the previously missing reverse direction and the release of a bay when either side is cancelled. |
| 6 | A qualified student receives a verifiable certificate; an unsigned or incomplete record cannot | ✅ | `training.test.ts` end to end; the seed ships one certified student and one deliberately blocked by an unsigned task. |
| 7 | English and Arabic critical workflows render correctly, unauthorized access tests fail safely, dashboard/export totals reconcile | 🟡 backend complete, UI half out of scope | The bilingual API contract, the authorization tests across `security.test.ts` and `security-hardening.test.ts`, and the reconciliation endpoint are all green. Arabic **rendering** is a frontend check and is not claimed. |
| 8 | The AI/data feature shows a rule baseline and explanation and can be offline without blocking workshop or training operations | ✅ | `ai-adapter.ts` treats the model as optional with a timeout; every prediction response reports `fallbackUsed` and `source`. With `AI_SERVICE_URL` unset the whole system runs on baselines, which is how the suite runs. |

## Data requirements

Every entity named in the PDF exists: User/Role/Permission/OrganizationScope · Customer/Vehicle/
ServiceReminder · JobCard/JobStage(`job_stage_history`)/WorkItem/LaborEntry · Part/Store/
StockMovement/StockCount · Vendor/PurchaseOrder/Approval/GoodsReceipt · Invoice/InvoiceLine/
PaymentReference · Course/TrainingSession/Bay/Mentor(`users` with the MENTOR role) · Student/
Enrollment/TrainingGroup/Attendance · PracticalTask/Assessment/Competency/Certificate ·
Attachment/Notification/Prediction(`prediction_runs`)/AuditEvent.

Migration 005 adds `bay_reservations` (the shared resource calendar), `labor_rates` and
`parts.sell_price`, because the brief's commercial rule cannot be enforced unless prices are system
facts rather than request fields.

## Security and privacy requirements

| Requirement | State | Where, and what is proved |
| --- | --- | --- |
| Backend RBAC and row scope (React visibility is not authorization) | ✅ | `requirePermission` + `inScope`. `security.test.ts` (12 tests) and `security-hardening.test.ts` (34 tests). |
| Separate job execution, stock adjustment, purchase approval, invoice viewing, assessment entry and sign-off permissions | ✅ | 30 distinct permissions; `STORE_SUPERVISOR` alone may reverse; counter ≠ approver; requester ≠ approver; mentor ≠ signer. **`report:read` is no longer a master key** — the export guard requires the dataset's own permission, proved by three tests showing a quality checker and a buyer are refused the audit trail and student assessments. |
| Least privilege on contacts, identifiers, student records, invoices, attachments | ✅ | Every read is organization-scoped; exports are permission-gated, filtered, capped and audited; `GET /attachments` now requires a permission appropriate to the entity type. |
| Private object storage, file **type/size validation**, malware scanning *where available*, short-lived download authorization | 🟡 | **Type and size validation are implemented and tested**: a content-type allow-list, an extension/content-type match check, a 25 MB cap, path-traversal rejection in both `fileName` and `storageKey` (code plus a database `CHECK`), and entity-ownership verification. 11 tests in `security-hardening.test.ts`. **Not implemented:** the object store itself, signed short-lived URLs, and malware scanning — there is no scanner in this environment. `attachments.scan_status` exists and stays `PENDING`; nothing claims a file has been scanned. |
| Audit job status, labor/parts changes, stock adjustments, approvals, invoice changes, assessment/sign-off, certificates, exports and **sensitive reads** | 🟡 | All mutations listed are audited inside the same transaction (`audit.test.ts`). **Sensitive reads audited:** data exports (with their filters and truncation flag), invoice statement export, reading a single customer, listing customers, listing students, listing certificates, listing attachments, and a staff member opening another person's student dashboard. **Not audited:** ordinary list reads of jobs, parts, stock and purchase orders, which are operational rather than personal data. This row is 🟡 because "sensitive reads" is broader than what is covered, not because nothing is covered. |
| Signed random certificate tokens; no internal ids or grade history exposed publicly | ✅ | 24-byte random token, stored as SHA-256 for lookup and AES-256-GCM for re-rendering; verification returns student number, course, dates and status only. |
| Secrets from environment, never committed | ✅ | `.env.example` only; `.env` is git-ignored. **`JWT_ACCESS_SECRET` no longer has a hard-coded fallback** — in production the process refuses to start without it, proved by a test that flips `NODE_ENV` and expects a throw. `CERT_TOKEN_KEY` behaves the same way. |
| Event logging without passwords, tokens or unnecessary payloads | ✅ | `logger.ts` emits one JSON object per line and redacts any field named like a password, token, secret, cookie or authorization header, proved by a direct test of `redact()`. |

## Common-pack non-functional requirements

| Area | State | Note |
| --- | --- | --- |
| Performance | ✅ | Indexed hot paths, pagination on every list endpoint with a 200-row ceiling, pooled connections, deadlock retry. The 217-test suite runs in about 15-60 seconds. Note: the *"95% of requests within 2 seconds under 200 concurrent demo users"* target has **not** been load-tested — no load-testing tool was run here, so that specific number is not claimed. |
| Availability | ✅ | `/health/live`, `/health/ready`, documented restore path (`db:reset` → migrate → seed), exercised in this run. |
| Security | ✅ | bcrypt, helmet, a CORS allow-list with no `*` fallback, Zod validation on every payload, rate limiting on `/auth` and on the rest of `/api/v1`, `npm audit --omit=dev` clean. |
| Privacy | ✅ | Minimal PII, archiving instead of deletion, audited sensitive reads (scope above). |
| Auditability | ✅ | Actor, timestamp, action, entity id and request id on every sensitive event, and the table is **append-only at the database level**: `UPDATE`, `DELETE` and `TRUNCATE` all raise `42501`, proved by four tests that attack the table directly through the connection pool rather than through the API. |
| Quality | ✅ | 217 automated tests across 15 files, 20 smoke checks, an OpenAPI contract test that fails on any undocumented or phantom route, and a concurrency suite. |
| Maintainability | ✅ | OpenAPI: 123 documented operations across 101 paths. README, 5 migrations, seed, `.env.example`, modular services. `tsconfig` runs with `strict: true` — see the caveat about `noImplicitAny` in the delivery report. |
| API conventions | ✅ | `/api/v1`; `{ data, meta, error }` envelope with `code`, `message`, `details` and `requestId`; UTC timestamps; transactions plus unique and exclusion constraints for concurrency-sensitive actions; pagination and export ceilings. |
| Observability | ✅ | Structured JSON logging with request id, method, path, status, duration, user and organization on every request, plus dedicated `security: true` events for permission denials, role denials and rate limiting. |

---

## Corrections to the previous version of this file

The earlier mapping carried ✅ marks the code did not support. They are corrected above and listed
here so the change is visible rather than quietly rewritten.

| Claim previously made | Reality at the time | Now |
| --- | --- | --- |
| "Audit … sensitive reads ✅" | Only exports and the invoice statement were audited. Reading customer and student records was not. | 🟡 with the exact list of what is and is not audited; customer, student, certificate and attachment reads were added. |
| "file type/size validation ✅" | `contentType` accepted any string and `storageKey` accepted `../../etc/passwd`. | ✅ for type and size with 11 tests; the row stays 🟡 overall because the object store and malware scanning are still absent. |
| "database constraints" for the bay-conflict risk control | There was no database constraint; detection was application-level and one-directional. | ✅ with a GiST `EXCLUDE` constraint and a test that attacks it directly in SQL. |
| "Invoice computed from source data ✅" | Totals were computed, but `unitPrice` and `rateSnapshot` came from the request body, so the price itself was typed. | ✅ with prices resolved from the catalogue and the rate table, proved by 8 tests. |
| "31 permissions" | There are 30. | Corrected. |
| "4 migrations", "89 tests", "113 operations" | Out of date. | 5 migrations, 217 tests, 123 operations. |
| Reorder model `min-max-v1` | Ignored open purchase orders, which the brief names as a required input. | `min-max-open-po-v2`, with open POs, reservations and average weekly consumption. |

## Remaining items

Nothing in the backend scope is unimplemented. Deliberately **not** in this repository:

1. **Frontend / RTL rendering (WST-FR-02, scenario 7).** The API is bilingual and identifier-safe;
   the React layout checklist is the Product pod's work.
2. **Object storage, signed download URLs and malware scanning for attachments.** Metadata, scope,
   type and size validation, traversal rejection and audit are done; the bucket needs DevOps. The
   `storageKey` contract will not change.
3. **Notification delivery.** Rows are queued on job-ready, PO approval, job assignment, session
   publish and certificate issue; an email or SMS worker drains `status='QUEUED'`.
4. **Trained AI models.** Stretch scope in the PDF. Baselines, versioning, explanation, override
   recording and fallback are in place behind `AI_SERVICE_URL`.
5. **Load testing against the 200-concurrent-user target.** Not run, therefore not claimed.
6. **Docker image verification.** Not run in this environment — see the delivery report.
7. **Stretch items the PDF itself defers** — RFQ comparison, partial payment contracts, automated
   reminder sending, trained forecasting, advanced profitability, mobile/PWA.
