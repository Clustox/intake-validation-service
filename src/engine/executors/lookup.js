'use strict';

const { pass, fail, unknown, getField, isAbsent, absent } = require('../outcome');

const KEYS = new Set(['table', 'column', 'optional']);
const IDENT = /^[a-z_][a-z0-9_]*$/;

function validateConfig(c, ctx) {
  const errors = [];
  for (const k of Object.keys(c)) if (!KEYS.has(k)) errors.push(`unsupported key "${k}"`);
  if (typeof c.table !== 'string' || !IDENT.test(c.table)) errors.push('table must be a lowercase identifier');
  if (typeof c.column !== 'string' || !IDENT.test(c.column)) errors.push('column must be a lowercase identifier');
  if ('optional' in c && typeof c.optional !== 'boolean') errors.push('optional must be boolean');
  if (!errors.length && ctx && !ctx.lookupAllowlist.has(`${c.table}.${c.column}`)) {
    errors.push(`${c.table}.${c.column} is not in LOOKUP_ALLOWLIST`);
  }
  return errors;
}

// ER_NO_SUCH_TABLE / ER_BAD_FIELD_ERROR: the configured target does not exist.
const MISSING_TARGET = new Set([1146, 1054]);

async function run(payload, rule, ctx) {
  const c = rule.config;
  const v = getField(payload, rule.field);
  if (isAbsent(v)) return absent(c, rule.field);
  if (typeof v !== 'string' && typeof v !== 'number') return fail('not_a_scalar');

  // Identifiers cannot be bound as parameters: they are checked against the
  // allowlist (validateConfig) and escaped. The lookup is always scoped to the
  // submitting organisation.
  const sql = `SELECT 1 AS found FROM ${ctx.db.escapeId(c.table)} WHERE ${ctx.db.escapeId(c.column)} = ? AND org_id = ? LIMIT 1`;
  let rows;
  try {
    rows = await ctx.db.query(sql, [String(v), ctx.orgId]);
  } catch (err) {
    if (MISSING_TARGET.has(err.errno)) return unknown('lookup_target_missing', `${c.table}.${c.column} does not exist`);
    return unknown('lookup_unavailable', 'the lookup could not be performed');
  }
  return rows.length ? pass() : fail('not_found');
}

module.exports = { validateConfig, run };
