# Project 6 Blueprint Compliance

The API exposes the streamlined blueprint paths through aliases while retaining the existing
validated domain handlers. This prevents duplicate business logic and preserves authorization,
transactional stock deduction, audit logging, conflict checks, and computed invoices.

| Blueprint endpoint | Internal handler |
|---|---|
| `POST /api/v1/auth/register` | User creation (`/users`) |
| `POST /api/v1/auth/login` | Existing login |
| `POST /api/v1/workshop/vehicles` | Customer vehicle creation |
| `POST /api/v1/workshop/jobs` | Job-card creation |
| `PATCH /api/v1/workshop/jobs/:id/stage` | Job transition engine |
| `POST /api/v1/workshop/jobs/:id/parts` | Atomic part issue |
| `GET /api/v1/workshop/jobs/:id/invoice` | Computed invoice preview |
| `POST /api/v1/training/sessions` | Training session creation |
| `POST /api/v1/training/assessments` | Session assessment creation |
| `GET /api/v1/training/certificates/verify/:token` | Public certificate verification |
| `GET /api/v1/analytics/dashboard` | Workshop dashboard |

The original internal routes remain available to avoid breaking existing frontend and mobile
integrations. All aliases pass through the same middleware and business rules.

## Status codes (blueprint sections 3, 4, 8 and 9)

| Situation | Status | Code |
|---|---|---|
| `POST /auth/register`, `POST /workshop/vehicles`, `POST /workshop/jobs`, `POST /training/sessions` (and the internal `/users`, `/customers/:id/vehicles`, `/jobs`, `/training-sessions`) | **201 Created** | - |
| Bay / mentor / technician overlap (publish, job create, job assign, raw exclusion violation) | **400** | `RESOURCE_CONFLICT`, `BAY_DOUBLE_BOOKED` |
| Insufficient stock (issue, reserve, adjustment, transfer, DB `CHECK`) | **400** | `INSUFFICIENT_STOCK` |
| Missing / invalid JWT | 401 | `AUTH_REQUIRED`, `AUTH_INVALID` |
| Insufficient role permission | 403 | `FORBIDDEN` |
| Duplicate, separation of duties, capacity exceeded | 409 | unchanged |
| Other business-rule rejections (invalid stage transition, approval required, ...) | 422 | unchanged |

## Role grants added for the blueprint tables

| Blueprint row | Change |
|---|---|
| `POST /workshop/jobs/:id/parts` - "Storekeeper / Tech" | new permission `part:issue`, granted to `TECHNICIAN`. It opens only the issue endpoint; reservations, releases, reversals and stock adjustments still need the store permissions. |
| `POST /training/sessions` - "Mentor / Supervisor" | new permission `training:schedule`, granted to `MENTOR`. A mentor can create a draft for themselves only; publishing, cancelling and course management still need `training:write` (supervisor). |

Both grants live in `src/db/seed.ts`, which rewrites `role_permissions` on every run, so an existing
database picks them up with `npm run db:seed` (the Docker image already seeds on start).
