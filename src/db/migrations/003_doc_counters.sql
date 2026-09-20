-- 003: race-free document numbering
CREATE TABLE IF NOT EXISTS doc_counters(
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(organization_id, doc_type)
);
