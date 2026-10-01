'use strict';

// Liveness says the process is running. Readiness says the service can do its
// job: the database answers, its schema matches the migrations shipped with
// this code, and the external audit anchor store is writable. Only readiness
// speaks for the service; a dependency that was not checked is reported as
// not_checked, never as up.

const { migrationFiles } = require('../scripts/lib/migrator');

class Timeout extends Error {}
const timeout = (p, ms) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Timeout()), ms); })]).finally(() => clearTimeout(t));
};

async function readiness(deps) {
  const checks = {};
  const expected = migrationFiles().map(m => m.name);
  try {
    await timeout(deps.pool.query('SELECT 1'), deps.config.health.dbTimeoutMs);
    checks.database = { status: 'up' };
  } catch (err) {
    checks.database = { status: 'down', reason: err instanceof Timeout ? 'timeout' : 'unreachable' };
  }
  if (checks.database.status !== 'up') {
    checks.schema = { status: 'not_checked', reason: 'database unavailable' };
  } else {
    try {
      const rows = await timeout(deps.pool.query('SELECT filename FROM schema_migrations ORDER BY filename'), deps.config.health.dbTimeoutMs);
      const applied = rows.map(r => r.filename);
      const missing = expected.filter(f => !applied.includes(f));
      checks.schema = missing.length
        ? { status: 'down', reason: 'migrations pending', pending: missing }
        : { status: 'up', migrations: applied.length };
    } catch (err) {
      checks.schema = { status: 'down', reason: err instanceof Timeout ? 'timeout' : 'schema not readable' };
    }
  }
  try {
    await timeout(deps.anchor.probe(), deps.config.health.dbTimeoutMs);
    checks.audit_anchor = { status: 'up' };
  } catch (err) {
    checks.audit_anchor = { status: 'down', reason: err instanceof Timeout ? 'timeout' : 'anchor store not writable' };
  }
  const ready = Object.values(checks).every(c => c.status === 'up');
  return { httpStatus: ready ? 200 : 503, body: { status: ready ? 'ready' : 'unavailable', checks } };
}

module.exports = { readiness };
