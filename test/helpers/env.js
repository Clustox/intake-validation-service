'use strict';

// Shared test harness: a fresh MariaDB test database per test file, the real
// Express app on an ephemeral port, and a small HTTP client (Node's fetch).

process.env.BCRYPT_COST = process.env.TEST_BCRYPT_COST || '4'; // fast hashing in tests only

const os = require('node:os');
const path = require('node:path');
const config = require('../../src/config');
const { createPool, createAdminConnection } = require('../../src/db');
const { createApp } = require('../../src/app');
const { migrate } = require('../../scripts/lib/migrator');
const { seed } = require('../../scripts/seed');
const { AnchorStore } = require('../../src/anchor');

const PASSWORD = 'Test-Only-Password-123';
const USERS = {
  northwindAdmin: 'admin@northwind.example',
  northwindClerk: 'clerk@northwind.example',
  contosoAdmin: 'admin@contoso.example',
  contosoClerk: 'clerk@contoso.example',
};

// Each test file runs in its own process; give each its own database so files
// can never interfere, even if run in parallel.
function testDatabaseName(base) {
  const file = path.basename(process.argv[1] || 'adhoc', '.js').replace(/\.test$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  return `${base}_${file}`.slice(0, 64);
}

function testConfig(overrides = {}) {
  const base = config.load();
  const cfg = config.load({ dbName: testDatabaseName(base.db.testDatabase) });
  return {
    ...cfg,
    ...overrides,
    db: { ...cfg.db, ...(overrides.db || {}) },
    engine: { ...cfg.engine, ...(overrides.engine || {}) },
    health: { ...cfg.health, ...(overrides.health || {}) },
    api: { ...cfg.api, ...(overrides.api || {}) },
    // Test anchors live outside the project; files are scoped by database name.
    anchor: { ...cfg.anchor, dir: path.join(os.tmpdir(), 'ivs-test-anchors'), ...(overrides.anchor || {}) },
  };
}

const anchorStore = cfg => new AnchorStore(cfg.anchor, cfg.db.database);

async function resetDatabase(cfg) {
  await migrate(cfg.db, { fresh: true });
  await anchorStore(cfg).clear();
  await seed(cfg, { password: PASSWORD });
}

const silentLogger = { error() {}, log() {} };

async function startApp(cfg, { pool } = {}) {
  const ownPool = pool || createPool(cfg.db);
  const app = createApp({ config: cfg, pool: ownPool, logger: silentLogger });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    pool: ownPool,
    call: (method, path, opts) => call(baseUrl, method, path, opts),
    login: email => login(baseUrl, email),
    async close() {
      server.closeAllConnections?.();
      await new Promise(r => server.close(r));
      if (!pool) await ownPool.end().catch(() => {});
    },
  };
}

async function call(baseUrl, method, path, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = h['content-type'] || 'application/json'; }
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, body: json, text, headers: Object.fromEntries(res.headers) };
}

async function login(baseUrl, email) {
  const r = await call(baseUrl, 'POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return r.body.token;
}

async function adminQuery(cfg, sql, params) {
  const conn = await createAdminConnection(cfg.db);
  try { return await conn.query(sql, params); } finally { await conn.end(); }
}

// A payload that passes every Northwind seed rule.
const cleanInvoice = (overrides = {}) => ({
  invoice_number: 'INV-2026-0001', amount: 1200.5, currency: 'EUR',
  invoice_date: '2026-09-01', due_date: '2026-10-01', supplier_code: 'SUP-100', ...overrides,
});

let seq = 0;
const uniqueId = prefix => `${prefix}-${process.pid}-${Date.now()}-${++seq}`;

module.exports = { anchorStore, testConfig, resetDatabase, startApp, call, adminQuery, cleanInvoice, uniqueId, USERS, PASSWORD, createAdminConnection, createPool };
