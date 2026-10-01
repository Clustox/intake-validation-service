-- Synthetic reference data used as lookup-rule targets. These tables are seed
-- and test fixtures, created by scripts/seed.js. They are NOT part of the
-- service's schema: the migrations create only the five specified tables. They
-- stand in for the external reference sets a lookup rule checks against. Every
-- lookup target must carry org_id (lookups are always scoped to the submitting
-- organisation) and must be listed in LOOKUP_ALLOWLIST. Until the seed has run
-- these tables do not exist, and a lookup rule returns unknown.
CREATE TABLE IF NOT EXISTS ref_suppliers (
  id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id  INT UNSIGNED NOT NULL,
  code    VARCHAR(64)  NOT NULL,
  name    VARCHAR(200) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ref_suppliers (org_id, code),
  CONSTRAINT fk_ref_suppliers_org FOREIGN KEY (org_id) REFERENCES organisations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ref_cost_centres (
  id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id  INT UNSIGNED NOT NULL,
  code    VARCHAR(64)  NOT NULL,
  name    VARCHAR(200) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ref_cost_centres (org_id, code),
  CONSTRAINT fk_ref_cost_centres_org FOREIGN KEY (org_id) REFERENCES organisations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
