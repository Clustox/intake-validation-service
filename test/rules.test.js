'use strict';

// Rules are data; rule administration; a rule deactivated mid-run.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { testConfig, resetDatabase, startApp, adminQuery, cleanInvoice, uniqueId, USERS, createAdminConnection } = require('./helpers/env');

let cfg, app, admin, clerk, orgId;

before(async () => {
  cfg = testConfig({ engine: { ruleTimeoutMs: 8000 } });
  await resetDatabase(cfg);
  app = await startApp(cfg);
  admin = await app.login(USERS.northwindAdmin);
  clerk = await app.login(USERS.northwindClerk);
  [{ org_id: orgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.northwindAdmin]);
});
after(async () => { await app.close(); });

const submit = payload => app.call('POST', '/api/records', { token: clerk, body: { submission_id: uniqueId('r'), payload } });
const resultFor = (rec, name) => rec.results.find(x => x.rule_name === name);

test('[R01] a rule inserted as a database row applies to the next submission with no code change or restart', async () => {
  const before = await submit(cleanInvoice({ po_number: 'bad' }));
  assert.equal(before.body.verdict, 'clean');
  await adminQuery(cfg,
    'INSERT INTO validation_rules (org_id, name, rule_type, field, config, message) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, 'PO number format (inserted by SQL)', 'regex', 'po_number', JSON.stringify({ pattern: '^PO-\\d{6}$', optional: true }), 'PO number must look like PO-123456.']);
  const bad = await submit(cleanInvoice({ po_number: 'bad' }));
  assert.equal(bad.body.verdict, 'failed');
  const r = resultFor(bad.body, 'PO number format (inserted by SQL)');
  assert.deepEqual([r.status, r.message], ['fail', 'PO number must look like PO-123456.']);
  assert.equal((await submit(cleanInvoice({ po_number: 'PO-123456' }))).body.verdict, 'clean');
});

test('[R01] a threshold changed in the database takes effect immediately', async () => {
  await adminQuery(cfg, "UPDATE validation_rules SET config = JSON_SET(config, '$.max', 1000), version = version + 1 WHERE org_id = ? AND name = 'Amount within approval limit'", [orgId]);
  try {
    assert.equal((await submit(cleanInvoice({ amount: 1000.01 }))).body.verdict, 'failed');
    assert.equal((await submit(cleanInvoice({ amount: 1000 }))).body.verdict, 'clean');
  } finally {
    await adminQuery(cfg, "UPDATE validation_rules SET config = JSON_SET(config, '$.max', 50000), version = version + 1 WHERE org_id = ? AND name = 'Amount within approval limit'", [orgId]);
  }
});

test('[R02] a malformed rule row in the database yields unknown for that rule, never pass', async () => {
  const { insertId } = await adminQuery(cfg,
    'INSERT INTO validation_rules (org_id, name, rule_type, field, config, message) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, 'Broken range', 'range', 'amount', JSON.stringify({ min: 'ten' }), 'broken']);
  try {
    const rec = await submit(cleanInvoice());
    const r = resultFor(rec.body, 'Broken range');
    assert.deepEqual([r.status, r.code], ['unknown', 'invalid_rule_config']);
    assert.equal(rec.body.verdict, 'incomplete');
  } finally {
    await adminQuery(cfg, 'UPDATE validation_rules SET active = 0 WHERE id = ?', [insertId]);
  }
});

test('[R03] the admin API creates a rule that applies immediately, and audits it', async () => {
  const r = await app.call('POST', '/api/rules', { token: admin, body: {
    name: 'Currency required', rule_type: 'required', field: 'currency', config: {}, message: 'Currency is required.' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.version, 1);
  const rec = await submit(cleanInvoice({ currency: undefined }));
  assert.equal(resultFor(rec.body, 'Currency required').status, 'fail');
  const [ev] = await adminQuery(cfg, "SELECT action FROM audit_log WHERE org_id = ? AND entity_type = 'rule' AND entity_id = ?", [orgId, String(r.body.id)]);
  assert.equal(ev.action, 'rule.created');
});

test('[R03] the admin API rejects invalid rule definitions with the reasons', async () => {
  const bad = [
    { name: 'a', rule_type: 'teleport', field: 'x', config: {}, message: 'm' },
    { name: 'b', rule_type: 'range', field: 'x', config: {}, message: 'm' },
    { name: 'c', rule_type: 'range', field: 'x', config: { min: 5, max: 1 }, message: 'm' },
    { name: 'd', rule_type: 'regex', field: 'x', config: { pattern: '([' }, message: 'm' },
    { name: 'e', rule_type: 'lookup', field: 'x', config: { table: 'users', column: 'password_hash' }, message: 'm' },
    { name: 'f', rule_type: 'required', field: 'x; DROP TABLE', config: {}, message: 'm' },
    { name: 'g', rule_type: 'required', field: 'x', config: {}, message: '' },
  ];
  for (const body of bad) {
    const r = await app.call('POST', '/api/rules', { token: admin, body });
    assert.equal(r.status, 400, body.name);
    assert.equal(r.body.error, 'invalid_rule', body.name);
    assert.ok(r.body.errors.length > 0);
  }
});

test('[R03] rule updates require the current version and bump it', async () => {
  const [rule] = (await app.call('GET', '/api/rules', { token: admin })).body.items;
  const stale = await app.call('PATCH', `/api/rules/${rule.id}`, { token: admin, body: { expected_version: rule.version + 5, message: 'x' } });
  assert.equal(stale.status, 409);
  const ok = await app.call('PATCH', `/api/rules/${rule.id}`, { token: admin, body: { expected_version: rule.version, message: 'Updated message.' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, rule.version + 1);
});

test('[F10] a rule deactivated while a submission is being evaluated is reported, and not applied afterwards', async () => {
  const [target] = await adminQuery(cfg, "SELECT id, version FROM validation_rules WHERE org_id = ? AND name = 'Amount within approval limit'", [orgId]);
  const lock = await createAdminConnection(cfg.db);
  let inFlight;
  try {
    // Hold the lookup table so evaluation is provably in progress while we act.
    await lock.query('LOCK TABLES ref_suppliers WRITE');
    inFlight = submit(cleanInvoice({ amount: 999999 }));
    await waitFor(async () => {
      const [{ n }] = await adminQuery(cfg, "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE STATE LIKE 'Waiting for table metadata lock%' AND INFO LIKE '%ref_suppliers%'");
      return n > 0;
    });
    const off = await app.call('PATCH', `/api/rules/${target.id}`, { token: admin, body: { expected_version: target.version, active: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.active, false);
  } finally {
    await lock.query('UNLOCK TABLES');
    await lock.end();
  }
  const rec = (await inFlight).body;
  // The run used the rule set as it stood when evaluation started, says which
  // version it applied, and flags that the rule changed underneath it.
  const r = rec.results.find(x => x.rule_id === target.id);
  assert.equal(r.rule_version, target.version);
  assert.equal(r.status, 'fail');
  assert.deepEqual(rec.summary.rules_changed_during_evaluation, [target.id]);
  assert.ok(rec.summary.notes.some(n => n.includes('changed or were deactivated during evaluation')));
  const [ev] = await adminQuery(cfg, "SELECT data FROM audit_log WHERE action = 'record.submitted' AND entity_id = ?", [String(rec.id)]);
  const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
  assert.deepEqual(data.rules_changed_during_evaluation, [target.id]);
  // The next submission no longer runs the deactivated rule.
  const next = (await submit(cleanInvoice({ amount: 999999 }))).body;
  assert.equal(next.results.find(x => x.rule_id === target.id), undefined);
  assert.equal(next.verdict, 'clean');
  assert.deepEqual(next.summary.rules_changed_during_evaluation, []);
});

async function waitFor(check, { timeoutMs = 5000, everyMs = 25 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error('condition not reached in time');
}
