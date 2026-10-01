-- Append-only, hash-chained audit trail. One chain per organisation:
--   hash = sha256(prev_hash | canonical row content), seq contiguous from 1.
-- Three layers stop or expose modification:
--   1. the runtime DB account is granted SELECT and INSERT only (see scripts/migrate.js);
--   2. these triggers reject UPDATE and DELETE for every account, including admin;
--   3. the hash chain exposes any edit made by someone able to bypass 1 and 2.
-- Limitation: deleting the newest rows of a chain is not detectable from inside the
-- database. Anchor the head hash (GET /audit/verify) outside it to close that gap.
CREATE TABLE audit_log (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id         INT UNSIGNED    NOT NULL,
  seq            BIGINT UNSIGNED NOT NULL,
  actor_user_id  INT UNSIGNED    NULL,
  action         VARCHAR(60)     NOT NULL,
  entity_type    VARCHAR(40)     NOT NULL,
  entity_id      VARCHAR(64)     NULL,
  data           JSON            NOT NULL,
  created_at     DATETIME(3)     NOT NULL,
  prev_hash      CHAR(64)        NOT NULL,
  hash           CHAR(64)        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_org_seq (org_id, seq),
  UNIQUE KEY uq_audit_hash (hash),
  CONSTRAINT fk_audit_org FOREIGN KEY (org_id) REFERENCES organisations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER audit_log_block_update BEFORE UPDATE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: UPDATE rejected';

CREATE TRIGGER audit_log_block_delete BEFORE DELETE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: DELETE rejected';
