'use strict';

// Unit tests for the rule engine: no database, no HTTP.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine');
const { aggregate } = require('../src/engine/aggregate');

const ctx = (over = {}) => ({
  db: { query: async () => [], escapeId: s => `\`${s}\`` },
  orgId: 1, ruleTimeoutMs: 1000, regexTimeoutMs: 200,
  lookupAllowlist: new Set(['ref_suppliers.code']), ...over,
});
let nextId = 1;
const rule = (rule_type, field, config, extra = {}) => ({ id: nextId++, name: `${rule_type}:${field}`, rule_type, field, config, message: `${field} failed ${rule_type}`, version: 1, ...extra });
const statusOf = async (payload, r, c = ctx()) => (await evaluate(payload, [r], c)).results[0];

// ---- Principle 1: unknown is never folded into pass ------------------------

test('[U01] one unknown among passes makes the record incomplete, not clean', () => {
  const results = [...Array(9)].map(() => ({ status: 'pass' })).concat({ status: 'unknown' });
  const a = aggregate(results);
  assert.equal(a.verdict, 'incomplete');
  assert.equal(a.fully_evaluated, false);
  assert.equal(a.summary.unknown, 1);
});

test('[U01] fail outranks unknown in the verdict but fully_evaluated still reports the gap', () => {
  const a = aggregate([{ status: 'fail' }, { status: 'unknown' }, { status: 'pass' }]);
  assert.equal(a.verdict, 'failed');
  assert.equal(a.fully_evaluated, false);
});

test('[U01] no active rules is incomplete: nothing was checked', () => {
  const a = aggregate([]);
  assert.equal(a.verdict, 'incomplete');
  assert.equal(a.fully_evaluated, false);
  assert.match(a.summary.notes[0], /nothing was checked/);
});

test('[U01] all rules skipped is incomplete: nothing was checked', () => {
  const a = aggregate([{ status: 'skipped' }, { status: 'skipped' }]);
  assert.equal(a.verdict, 'incomplete');
});

test('[U01] clean only when every applicable rule passed', () => {
  const a = aggregate([{ status: 'pass' }, { status: 'skipped' }]);
  assert.equal(a.verdict, 'clean');
  assert.equal(a.fully_evaluated, true);
});

test('[U02] an executor that throws produces unknown, not pass', async () => {
  // escapeId runs outside the executor's own error handling, so this is an uncaught throw.
  const c = ctx({ db: { query: async () => [], escapeId: () => { throw new Error('unexpected'); } } });
  const r = await statusOf({ s: 'SUP-1' }, rule('lookup', 's', { table: 'ref_suppliers', column: 'code' }), c);
  assert.equal(r.status, 'unknown');
  assert.equal(r.code, 'executor_error');
});

test('[U02] a rule that exceeds its time budget produces unknown', async () => {
  const c = ctx({ ruleTimeoutMs: 50, db: { query: () => new Promise(r => setTimeout(() => r([{ found: 1 }]), 500)), escapeId: s => s } });
  const r = await statusOf({ s: 'SUP-1' }, rule('lookup', 's', { table: 'ref_suppliers', column: 'code' }), c);
  assert.equal(r.status, 'unknown');
  assert.equal(r.code, 'rule_timeout');
});

test('[U02] an unreachable lookup produces unknown with lookup_unavailable', async () => {
  const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const c = ctx({ db: { query: async () => { throw err; }, escapeId: s => s } });
  const r = await statusOf({ s: 'SUP-1' }, rule('lookup', 's', { table: 'ref_suppliers', column: 'code' }), c);
  assert.deepEqual([r.status, r.code], ['unknown', 'lookup_unavailable']);
});

test('[U02] absent data a rule needs produces unknown; optional absent produces skipped', async () => {
  assert.equal((await statusOf({}, rule('range', 'amount', { min: 0 }))).status, 'unknown');
  assert.equal((await statusOf({}, rule('range', 'amount', { min: 0, optional: true }))).status, 'skipped');
  assert.equal((await statusOf({ a: 5 }, rule('cross_field', 'a', { other_field: 'b', operator: 'lt', compare_as: 'number' }))).status, 'unknown');
});

test('[U03] a catastrophic regex is cut off as unknown without blocking the event loop', async () => {
  const evil = rule('regex', 's', { pattern: '^(a+)+$' });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  const started = Date.now();
  const r = await statusOf({ s: `${'a'.repeat(40)}!` }, evil, ctx({ regexTimeoutMs: 200 }));
  clearInterval(timer);
  assert.deepEqual([r.status, r.code], ['unknown', 'evaluation_timeout']);
  assert.ok(Date.now() - started < 2000, 'returned promptly');
  assert.ok(ticks >= 5, `event loop kept running (${ticks} ticks)`);
});

test('[R02] a stored rule with invalid config is unknown, not pass', async () => {
  const r = await statusOf({ amount: 5 }, rule('range', 'amount', { min: 'zero' }));
  assert.deepEqual([r.status, r.code], ['unknown', 'invalid_rule_config']);
});

