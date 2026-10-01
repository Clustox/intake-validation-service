CREATE TABLE users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id         INT UNSIGNED NOT NULL,
  email          VARCHAR(254) NOT NULL,
  display_name   VARCHAR(200) NOT NULL,
  password_hash  CHAR(60)     NOT NULL,
  role           ENUM('admin','submitter') NOT NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_org (org_id),
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organisations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
