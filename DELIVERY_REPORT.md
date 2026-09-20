# WST Backend — Delivery Report

## Verification run

Executed against a real PostgreSQL 16.15 instance rebuilt from an empty schema. Every line below is
a command you can run yourself; the result shown is the one observed.

| Step | Command | Result |
| --- | --- | --- |
| 1 | `npx tsx src/db/reset.ts` | schema reset ✅ |
| 2 | `npm run db:migrate` | 5 migrations applied from empty ✅ |
| 3 | `npm run db:seed` | base + acceptance-scenario data ✅ |
| 4 | `npm run build` | `tsc` with `strict: true`, no errors ✅ |
| 5 | `npm test` | **217 passed / 217**, 15 files, ~15-60s ✅ |
| 6 | `npm run smoke` | **20 / 20** end-to-end checks ✅ |
| 7 | `npm audit --omit=dev` | **0 vulnerabilities** ✅ |

The suite was then run **three more times against the same database without resetting it** and
returned 217/217 each time. This matters: an earlier version of the suite passed once and then
degraded on re-runs, which is how two real defects were found (see *Defects found by the new tests*).

### Test files

| File | Tests | Covers |
| --- | ---: | --- |
| `blueprint-alignment.test.ts` | 21 | Streamlined-blueprint paths (`/workshop/...`, `/training/...`), 201/200/400 status codes, Tech part-issue and Mentor session-create grants |
| `security-hardening.test.ts` | 34 | Export authorization, student-dashboard scope, attachment validation, immutable audit, error mapping, transport defaults, login throttling |
| `pagination.test.ts` | 27 | Page metadata, distinct pages, size ceiling, filtered totals across 13 list endpoints |
| `pdf-requirements.test.ts` | 20 | Direct assertions against the brief's acceptance evidence |
| `commercial-rules.test.ts` | 18 | Invoice pricing from source, reorder baseline inputs, weighted average cost, over-receipt |
| `scheduling.test.ts` | 15 | Bidirectional bay conflicts, database-level exclusion, bay release, job assignment |
| `student-self-service.test.ts` | 13 | The `/me/*` endpoints and their scoping |
| `security.test.ts` | 12 | Authentication, RBAC, cross-organization row scope |
| `training.test.ts` | 10 | Sessions, assessments, sign-off, certification |
| `jobs.test.ts` | 9 | State machine, approval gate, invoice computation |
| `audit.test.ts` | 8 | Audit coverage across every sensitive family |
| `concurrency.test.ts` | 8 | Negative stock, reversal races, document numbering, duplicate approval |
| `inventory.test.ts` | 8 | Atomic issue, ledger, reversal, reorder baseline |
| `purchasing.test.ts` | 8 | Thresholds, separation of duties, receipt lifecycle |
| `contract.test.ts` | 6 | OpenAPI completeness — fails on any undocumented or phantom route |

---

## What this pass changed

A second audit of the backend found eleven substantive issues plus a set of smaller ones. All were
fixed, and **no fix is reported here unless a test proves it**. 107 tests were added for that
purpose.

### Security

| # | Issue | Fix | Proof |
| --- | --- | --- | --- |
| 1 | `GET /exports/:dataset` accepted `def.permission` **or** `report:read`, so a quality checker or a buyer could export the full audit trail, student assessments and invoices | The dataset's own permission is required, full stop | `security-hardening.test.ts` — 3 refusal tests plus one confirming the owning role still succeeds |
| 2 | `GET /dashboards/student?studentId=` — the guard only ran for users who *had* a student profile, so any user without one (a technician) skipped it entirely and could read another person's attendance and grades. This broke WST-FR-01's own acceptance evidence | Authorization stated positively: your own record, or anybody's only with a training permission; staff access is audited | 4 tests covering technician, other-student, own-record and audited staff access |
| 3 | Attachments had no content-type allow-list (`x.exe` was accepted), no traversal check on `storageKey` (`../../etc/passwd` was accepted), no verification that the target entity belonged to the caller's organization, and `GET /attachments` carried **no permission at all** | Allow-list, extension/content-type match, size cap, traversal rejection in code *and* a database `CHECK`, entity-ownership verification, per-entity read and write permissions | 11 tests |
| 4 | `audit_events` was described as immutable but nothing enforced it | `BEFORE UPDATE OR DELETE` row trigger plus a `BEFORE TRUNCATE` statement trigger, both raising `42501` | 4 tests that attack the table **directly through the connection pool**, not through the API |

### Commercial rules from the brief

