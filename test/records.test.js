'use strict';

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { testConfig, resetDatabase, startApp, adminQuery, cleanInvoice, uniqueId, USERS } = require('./helpers/env');

let cfg, app, token, orgId;

before(async () => {
  cfg = testConfig();
  await resetDatabase(cfg);
  app = await startApp(cfg);
  token = await app.login(USERS.northwindClerk);
  [{ org_id: orgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.northwindClerk]);
});
after(async () => { await app.close(); });

const submit = (body, opts = {}) => app.call('POST', '/api/records', { token, body, ...opts });
const countRecords = async sid => (await adminQuery(cfg, 'SELECT COUNT(*) AS n FROM submitted_records WHERE submission_id = ?', [sid]))[0].n;
const countAudit = async action => (await adminQuery(cfg, 'SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND action = ?', [orgId, action]))[0].n;

test('[C01] a fully valid record is reported checked and clean', async () => {
  const r = await submit({ submission_id: uniqueId('ok'), payload: cleanInvoice() });
  assert.equal(r.status, 201);
  assert.equal(r.body.verdict, 'clean');
  assert.equal(r.body.fully_evaluated, true);
  assert.equal(r.body.summary.unknown, 0);
  assert.ok(r.body.results.every(x => x.status === 'pass' || x.status === 'skipped'));
});

test('[C02] a record carrying an unknown is reported incomplete, never clean', async () => {
  const r = await submit({ submission_id: uniqueId('unk'), payload: cleanInvoice({ supplier_code: undefined }) });
  assert.equal(r.status, 201);
  assert.equal(r.body.verdict, 'incomplete');
  assert.equal(r.body.fully_evaluated, false);
  const sup = r.body.results.find(x => x.rule_name === 'Supplier is known');
  assert.deepEqual([sup.status, sup.code], ['unknown', 'field_absent']);
  // the persisted record agrees with the response
  const g = await app.call('GET', `/api/records/${r.body.id}`, { token });
  assert.equal(g.body.verdict, 'incomplete');
});

// ---- malformed payload ------------------------------------------------------

