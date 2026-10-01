-- submission_id is the client's idempotency key: unique per organisation.
-- verdict: clean (every rule that applied was checked and passed),
--          failed (at least one rule failed),
--          incomplete (nothing failed, but at least one rule could not be evaluated).
CREATE TABLE submitted_records (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           INT UNSIGNED NOT NULL,
  submission_id    VARCHAR(100) NOT NULL,
  payload          JSON         NOT NULL,
  payload_hash     CHAR(64)     NOT NULL,
  verdict          ENUM('clean','failed','incomplete') NOT NULL,
  fully_evaluated  TINYINT(1)   NOT NULL,
  summary          JSON         NOT NULL,
  results          JSON         NOT NULL,
  version          INT UNSIGNED NOT NULL DEFAULT 1,
  submitted_by     INT UNSIGNED NOT NULL,
  updated_by       INT UNSIGNED NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_records_org_submission (org_id, submission_id),
  KEY ix_records_org_id (org_id, id),
  CONSTRAINT fk_records_org FOREIGN KEY (org_id) REFERENCES organisations (id),
  CONSTRAINT fk_records_submitted_by FOREIGN KEY (submitted_by) REFERENCES users (id),
  CONSTRAINT fk_records_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