| # | Issue | Fix | Proof |
| --- | --- | --- | --- |
| 5 | The invoice was computed from source rows, but `unitPrice` and `rateSnapshot` were taken from the request body — so the price itself was typed, which is exactly what the brief's "hardest part" forbids | `parts.sell_price` and a `labor_rates` table (service type → technician override → organisation default). Both request fields are now rejected. The resolved source is stored on each row | 8 tests, including one proving a later catalogue price change does not rewrite an issued line |
| 6 | The Student actor had no reachable endpoint; every staff route correctly refused them | Seven `/me/*` endpoints covering the six items the brief names, taking no identifier at all | 13 tests |
| 7 | No `PATCH /jobs/:id`, so a manager could not assign a bay or technician after reception — step 2 of the primary workflow | Assignment endpoint that re-books the shared bay calendar and audits previous values | 5 tests |
| 8 | Conflict detection ran one way only: a session checked jobs, but a job could be scheduled straight into a published session's bay. Cancelled jobs still held their bay. No database constraint backed any of it, despite the brief listing "database constraints" as the risk control | A `bay_reservations` table with a GiST `EXCLUDE` constraint that both jobs and sessions write to, plus `findJobConflicts` for the explanatory payload, plus release on cancel/deliver | 15 tests, one of which bypasses the API and inserts an overlapping row in raw SQL |
| 9 | The reorder baseline ignored open purchase orders and average weekly consumption, both named as required inputs. It would re-order stock that was already coming | Rewritten to use min/max, reservations, open POs and average weekly consumption; version bumped to `min-max-open-po-v2` | 4 tests; an open PO for 30 units drops the suggestion from 38 to 8 |
| 10 | `average_cost` was overwritten with the last purchase price, mis-stating stock valuation and every cost-based KPI | Weighted moving average over the quantity already held | 2 tests |
| 11 | Two pending goods receipts for the same quantity could both be accepted, receiving twice what was ordered | Pending quantities on other receipts are counted, the order line is locked `FOR UPDATE`, and the outstanding quantity is re-checked at acceptance | 4 tests |

### Smaller items, all requested and all tested

- `GET /jobs/abc` returned **500**; Postgres `22P02` is now mapped to 400, `23P01` to 400 (bay overlap, per the blueprint status table) and `42501`
  to 403.
- Pagination added to vendors, purchase orders, stores, stock balances, stock movements, students,
  courses, training sessions, certificates and customer vehicles.
- Exports gained `from`/`to`/`limit`, a configurable row ceiling, a truncation flag, and a clear
  error when a date filter is applied to a snapshot dataset.
- `JWT_ACCESS_SECRET` lost its `dev-access-secret` fallback; production refuses to start without it.
  `CORS_ORIGINS` no longer falls back to `*`.
- Structured JSON logging with request id, duration, user and organization, plus `security: true`
  events for permission denials and rate limiting, with automatic redaction of anything named like
  a password or token.
- `tsconfig` now runs with `strict: true`.
- `PATCH /customers/:id` silently dropped `preferredContact`; there was no vehicle update endpoint
  at all. Both fixed, with a forward-only mileage rule.
- Certificate verification tokens are now recoverable (AES-256-GCM) so a student can re-render their
  QR code instead of losing it after one response.

---

## Defects found by the new tests

Three problems were discovered *by* the new tests rather than being on the original list. They are
worth calling out because they were invisible to a single passing run.

1. **Non-deterministic pagination.** Lists ordered only by `created_at desc`. Rows sharing a
   timestamp could appear on two pages while others never appeared at all. Every paginated query now
   carries a unique tiebreaker.
2. **`GET /audit-events` returned no `total`**, so no client could build a pager for it.
3. **The login lockout locked out legitimate users.** It counted every failure in a 15-minute window
   and never reset on success, so four typos plus a successful sign-in plus one more typo locked the
   account. It now counts failures *since the last successful sign-in*. This was a pre-existing
   defect; running the suite repeatedly is what exposed it.

---

## Known limitations — stated plainly

These are real and are not dressed up as design decisions.

| Item | State |
| --- | --- |
| **Docker** | **Not verified.** Docker is not available in this environment, so `docker compose up` and the `Dockerfile` were never executed. Also note the container `CMD` re-seeds accounts with a known password on every start, which is fine for a demo and wrong for anything else. |
| **`noImplicitAny`** | `strict: true` is on, but `noImplicitAny` remains `false`. Route handlers are typed `(req: any, res: any)` throughout. Turning it on is a mechanical but non-trivial follow-up. |
| **Load testing** | The common pack's "95% of requests under 2 seconds with 200 concurrent users" was never measured. No load-testing tool was run. The number is not claimed anywhere. |
| **Object storage** | Attachment *metadata*, validation, scope and audit are complete. The bucket, signed short-lived download URLs and malware scanning are not implemented. `scan_status` stays `PENDING` and nothing claims a file was scanned. |
| **Notification delivery** | Rows are queued and queryable. No worker sends email or SMS. |
| **Dev-dependency advisories** | `npm audit --omit=dev` is clean. Including dev dependencies, `@vitest/mocker` carries a moderate advisory inherited from `vite`. It affects the test runner's dev server only, never the shipped runtime. `vitest` was moved from 2.1.9 to 3.2.7 to reduce this; the remaining advisory has no non-breaking fix at the time of writing. |
| **Mock server** | The Day-1 mock server is not in this repository. The OpenAPI document (123 operations) is, and any standard mock server can be generated from it. |
| **AI models** | Deterministic baselines only, which is the brief's stated requirement. The adapter for a real model exists and is unused by design. |
| **Test isolation** | Tests share one database by design (they are integration tests, not unit tests). Two test files randomise their scheduling windows to stay repeatable. There is no per-test transaction rollback; a full `npm run db:reset` is the clean slate. |

---

## For the reviewer

The fastest way to check this report rather than trust it:

```bash
npm ci
cp .env.example .env            # set DATABASE_URL, JWT_ACCESS_SECRET, CERT_TOKEN_KEY
npm run db:reset                # reset + migrate + seed
npm run build && npm test && npm run smoke && npm audit --omit=dev
```

To see a specific claim, run its file — for example `npx vitest run tests/scheduling.test.ts` for the
shared bay calendar, or `npx vitest run tests/commercial-rules.test.ts` for the invoice pricing rule.
Each test's comment says which requirement or which defect it exists for.
