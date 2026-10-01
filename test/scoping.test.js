'use strict';

// Organisation scoping on every path: detail, list, pagination, correction,
// rules, audit, lookups, and client attempts to name an organisation.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { testConfig, resetDatabase, startApp, adminQuery, cleanInvoice, uniqueId, USERS } = require('./helpers/env');

let cfg, app, nw, nwAdmin, ct, ctAdmin;
const nwRecordIds = [];
const ctRecordIds = [];

before(async () => {
  cfg = testConfig();
  await resetDatabase(cfg);
  app = await startApp(cfg);
  nw = await app.login(USERS.northwindClerk);
  nwAdmin = await app.login(USERS.northwindAdmin);
  ct = await app.login(USERS.contosoClerk);
  ctAdmin = await app.login(USERS.contosoAdmin);
  // Interleave inserts so the two organisations' ids alternate.
  for (let i = 0; i < 7; i += 1) {
    nwRecordIds.push((await app.call('POST', '/api/records', { token: nw, body: { submission_id: uniqueId('nw'), payload: cleanInvoice() } })).body.id);
    ctRecordIds.push((await app.call('POST', '/api/records', { token: ct, body: { submission_id: uniqueId('ct'), payload: { reference: `R${i}`, quantity: 3, supplier_code: 'SUP-900' } } })).body.id);
  }
});
after(async () => { await app.close(); });

test('[F08] reading another organisation\'s record by id is 404, identical to a nonexistent id', async () => {
  const foreign = await app.call('GET', `/api/records/${ctRecordIds[0]}`, { token: nw });
  const missing = await app.call('GET', '/api/records/999999', { token: nw });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, missing.body);
  assert.ok(!foreign.text.includes('SUP-900'));
});

test('[F08] guessing every id in range never exposes another organisation\'s record', async () => {
  const max = Math.max(...nwRecordIds, ...ctRecordIds) + 3;
  for (let id = 1; id <= max; id += 1) {
    const r = await app.call('GET', `/api/records/${id}`, { token: nw });
    if (nwRecordIds.includes(id)) assert.equal(r.status, 200, `own record ${id}`);
    else assert.equal(r.status, 404, `id ${id} must be invisible`);
  }
});

test('[S01] paginating the full list returns only own records, each exactly once', async () => {
  const seen = [];
  let after = 0;
  for (let guard = 0; guard < 50; guard += 1) {
    const r = await app.call('GET', `/api/records?limit=2&after=${after}`, { token: nw });
    assert.equal(r.status, 200);
    seen.push(...r.body.items.map(x => x.id));
    if (r.body.next_cursor === null) break;
    after = r.body.next_cursor;
  }
  assert.deepEqual(seen.sort((a, b) => a - b), [...nwRecordIds].sort((a, b) => a - b));
});

test('[S01] a cursor pointing into another organisation\'s id range still returns only own records', async () => {
  const r = await app.call('GET', `/api/records?after=${ctRecordIds[2]}&limit=100`, { token: nw });
  assert.ok(r.body.items.every(x => nwRecordIds.includes(x.id)));
});

test('[S02] correcting another organisation\'s record is 404 and leaves it unchanged', async () => {
  const id = ctRecordIds[1];
  const r = await app.call('PUT', `/api/records/${id}`, { token: nw, body: { payload: { hijacked: true }, expected_version: 1 } });
  assert.equal(r.status, 404);
  const [row] = await adminQuery(cfg, 'SELECT version, payload FROM submitted_records WHERE id = ?', [id]);
  assert.equal(row.version, 1);
  assert.ok(!String(typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)).includes('hijacked'));
});

test('[S03] the audit trail shows only own events, through every page', async () => {
  const [{ id: ctOrg }] = await adminQuery(cfg, "SELECT id FROM organisations WHERE name LIKE 'Contoso%'");
  const ctIds = new Set(ctRecordIds.map(String));
  let after = 0;
  let total = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const r = await app.call('GET', `/api/audit?after_seq=${after}&limit=3`, { token: nwAdmin });
    assert.equal(r.status, 200);
    for (const e of r.body.items) {
      assert.ok(!(e.entity_type === 'record' && ctIds.has(e.entity_id)), `foreign record event leaked: ${JSON.stringify(e)}`);
      assert.ok(!(e.entity_type === 'organisation' && e.entity_id === String(ctOrg)));
    }
    total += r.body.items.length;
    if (r.body.next_cursor === null) break;
    after = r.body.next_cursor;
  }
  const [{ n }] = await adminQuery(cfg, "SELECT COUNT(*) AS n FROM audit_log a JOIN organisations o ON o.id = a.org_id WHERE o.name LIKE 'Northwind%'");
  assert.equal(total, n);
});

test('[S03] audit verification covers only the caller\'s chain', async () => {
  const a = await app.call('GET', '/api/audit/verify', { token: nwAdmin });
  const b = await app.call('GET', '/api/audit/verify', { token: ctAdmin });
  assert.equal(a.body.verdict, 'intact'); assert.equal(b.body.verdict, 'intact');
  assert.notEqual(a.body.chain.head.hash, b.body.chain.head.hash);
});

test('[S04] another organisation\'s rules cannot be read or changed', async () => {
  const [{ id }] = await adminQuery(cfg, "SELECT r.id FROM validation_rules r JOIN organisations o ON o.id = r.org_id WHERE o.name LIKE 'Contoso%' LIMIT 1");
  assert.equal((await app.call('GET', `/api/rules/${id}`, { token: nwAdmin })).status, 404);
  assert.equal((await app.call('PATCH', `/api/rules/${id}`, { token: nwAdmin, body: { expected_version: 1, active: false } })).status, 404);
  const [row] = await adminQuery(cfg, 'SELECT active, version FROM validation_rules WHERE id = ?', [id]);
  assert.deepEqual([row.active, row.version], [1, 1]);
  const list = await app.call('GET', '/api/rules?include_inactive=true&limit=100', { token: nwAdmin });
  assert.ok(!list.body.items.some(r => r.id === id));
});

test('[S05] a client-supplied organisation parameter is refused, not honoured', async () => {
  const [{ id: ctOrg }] = await adminQuery(cfg, "SELECT id FROM organisations WHERE name LIKE 'Contoso%'");
  const q = await app.call('GET', `/api/records?org_id=${ctOrg}`, { token: nw });
  assert.equal(q.status, 400);
  assert.equal(q.body.error, 'org_scope_not_accepted');
  const b = await app.call('POST', '/api/records', { token: nw, body: { submission_id: uniqueId('x'), payload: {}, org_id: ctOrg } });
  assert.equal(b.status, 400);
});

test('[S06] lookups are scoped: a code registered only to another organisation is not found', async () => {
  // SUP-900 exists only for Contoso.
  const r = await app.call('POST', '/api/records', { token: nw, body: { submission_id: uniqueId('lk'), payload: cleanInvoice({ supplier_code: 'SUP-900' }) } });
  const sup = r.body.results.find(x => x.rule_name === 'Supplier is known');
  assert.deepEqual([sup.status, sup.code], ['fail', 'not_found']);
});
