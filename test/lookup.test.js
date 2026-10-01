'use strict';

// Lookup rules against real reference tables (seed fixtures): a missing table must produce
// unknown, never pass.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { testConfig, resetDatabase, startApp, adminQuery, cleanInvoice, uniqueId, USERS } = require('./helpers/env');

let cfg, app, clerk;

before(async () => {
  cfg = testConfig();
  await resetDatabase(cfg);
  app = await startApp(cfg);
  clerk = await app.login(USERS.northwindClerk);
});
after(async () => { await app.close(); });

const submit = payload => app.call('POST', '/api/records', { token: clerk, body: { submission_id: uniqueId('lk'), payload } });
const supplierResult = rec => rec.results.find(x => x.rule_name === 'Supplier is known');

test('[M01] the migrations create exactly the five specified tables; lookup reference tables come from the seed', async () => {
  const { migrate } = require('../scripts/lib/migrator');
  const scratch = `${cfg.db.database}_schema`.slice(0, 64);
  const tablesIn = async db => (await adminQuery(cfg, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [db])).map(r => r.t);
  await migrate(cfg.db, { database: scratch, fresh: true });
  try {
    assert.deepEqual(await tablesIn(scratch),
      ['audit_log', 'organisations', 'schema_migrations', 'submitted_records', 'users', 'validation_rules'],
      'five specified tables plus the migration tracker, nothing else');
  } finally {
    await adminQuery(cfg, `DROP DATABASE \`${scratch}\``);
  }
  // The seeded test database additionally holds the two fixture tables.
  assert.deepEqual((await tablesIn(cfg.db.database)).filter(t => t.startsWith('ref_')), ['ref_cost_centres', 'ref_suppliers']);
});

test('[L01] known code passes, unknown code fails', async () => {
  assert.equal(supplierResult((await submit(cleanInvoice())).body).status, 'pass');
  const r = supplierResult((await submit(cleanInvoice({ supplier_code: 'SUP-404' }))).body);
  assert.deepEqual([r.status, r.code], ['fail', 'not_found']);
});

test('[F02] a missing lookup table produces unknown, not pass, and the record is not clean', async () => {
  await adminQuery(cfg, 'RENAME TABLE ref_suppliers TO ref_suppliers_offline');
  try {
    const rec = (await submit(cleanInvoice())).body;
    const r = supplierResult(rec);
    assert.deepEqual([r.status, r.code], ['unknown', 'lookup_target_missing']);
    assert.equal(rec.verdict, 'incomplete');
    assert.equal(rec.fully_evaluated, false);
    assert.equal(rec.summary.unknown, 1);
    // Every other rule still ran and passed: only the lookup is unknown.
    assert.ok(rec.results.filter(x => x !== r).every(x => x.status === 'pass' || x.status === 'skipped'));
  } finally {
    await adminQuery(cfg, 'RENAME TABLE ref_suppliers_offline TO ref_suppliers');
  }
  assert.equal((await submit(cleanInvoice())).body.verdict, 'clean');
});

