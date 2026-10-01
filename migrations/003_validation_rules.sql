-- Rules are data. rule_type selects an executor; config holds every parameter
-- (thresholds, patterns, lookup targets); message is the text returned on failure.
-- version increments on every change so each result can name the exact rule it ran.
CREATE TABLE validation_rules (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id      INT UNSIGNED NOT NULL,
  name        VARCHAR(120) NOT NULL,
  rule_type   VARCHAR(40)  NOT NULL,
  field       VARCHAR(120) NOT NULL,
  config      JSON         NOT NULL,
  message     VARCHAR(500) NOT NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  version     INT UNSIGNED NOT NULL DEFAULT 1,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_rules_org_name (org_id, name),
  KEY ix_rules_org_active (org_id, active),
  CONSTRAINT fk_rules_org FOREIGN KEY (org_id) REFERENCES organisations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
