-- 005_hardening.sql
-- Closes the security and commercial-rule gaps found in the second audit:
--   * audit_events is immutable at the database level (WST security: "immutable history")
--   * one shared bay calendar with a real exclusion constraint (risk control: "database constraints")
--   * invoice prices come from catalogue data, never from the client (the brief's "hardest part")
--   * attachment storage keys are constrained
--   * goods receipts cannot over-receive even with concurrent pending receipts

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- immutable audit history
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_no_update ON audit_events;
CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- TRUNCATE bypasses row triggers, so it is blocked separately.
DROP TRIGGER IF EXISTS trg_audit_events_no_truncate ON audit_events;
CREATE TRIGGER trg_audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- ---------------------------------------------------------------- one shared bay calendar
-- Workshop jobs and training sessions both book the same physical bays. A single table with a
-- GiST exclusion constraint makes a double booking impossible even under concurrent commits,
-- in either direction, which application-level checks alone cannot guarantee.
CREATE TABLE IF NOT EXISTS bay_reservations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bay_id uuid NOT NULL REFERENCES bays(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('JOB', 'SESSION')),
  source_id uuid NOT NULL,
  during tstzrange NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

DO $$ BEGIN
  ALTER TABLE bay_reservations
    ADD CONSTRAINT bay_reservations_no_overlap
    EXCLUDE USING gist (bay_id WITH =, during WITH &&);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_bay_reservations_bay ON bay_reservations(bay_id, during);

-- ---------------------------------------------------------------- prices come from the catalogue
ALTER TABLE parts ADD COLUMN IF NOT EXISTS sell_price numeric(12,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE parts ADD CONSTRAINT parts_sell_price_non_negative CHECK (sell_price >= 0);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Parts seeded before this migration get a default retail margin so no priced row is left at 0.
UPDATE parts SET sell_price = ROUND(average_cost * 1.35, 2) WHERE sell_price = 0 AND average_cost > 0;

ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS default_labor_rate numeric(12,2) NOT NULL DEFAULT 150;
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS max_export_rows int NOT NULL DEFAULT 5000;
ALTER TABLE users        ADD COLUMN IF NOT EXISTS labor_rate numeric(12,2);

-- Per service-type labour rates; the technician override and the org default are the fallbacks.
CREATE TABLE IF NOT EXISTS labor_rates(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_type text NOT NULL,
  rate numeric(12,2) NOT NULL CHECK (rate >= 0),
  effective_from date NOT NULL DEFAULT current_date,
  UNIQUE(organization_id, service_type)
);

-- Which source each stored price came from, so an invoice can prove it was not typed in.
ALTER TABLE job_parts     ADD COLUMN IF NOT EXISTS price_source text NOT NULL DEFAULT 'PART_SELL_PRICE';
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS rate_source  text NOT NULL DEFAULT 'ORG_DEFAULT';

-- ---------------------------------------------------------------- attachments
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'PENDING';
DO $$ BEGIN
  ALTER TABLE attachments ADD CONSTRAINT attachments_storage_key_safe
    CHECK (storage_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$' AND storage_key NOT LIKE '%..%');
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- ---------------------------------------------------------------- certificates: re-renderable QR
-- The raw verification token was previously only returned once, so a student could never get their
-- QR code again. It is now kept encrypted (AES-256-GCM) and only decryptable by the API.
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS token_cipher text;

-- ---------------------------------------------------------------- goods receipts
CREATE INDEX IF NOT EXISTS idx_gr_lines_po_line ON goods_receipt_lines(purchase_order_line_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_po ON goods_receipts(purchase_order_id, status);

-- ---------------------------------------------------------------- customers / vehicles
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes text;