test('[R02] a stored rule of an unsupported type is unknown, not pass', async () => {
  const r = await statusOf({ amount: 5 }, rule('checksum', 'amount', {}));
  assert.deepEqual([r.status, r.code], ['unknown', 'unsupported_rule_type']);
});

test('[R02] a lookup target outside the allowlist is unknown, not pass', async () => {
  const r = await statusOf({ s: 'x' }, rule('lookup', 's', { table: 'users', column: 'email' }));
  assert.deepEqual([r.status, r.code], ['unknown', 'invalid_rule_config']);
});

// ---- Numeric boundaries -----------------------------------------------------

test('[F11] range boundaries: inclusive by default', async () => {
  const r = rule('range', 'amount', { min: 0.01, max: 50000 });
  const cases = [[0.01, 'pass'], [50000, 'pass'], [0.009999, 'fail'], [50000.000001, 'fail'], [0, 'fail'], [-0, 'fail'],
    [-1, 'fail'], [Number.MAX_SAFE_INTEGER, 'fail'], [25000, 'pass']];
  for (const [v, want] of cases) assert.equal((await statusOf({ amount: v }, r)).status, want, `amount=${v}`);
});

test('[F11] range boundaries: exclusive bounds when configured', async () => {
  const r = rule('range', 'n', { min: 0, max: 10, min_inclusive: false, max_inclusive: false });
  for (const [v, want] of [[0, 'fail'], [10, 'fail'], [1e-9, 'pass'], [9.999999, 'pass']]) {
    assert.equal((await statusOf({ n: v }, r)).status, want, `n=${v}`);
  }
});

test('[F11] range: non-numbers fail, they are never coerced', async () => {
  const r = rule('range', 'n', { min: 0, max: 10 });
  for (const v of ['5', '', true, [5], { v: 5 }]) {
    const res = await statusOf({ n: v }, r);
    assert.deepEqual([res.status, res.code], ['fail', 'not_a_number'], `n=${JSON.stringify(v)}`);
  }
});

// ---- Other executors ---------------------------------------------------------

test('[E01] required: missing, null, blank fail; present passes', async () => {
  const r = rule('required', 'x', {});
  for (const [p, want] of [[{}, 'fail'], [{ x: null }, 'fail'], [{ x: '  ' }, 'fail'], [{ x: 0 }, 'pass'], [{ x: false }, 'pass'], [{ x: 'a' }, 'pass']]) {
    assert.equal((await statusOf(p, r)).status, want, JSON.stringify(p));
  }
});

test('[E01] date: calendar validity and bounds', async () => {
  const r = rule('date', 'd', { min: '2020-01-01', max: '2030-12-31' });
  for (const [v, want] of [['2026-02-28', 'pass'], ['2026-02-30', 'fail'], ['2024-02-29', 'pass'], ['2023-02-29', 'fail'],
    ['2020-01-01', 'pass'], ['2019-12-31', 'fail'], ['2030-12-31', 'pass'], ['2031-01-01', 'fail'], ['26-01-01', 'fail'], [20260101, 'fail']]) {
    assert.equal((await statusOf({ d: v }, r)).status, want, `d=${v}`);
  }
});

test('[E01] cross_field: comparison and type mismatch', async () => {
  const r = rule('cross_field', 'due', { other_field: 'inv', operator: 'gte', compare_as: 'date' });
  assert.equal((await statusOf({ due: '2026-10-01', inv: '2026-09-01' }, r)).status, 'pass');
  assert.equal((await statusOf({ due: '2026-09-01', inv: '2026-09-01' }, r)).status, 'pass');
  assert.equal((await statusOf({ due: '2026-08-31', inv: '2026-09-01' }, r)).status, 'fail');
  assert.equal((await statusOf({ due: 'soon', inv: '2026-09-01' }, r)).code, 'type_mismatch');
});

test('[E01] regex: match, no match, non-string', async () => {
  const r = rule('regex', 'c', { pattern: '^(EUR|GBP)$' });
  assert.equal((await statusOf({ c: 'EUR' }, r)).status, 'pass');
  assert.equal((await statusOf({ c: 'eur' }, r)).status, 'fail');
  assert.equal((await statusOf({ c: 978 }, r)).code, 'not_a_string');
});

test('[E01] dotted field paths read own properties only', async () => {
  const r = rule('required', 'supplier.code', {});
  assert.equal((await statusOf({ supplier: { code: 'A' } }, r)).status, 'pass');
  assert.equal((await statusOf({ supplier: {} }, r)).status, 'fail');
  assert.equal((await statusOf({ supplier: 'A' }, rule('required', 'supplier.length', {}))).status, 'fail');
});

test('[E01] failure messages come from the rule row', async () => {
  const r = rule('range', 'n', { max: 1 }, { message: 'Configured message from the database.' });
  assert.equal((await statusOf({ n: 2 }, r)).message, 'Configured message from the database.');
});