test('[F02] a lookup rule whose column does not exist produces unknown', async () => {
  const [{ org_id: orgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.northwindClerk]);
  const { insertId } = await adminQuery(cfg,
    'INSERT INTO validation_rules (org_id, name, rule_type, field, config, message) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, 'Cost centre by wrong column', 'lookup', 'cost_centre', JSON.stringify({ table: 'ref_cost_centres', column: 'code' }), 'x']);
  await adminQuery(cfg, 'ALTER TABLE ref_cost_centres RENAME COLUMN code TO code_renamed');
  try {
    const rec = (await submit(cleanInvoice({ cost_centre: 'CC-OPS' }))).body;
    const r = rec.results.find(x => x.rule_id === insertId);
    assert.deepEqual([r.status, r.code], ['unknown', 'lookup_target_missing']);
    assert.equal(rec.verdict, 'incomplete');
  } finally {
    await adminQuery(cfg, 'ALTER TABLE ref_cost_centres RENAME COLUMN code_renamed TO code');
    await adminQuery(cfg, 'UPDATE validation_rules SET active = 0 WHERE id = ?', [insertId]);
  }
});

test('[F02] a lookup rule pointing outside the allowlist produces unknown', async () => {
  const [{ org_id: orgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.northwindClerk]);
  const { insertId } = await adminQuery(cfg,
    'INSERT INTO validation_rules (org_id, name, rule_type, field, config, message) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, 'Sneaky lookup', 'lookup', 'supplier_code', JSON.stringify({ table: 'users', column: 'email' }), 'x']);
  try {
    const r = (await submit(cleanInvoice())).body.results.find(x => x.rule_id === insertId);
    assert.deepEqual([r.status, r.code], ['unknown', 'invalid_rule_config']);
  } finally {
    await adminQuery(cfg, 'UPDATE validation_rules SET active = 0 WHERE id = ?', [insertId]);
  }
});

// ---- The allow-list fails closed --------------------------------------------

async function insertRule(name, config, field = 'supplier_code') {
  const [{ org_id: orgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.northwindClerk]);
  const { insertId } = await adminQuery(cfg,
    'INSERT INTO validation_rules (org_id, name, rule_type, field, config, message) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, name, 'lookup', field, JSON.stringify(config), 'x']);
  return insertId;
}
const deactivate = id => adminQuery(cfg, 'UPDATE validation_rules SET active = 0 WHERE id = ?', [id]);

test('[L02] a lookup naming a table not on the allow-list is unknown even when the value would match there', async () => {
  // users.email really contains this value: without the allow-list this lookup would pass.
  const id = await insertRule('Off-list lookup that would match', { table: 'users', column: 'email' }, 'contact');
  try {
    const r = await submit(cleanInvoice({ contact: USERS.northwindClerk }));
    assert.equal(r.status, 201, 'not a crash');
    const res = r.body.results.find(x => x.rule_id === id);
    assert.deepEqual([res.status, res.code], ['unknown', 'invalid_rule_config']);
    assert.match(res.detail, /not in LOOKUP_ALLOWLIST/);
    assert.equal(r.body.verdict, 'incomplete');
    assert.equal(r.body.fully_evaluated, false);
  } finally {
    await deactivate(id);
  }
});

test('[L02] identifiers that try to escape the allow-list are unknown and touch nothing', async () => {
  const attempts = [
    { table: 'ref_suppliers`; DROP TABLE ref_suppliers; --', column: 'code' },
    { table: 'ref_suppliers', column: 'code` OR 1=1 OR `code' },
    { table: 'REF_SUPPLIERS', column: 'code' },
    { table: 'ivs.ref_suppliers', column: 'code' },
    { table: 'ref_suppliers', column: 'code', extra: 'ignored?' },
  ];
  const ids = [];
  for (const [i, c] of attempts.entries()) ids.push(await insertRule(`Escape attempt ${i}`, c));
  try {
    const r = await submit(cleanInvoice({ supplier_code: 'SUP-404' }));
    assert.equal(r.status, 201);
    for (const id of ids) {
      const res = r.body.results.find(x => x.rule_id === id);
      assert.deepEqual([res.status, res.code], ['unknown', 'invalid_rule_config'], `rule ${id}`);
    }
    const [{ n }] = await adminQuery(cfg, 'SELECT COUNT(*) AS n FROM ref_suppliers');
    assert.ok(n > 0, 'reference table intact');
  } finally {
    for (const id of ids) await deactivate(id);
  }
});

test('[L02] the admin API refuses to create a lookup rule outside the allow-list', async () => {
  const admin = await app.login(USERS.northwindAdmin);
  const r = await app.call('POST', '/api/rules', { token: admin, body: {
    name: 'Off-list via API', rule_type: 'lookup', field: 'x', config: { table: 'users', column: 'email' }, message: 'm' } });
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.some(e => /LOOKUP_ALLOWLIST/.test(e)));
});

test('[L02] with an empty allow-list every lookup is unknown: fails closed, not open', async () => {
  const closed = await startApp({ ...cfg, engine: { ...cfg.engine, lookupAllowlist: new Set() } });
  try {
    const token = await closed.login(USERS.northwindClerk);
    const r = await closed.call('POST', '/api/records', { token, body: { submission_id: uniqueId('closed'), payload: cleanInvoice() } });
    assert.equal(r.status, 201);
    const lookups = r.body.results.filter(x => x.rule_type === 'lookup' && x.status !== 'skipped');
    assert.ok(lookups.length > 0);
    assert.ok(lookups.every(x => x.status === 'unknown'));
    assert.equal(r.body.verdict, 'incomplete');
  } finally {
    await closed.close();
  }
});
