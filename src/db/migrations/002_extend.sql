-- 002_extend.sql : closes the gaps found in the Project-6 backend audit.

-- ---------- Organisation level configuration (no more hard-coded thresholds) ----------
CREATE TABLE IF NOT EXISTS org_settings(
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'EGP',
  tax_rate numeric(8,4) NOT NULL DEFAULT 0.14,
  po_approval_threshold numeric(12,2) NOT NULL DEFAULT 1000,
  po_approvals_required_above int NOT NULL DEFAULT 2,
  po_approvals_required_below int NOT NULL DEFAULT 1,
  reminder_interval_days int NOT NULL DEFAULT 180,
  reminder_interval_km int NOT NULL DEFAULT 10000,
  certificate_min_pass_ratio numeric(5,4) NOT NULL DEFAULT 1.0,
  certificate_min_attendance_ratio numeric(5,4) NOT NULL DEFAULT 0.75
);

-- ---------- Jobs: schedule window (needed for real conflict detection) + approval detail ----------
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS scheduled_end_at   timestamptz;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS estimate_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE job_approvals ADD COLUMN IF NOT EXISTS decision text NOT NULL DEFAULT 'APPROVED';
ALTER TABLE job_approvals ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE job_approvals ADD COLUMN IF NOT EXISTS reference_no text;
ALTER TABLE job_approvals ADD COLUMN IF NOT EXISTS approved_amount numeric(12,2);
ALTER TABLE job_approvals ADD COLUMN IF NOT EXISTS note text;

CREATE TABLE IF NOT EXISTS job_sublets(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  vendor_id uuid REFERENCES vendors(id),
  description text NOT NULL,
  cost numeric(12,2) NOT NULL CHECK(cost >= 0),
  price numeric(12,2) NOT NULL CHECK(price >= 0),
  billable boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Inventory: reversal, adjustment, negative-stock hard guard ----------
ALTER TABLE job_parts ADD COLUMN IF NOT EXISTS reversed_qty numeric NOT NULL DEFAULT 0;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS balance_after numeric;

CREATE TABLE IF NOT EXISTS part_reversals(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_part_id uuid NOT NULL REFERENCES job_parts(id),
  quantity numeric NOT NULL CHECK(quantity > 0),
  reason text NOT NULL,
  authorized_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_adjustments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  part_id uuid NOT NULL REFERENCES parts(id),
  delta numeric NOT NULL,
  reason text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_non_negative CHECK (on_hand >= 0);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ---------- Purchasing: state machine + receipt numbering ----------
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approvals_required int NOT NULL DEFAULT 1;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id);
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS gr_no text;
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES users(id);
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE purchase_approvals ADD CONSTRAINT purchase_approvals_one_per_user UNIQUE(purchase_order_id, approved_by);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ---------- Invoicing ----------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sublet_price numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_per_job ON invoices(job_card_id) WHERE status <> 'CANCELLED';

-- ---------- Customers / vehicles: service reminders ----------
CREATE TABLE IF NOT EXISTS service_reminders(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  job_card_id uuid REFERENCES job_cards(id),
  due_date date NOT NULL,
  due_mileage int,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON service_reminders(organization_id,status,due_date);

-- ---------- Training depth: terms, groups, competencies ----------
CREATE TABLE IF NOT EXISTS terms(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL, name text NOT NULL,
  starts_on date NOT NULL, ends_on date NOT NULL,
  UNIQUE(organization_id, code)
);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS term_id uuid REFERENCES terms(id);
ALTER TABLE training_sessions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE training_sessions ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE students ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE students ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE practical_tasks ADD COLUMN IF NOT EXISTS weight numeric NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS student_groups(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  term_id uuid REFERENCES terms(id),
  code text NOT NULL, name text NOT NULL,
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS competencies(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL, name text NOT NULL,
  UNIQUE(organization_id, code)
);

CREATE TABLE IF NOT EXISTS task_competencies(
  task_id uuid REFERENCES practical_tasks(id) ON DELETE CASCADE,
  competency_id uuid REFERENCES competencies(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, competency_id)
);

ALTER TABLE certificates ADD COLUMN IF NOT EXISTS issued_by uuid REFERENCES users(id);
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS revoke_reason text;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS coverage_json jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificate_student_course ON certificates(student_id, course_id) WHERE status = 'ISSUED';

-- ---------- Attachments, notifications, prediction runs, login throttling ----------
CREATE TABLE IF NOT EXISTS attachments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
  storage_key text NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(organization_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS notifications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  recipient_id uuid REFERENCES users(id),
  channel text NOT NULL DEFAULT 'IN_APP',
  topic text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'QUEUED',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS prediction_runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  model_key text NOT NULL,
  model_version text NOT NULL,
  strategy text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  score numeric,
  band text,
  features_json jsonb NOT NULL DEFAULT '{}',
  explanation_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prediction_subject ON prediction_runs(organization_id, model_key, subject_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  ip text,
  success boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(email, attempted_at DESC);

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_by uuid;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_tokens(token_hash);

-- ---------- Indexes that the dashboards/exports rely on ----------
CREATE INDEX IF NOT EXISTS idx_job_parts_job ON job_parts(job_card_id);
CREATE INDEX IF NOT EXISTS idx_labor_job ON labor_entries(job_card_id);
CREATE INDEX IF NOT EXISTS idx_sessions_window ON training_sessions(organization_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_assessments_student ON assessments(student_id, status);

