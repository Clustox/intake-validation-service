'use strict';

// Applies migrations/NNN_*.sql in filename order, records each in
// schema_migrations with a checksum, and refuses to continue if an
// already-applied file has been edited. Then (re)applies least-privilege
// grants for the runtime account.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAdminConnection } = require('../../src/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map(f => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      return { name: f, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

async function migrate(dbCfg, { database = dbCfg.database, fresh = false, log = () => {} } = {}) {
  const conn = await createAdminConnection(dbCfg, { database: null, multipleStatements: true });
  const applied = [];
  try {
    const q = conn.escapeId(database);
    if (fresh) {
      await conn.query(`DROP DATABASE IF EXISTS ${q}`);
      log(`dropped database ${database}`);
    }
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${q} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE ${q}`);
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(200) NOT NULL PRIMARY KEY,
      checksum   CHAR(64)     NOT NULL,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);

    const done = new Map((await conn.query('SELECT filename, checksum FROM schema_migrations'))
      .map(r => [r.filename, r.checksum]));

    for (const m of migrationFiles()) {
      if (done.has(m.name)) {
        if (done.get(m.name) !== m.checksum) {
          throw new Error(`migration ${m.name} was modified after it was applied (checksum mismatch)`);
        }
        continue;
      }
      // MariaDB DDL is not transactional; a failure stops here and is reported.
      await conn.query(m.sql);
      await conn.query('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [m.name, m.checksum]);
      applied.push(m.name);
      log(`applied ${m.name}`);
    }

    await applyGrants(conn, dbCfg, database);
    log(`granted runtime privileges to ${dbCfg.user}@${dbCfg.appHost} on ${database}`);
    return applied;
  } finally {
    await conn.end();
  }
}

async function applyGrants(conn, dbCfg, database) {
  const account = `${conn.escape(dbCfg.user)}@${conn.escape(dbCfg.appHost)}`;
  const db = conn.escapeId(database);
  await conn.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${conn.escape(dbCfg.password)}`);
  await conn.query(`ALTER USER ${account} IDENTIFIED BY ${conn.escape(dbCfg.password)}`);
  // Reset this database's privileges for the account, then grant the minimum.
  await conn.query(`GRANT USAGE ON *.* TO ${account}`);
  await conn.query(`REVOKE ALL PRIVILEGES ON ${db}.* FROM ${account}`).catch(ignoreNoGrant);
  for (const t of ['organisations', 'users', 'validation_rules', 'submitted_records', 'audit_log', 'schema_migrations']) {
    await conn.query(`REVOKE ALL PRIVILEGES ON ${db}.${conn.escapeId(t)} FROM ${account}`).catch(ignoreNoGrant);
  }
  await conn.query(`GRANT SELECT ON ${db}.* TO ${account}`);
  await conn.query(`GRANT INSERT, UPDATE ON ${db}.submitted_records TO ${account}`);
  await conn.query(`GRANT INSERT, UPDATE ON ${db}.validation_rules TO ${account}`);
  await conn.query(`GRANT INSERT ON ${db}.audit_log TO ${account}`);
}

function ignoreNoGrant(err) {
  // ER_NONEXISTING_GRANT / ER_NONEXISTING_TABLE_GRANT: nothing to revoke.
  if (err.errno === 1141 || err.errno === 1147) return;
  throw err;
}

module.exports = { migrate, migrationFiles };