test('[F03] body that is not valid JSON is rejected with 400 and nothing is stored', async () => {
  const before = (await adminQuery(cfg, 'SELECT COUNT(*) AS n FROM submitted_records'))[0].n;
  const r = await app.call('POST', '/api/records', { token, raw: '{"submission_id": "x", "payload": {', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'malformed_json');
  assert.equal((await adminQuery(cfg, 'SELECT COUNT(*) AS n FROM submitted_records'))[0].n, before);
});

test('[F03] non-object bodies and payloads are rejected with 400', async () => {
  for (const [body, code] of [[[], 'malformed_body'], ['text', 'malformed_json'], [42, 'malformed_json'],
    [{ submission_id: 'a1', payload: [] }, 'invalid_payload'], [{ submission_id: 'a1', payload: 'x' }, 'invalid_payload'],
    [{ submission_id: 'a1', payload: null }, 'invalid_payload']]) {
    const r = await app.call('POST', '/api/records', { token, raw: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, code, JSON.stringify(body));
  }
});

test('[F03] unexpected top-level fields and bad submission ids are rejected', async () => {
  assert.equal((await submit({ submission_id: 'a1', payload: {}, extra: 1 })).body.error, 'unknown_fields');
  for (const sid of ['', ' spaced id', 'x'.repeat(101), 5, '../etc']) {
    assert.equal((await submit({ submission_id: sid, payload: {} })).body.error, 'invalid_submission_id', String(sid));
  }
});

test('[F03] a payload with invalid Unicode (unpaired surrogate) is 400, not a server error', async () => {
  for (const raw of [`{"submission_id":"${uniqueId('u')}","payload":{"name":"\\ud800"}}`, `{"submission_id":"${uniqueId('u')}","payload":{"\\udfff":1}}`]) {
    const r = await app.call('POST', '/api/records', { token, raw, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400, raw);
    assert.equal(r.body.error, 'invalid_payload');
  }
  // A correctly paired surrogate (an emoji) is valid and accepted.
  const ok = await app.call('POST', '/api/records', { token, raw: `{"submission_id":"${uniqueId('u')}","payload":{"note":"\\ud83e\\uddfe"}}`, headers: { 'content-type': 'application/json' } });
  assert.equal(ok.status, 201);
});

test('[F03] wrong content type is 415, oversized body is 413', async () => {
  const a = await app.call('POST', '/api/records', { token, raw: 'submission_id=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(a.status, 415);
  const big = await submit({ submission_id: uniqueId('big'), payload: { blob: 'x'.repeat(cfg.api.maxBodyBytes) } });
  assert.equal(big.status, 413);
});

// ---- missing required fields -------------------------------------------------

test('[F04] missing envelope fields are rejected with 400 naming them', async () => {
  const r = await submit({});
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'missing_fields');
  assert.deepEqual(r.body.fields.sort(), ['payload', 'submission_id']);
});

test('[F04] payload missing required fields fails validation and names each field', async () => {
  const r = await submit({ submission_id: uniqueId('req'), payload: cleanInvoice({ invoice_number: undefined, amount: null }) });
  assert.equal(r.status, 201);
  assert.equal(r.body.verdict, 'failed');
  const failed = r.body.results.filter(x => x.rule_type === 'required' && x.status === 'fail').map(x => x.field).sort();
  assert.deepEqual(failed, ['amount', 'invoice_number']);
  // dependent rules on the absent fields could not decide: unknown, not pass
  const range = r.body.results.find(x => x.rule_type === 'range' && x.field === 'amount');
  assert.equal(range.status, 'unknown');
  assert.equal(r.body.fully_evaluated, false);
});

test('[F04] an empty payload fails, it is not clean', async () => {
  const r = await submit({ submission_id: uniqueId('empty'), payload: {} });
  assert.equal(r.body.verdict, 'failed');
  assert.notEqual(r.body.verdict, 'clean');
});

// ---- duplicate submission -----------------------------------------------------

test('[F09] resubmitting the same submission_id and payload returns the original, stores nothing new', async () => {
  const sid = uniqueId('dup');
  const first = await submit({ submission_id: sid, payload: cleanInvoice() });
  const auditBefore = await countAudit('record.submitted');
  const second = await submit({ submission_id: sid, payload: cleanInvoice() });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.verdict, first.body.verdict);
  assert.equal(await countRecords(sid), 1);
  assert.equal(await countAudit('record.submitted'), auditBefore);
});

test('[F09] same payload with keys in a different order is still the same submission', async () => {
  const sid = uniqueId('dup-order');
  const p = cleanInvoice();
  await submit({ submission_id: sid, payload: p });
  const reordered = Object.fromEntries(Object.entries(p).reverse());
  const r = await submit({ submission_id: sid, payload: reordered });
  assert.equal(r.status, 200);
  assert.equal(r.body.replayed, true);
});

test('[F09] a replay is labelled as a replay and cannot be mistaken for a fresh evaluation', async () => {
  const sid = uniqueId('replay');
  const fresh = await submit({ submission_id: sid, payload: cleanInvoice() });
  assert.equal(fresh.body.replayed, false);
  assert.equal(fresh.headers['idempotent-replayed'], undefined);
  // Change the rules so a fresh evaluation would now give a different answer.
  await adminQuery(cfg, "UPDATE validation_rules SET config = JSON_SET(config, '$.max', 100), version = version + 1 WHERE org_id = ? AND name = 'Amount within approval limit'", [orgId]);
  try {
    const again = await submit({ submission_id: sid, payload: cleanInvoice() });
    assert.equal(again.status, 200);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.replay.result_evaluated_at, fresh.body.evaluated_at);
    assert.equal(again.body.replay.record_version, 1);
    assert.match(again.body.replay.note, /not evaluated again/);
    // It carries the stored result, not a re-evaluation under the new rules.
    assert.equal(again.body.verdict, 'clean');
    const [ev] = await adminQuery(cfg, "SELECT action FROM audit_log WHERE org_id = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1", [orgId, String(fresh.body.id)]);
    assert.equal(ev.action, 'record.replayed');
  } finally {
    await adminQuery(cfg, "UPDATE validation_rules SET config = JSON_SET(config, '$.max', 50000), version = version + 1 WHERE org_id = ? AND name = 'Amount within approval limit'", [orgId]);
  }
});

test('[F09] reusing a submission_id with a different payload is a 409 conflict', async () => {
  const sid = uniqueId('dup-conflict');
  const first = await submit({ submission_id: sid, payload: cleanInvoice() });
  const r = await submit({ submission_id: sid, payload: cleanInvoice({ amount: 99 }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'submission_id_conflict');
  assert.equal(r.body.existing_record_id, first.body.id);
  assert.equal(await countRecords(sid), 1);
});

test('[F09] concurrent duplicate submissions create exactly one record', async () => {
  const sid = uniqueId('dup-race');
  const results = await Promise.all([...Array(8)].map(() => submit({ submission_id: sid, payload: cleanInvoice() })));
  const statuses = results.map(r => r.status).sort();
  assert.equal(statuses.filter(s => s === 201).length, 1, `statuses: ${statuses}`);
  assert.ok(statuses.every(s => s === 201 || s === 200), `statuses: ${statuses}`);
  assert.equal(new Set(results.map(r => r.body.id)).size, 1);
  assert.equal(await countRecords(sid), 1);
});

test('[F09] the same submission_id in another organisation is independent', async () => {
  const sid = uniqueId('dup-org');
  await submit({ submission_id: sid, payload: cleanInvoice() });
  const contoso = await app.login(USERS.contosoClerk);
  const r = await app.call('POST', '/api/records', { token: contoso, body: { submission_id: sid, payload: { reference: 'R1', quantity: 1, supplier_code: 'SUP-900' } } });
  assert.equal(r.status, 201);
  assert.equal(r.body.verdict, 'clean');
});

// ---- numeric boundaries through the API ---------------------------------------

test('[F11] amount boundaries through the API (seed rule: 0.01..50000 inclusive)', async () => {
  for (const [amount, verdict] of [[0.01, 'clean'], [50000, 'clean'], [0.009, 'failed'], [50000.01, 'failed'], [0, 'failed'], [-5, 'failed'], ['1000', 'failed']]) {
    const r = await submit({ submission_id: uniqueId('bound'), payload: cleanInvoice({ amount }) });
    assert.equal(r.body.verdict, verdict, `amount=${JSON.stringify(amount)}`);
  }
});

test('[F11] numbers beyond double precision are not silently accepted as in range', async () => {
  const r = await app.call('POST', '/api/records', { token, raw: `{"submission_id":"${uniqueId('huge')}","payload":${JSON.stringify(cleanInvoice()).replace('1200.5', '1e400')}}`, headers: { 'content-type': 'application/json' } });
  // 1e400 parses to Infinity, which is not a finite number
  assert.equal(r.body.verdict, 'failed');
  assert.equal(r.body.results.find(x => x.rule_type === 'range').code, 'not_a_number');
});

// ---- correction ----------------------------------------------------------------

test('[C03] correcting a record re-validates it, bumps the version and audits the change', async () => {
  const created = await submit({ submission_id: uniqueId('fix'), payload: cleanInvoice({ amount: 999999 }) });
  assert.equal(created.body.verdict, 'failed');
  const fixed = await app.call('PUT', `/api/records/${created.body.id}`, { token, body: { payload: cleanInvoice(), expected_version: 1 } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.verdict, 'clean');
  assert.equal(fixed.body.version, 2);
  const [ev] = await adminQuery(cfg, "SELECT data FROM audit_log WHERE action = 'record.corrected' AND entity_id = ? ORDER BY seq DESC LIMIT 1", [String(created.body.id)]);
  const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
  assert.equal(data.previous.verdict, 'failed');
  assert.equal(data.verdict, 'clean');
});

test('[C03] a correction against a stale version is a 409 and changes nothing', async () => {
  const created = await submit({ submission_id: uniqueId('stale'), payload: cleanInvoice() });
  await app.call('PUT', `/api/records/${created.body.id}`, { token, body: { payload: cleanInvoice({ amount: 5 }), expected_version: 1 } });
  const stale = await app.call('PUT', `/api/records/${created.body.id}`, { token, body: { payload: cleanInvoice({ amount: 7 }), expected_version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current_version, 2);
  const g = await app.call('GET', `/api/records/${created.body.id}`, { token });
  assert.equal(g.body.payload.amount, 5);
});
