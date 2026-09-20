-- 004: closes the gaps found when mapping the implementation against the official PDF
-- (WST-FR-02 bilingual data, FR-03 archiving, FR-04 work checklist, FR-06 reservations,
--  FR-07 compatibility + stock counts, FR-14 human override).

-- ---------- WST-FR-02: bilingual reference data kept in the database, identifiers stay LTR ----------
ALTER TABLE parts           ADD COLUMN IF NOT EXISTS name_ar text;
ALTER TABLE courses         ADD COLUMN IF NOT EXISTS name_ar text;
ALTER TABLE practical_tasks ADD COLUMN IF NOT EXISTS title_ar text;
ALTER TABLE bays            ADD COLUMN IF NOT EXISTS name_ar text;
ALTER TABLE competencies    ADD COLUMN IF NOT EXISTS name_ar text;
ALTER TABLE organizations   ADD COLUMN IF NOT EXISTS name_ar text;

-- ---------- WST-FR-03: archiving instead of deletion ----------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE vehicles  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE vehicles  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE vehicles  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE vehicles  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

-- ---------- WST-FR-04: work checklist on the job card ----------
CREATE TABLE IF NOT EXISTS work_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_card_id uuid NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  sequence int NOT NULL DEFAULT 1,
  description text NOT NULL,
  description_ar text,
  status text NOT NULL DEFAULT 'PENDING',
  required boolean NOT NULL DEFAULT true,
  completed_by uuid REFERENCES users(id),
  completed_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_items_job ON work_items(job_card_id);

-- ---------- WST-FR-06: reservations before issue ----------
CREATE TABLE IF NOT EXISTS stock_reservations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  job_card_id uuid NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  part_id uuid NOT NULL REFERENCES parts(id),
  quantity numeric NOT NULL CHECK(quantity > 0),
  status text NOT NULL DEFAULT 'ACTIVE',
  reserved_by uuid REFERENCES users(id),
  released_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_reservations_job ON stock_reservations(job_card_id, status);

-- ---------- WST-FR-07: vehicle compatibility and physical stock counts ----------
CREATE TABLE IF NOT EXISTS part_compatibilities(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id uuid NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  make text NOT NULL,
  model text,
  year_from int,
  year_to int,
  UNIQUE(part_id, make, model, year_from, year_to)
);

CREATE TABLE IF NOT EXISTS stock_counts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  store_id uuid NOT NULL REFERENCES stores(id),
  count_no text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  counted_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE(organization_id, count_no)
);

CREATE TABLE IF NOT EXISTS stock_count_lines(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES parts(id),
  system_qty numeric NOT NULL,
  counted_qty numeric NOT NULL CHECK(counted_qty >= 0),
  variance numeric NOT NULL,
  UNIQUE(stock_count_id, part_id)
);

-- ---------- WST-FR-14: human override and evaluation outcome on every suggestion ----------
ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS decision text;
ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id);
ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS override_value numeric;
ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS decision_note text;
ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS outcome_json jsonb NOT NULL DEFAULT '{}';
ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS fallback_used boolean NOT NULL DEFAULT true;

-- ---------- Acceptance scenario 1 needs a second store to be usable for transfers ----------
CREATE INDEX IF NOT EXISTS idx_stock_counts_store ON stock_counts(organization_id, store_id, status);
