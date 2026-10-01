'use strict';

// A failed dependency must surface as a failure: never a 200, a zero, an empty
// list or a partial write.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { testConfig, resetDatabase, startApp, adminQuery, cleanInvoice, uniqueId, USERS, createPool, createAdminConnection } = require('./helpers/env');
const { createProxy } = require('./helpers/tcp-proxy');

let cfg, direct, proxy, viaProxy, token;

before(async () => {
  cfg = testConfig({ engine: { ruleTimeoutMs: 8000 }, health: { dbTimeoutMs: 1500 } });
  await resetDatabase(cfg);
  direct = await startApp(cfg);
  proxy = await createProxy(cfg.db.host, cfg.db.port);
  const proxiedDb = { ...cfg.db, host: '127.0.0.1', port: proxy.port, acquireTimeoutMs: 1500, connectTimeoutMs: 1000 };
  viaProxy = await startApp({ ...cfg, db: proxiedDb }, { pool: createPool(proxiedDb) });
  token = await direct.login(USERS.northwindClerk);
});
after(async () => {
  await viaProxy.close();
  await viaProxy.pool.end().catch(() => {});
  await direct.close();
  await proxy.cut(); // closes the listener so the process can exit
});

const recordCount = async sid => (await adminQuery(cfg, 'SELECT COUNT(*) AS n FROM submitted_records WHERE submission_id = ?', [sid]))[0].n;
const auditCountFor = async sid => (await adminQuery(cfg, "SELECT COUNT(*) AS n FROM audit_log WHERE JSON_VALUE(data, '$.submission_id') = ?", [sid]))[0].n;

// Wraps a pool so that the connection is destroyed right before a chosen
// statement runs: a real lost connection, in the middle of the transaction.
function poolThatDropsConnectionBefore(pool, pattern) {
  let armed = true;
  const wrapConn = conn => new Proxy(conn, {
    get(c, p) {
      if (p === 'query') {
        return (sql, params) => {
          if (armed && pattern.test(sql)) { armed = false; c.destroy(); }
          return c.query(sql, params);
        };
      }
      const v = c[p];
      return typeof v === 'function' ? v.bind(c) : v;
    },
  });
  return new Proxy(pool, {
    get(t, p) {
      if (p === 'getConnection') return async () => wrapConn(await t.getConnection());
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

test('[F01] connection lost mid-transaction (record written, audit not yet): 503 and nothing persists', async () => {
  const pool = createPool(cfg.db);
  const app = await startApp(cfg, { pool: poolThatDropsConnectionBefore(pool, /INSERT INTO audit_log/) });
  try {
    const sid = uniqueId('midtx');
    const r = await app.call('POST', '/api/records', { token, body: { submission_id: sid, payload: cleanInvoice() } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'dependency_unavailable');
    assert.equal(r.body.dependency, 'database');
    assert.equal(await recordCount(sid), 0, 'the record insert was rolled back');
    assert.equal(await auditCountFor(sid), 0);
    // The same submission succeeds once the database is available again.
    const retry = await app.call('POST', '/api/records', { token, body: { submission_id: sid, payload: cleanInvoice() } });
    assert.equal(retry.status, 201);
    assert.equal(await recordCount(sid), 1);
  } finally {
    await app.close();
    await pool.end().catch(() => {});
  }
});

test('[F01] database becomes unreachable while a submission is being evaluated: 503, nothing recorded', async () => {
  const sid = uniqueId('cut');
  const lock = await createAdminConnection(cfg.db);
  let pending;
  try {
    await lock.query('LOCK TABLES ref_suppliers WRITE'); // hold evaluation at the lookup
    pending = viaProxy.call('POST', '/api/records', { token, body: { submission_id: sid, payload: cleanInvoice() } });
    await waitFor(async () => (await adminQuery(cfg,
      "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE STATE LIKE 'Waiting for table metadata lock%' AND INFO LIKE '%ref_suppliers%'"))[0].n > 0);
    await proxy.cut();
  } finally {
    await lock.query('UNLOCK TABLES');
    await lock.end();
  }
  const r = await pending;
  await proxy.restore();
  assert.equal(r.status, 503, r.text);
  assert.equal(r.body.dependency, 'database');
  assert.equal(await recordCount(sid), 0);
});

test('[H01] readiness reports unhealthy and names the database when it is unreachable; liveness stays up', async () => {
  assert.equal((await viaProxy.call('GET', '/api/health')).status, 200);
  await proxy.cut();
  try {
    const h = await viaProxy.call('GET', '/api/health');
    assert.equal(h.status, 503);
    assert.equal(h.body.status, 'unavailable');
    assert.equal(h.body.checks.database.status, 'down');
    assert.equal(h.body.checks.schema.status, 'not_checked', 'an unchecked dependency is not reported as up');
    assert.ok(!/password|127\.0\.0\.1|ECONN/i.test(h.text), 'no connection details leak');
    const live = await viaProxy.call('GET', '/api/health/live');
    assert.equal(live.status, 200);
  } finally {
    await proxy.restore();
  }
  const back = await viaProxy.call('GET', '/api/health');
  assert.equal(back.status, 200);
  assert.equal(back.body.checks.database.status, 'up');
});

test('[H04] with the database down, reads fail loudly: no empty list, no 401, no zero', async () => {
  await proxy.cut();
  try {
    const list = await viaProxy.call('GET', '/api/records', { token });
    assert.equal(list.status, 503);
    assert.equal(list.body.items, undefined);
    const one = await viaProxy.call('GET', '/api/records/1', { token });
    assert.equal(one.status, 503, 'not 404: absence was not verified');
    const login = await viaProxy.call('POST', '/api/auth/login', { body: { email: USERS.northwindClerk, password: 'whatever' } });
    assert.equal(login.status, 503, 'not 401: credentials were not checked');
    const verify = await viaProxy.call('GET', '/api/audit/verify', { token });
    assert.equal(verify.status, 503);
  } finally {
    await proxy.restore();
  }
});

test('[H03] readiness reports unhealthy when the schema is behind the code', async () => {
  const [row] = await adminQuery(cfg, "SELECT filename, checksum FROM schema_migrations WHERE filename = '005_audit_log.sql'");
  await adminQuery(cfg, 'DELETE FROM schema_migrations WHERE filename = ?', [row.filename]);
  try {
    const h = await direct.call('GET', '/api/health');
    assert.equal(h.status, 503);
    assert.equal(h.body.checks.database.status, 'up');
    assert.equal(h.body.checks.schema.status, 'down');
    assert.deepEqual(h.body.checks.schema.pending, ['005_audit_log.sql']);
  } finally {
    await adminQuery(cfg, 'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)', [row.filename, row.checksum]);
  }
  assert.equal((await direct.call('GET', '/api/health')).status, 200);
});

async function waitFor(check, { timeoutMs = 5000, everyMs = 25 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error('condition not reached in time');
}
