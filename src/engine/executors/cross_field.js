'use strict';

const { pass, fail, getField, isAbsent, absent } = require('../outcome');
const { isCalendarDate } = require('./date');

const KEYS = new Set(['other_field', 'operator', 'compare_as', 'optional']);
const OPS = { eq: (a, b) => a === b, neq: (a, b) => a !== b, lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b };
const TYPES = {
  number: v => typeof v === 'number' && Number.isFinite(v),
  date: v => isCalendarDate(v),
  string: v => typeof v === 'string',
};

function validateConfig(c) {
  const errors = [];
  for (const k of Object.keys(c)) if (!KEYS.has(k)) errors.push(`unsupported key "${k}"`);
  if (typeof c.other_field !== 'string' || c.other_field === '') errors.push('other_field must be a non-empty string');
  if (!Object.hasOwn(OPS, c.operator)) errors.push(`operator must be one of ${Object.keys(OPS).join(', ')}`);
  if (!Object.hasOwn(TYPES, c.compare_as)) errors.push(`compare_as must be one of ${Object.keys(TYPES).join(', ')}`);
  if ('optional' in c && typeof c.optional !== 'boolean') errors.push('optional must be boolean');
  return errors;
}

// Passes when  <field> <operator> <other_field>  holds.
async function run(payload, rule) {
  const c = rule.config;
  const a = getField(payload, rule.field);
  const b = getField(payload, c.other_field);
  if (isAbsent(a)) return absent(c, rule.field);
  if (isAbsent(b)) return absent(c, c.other_field);
  const isType = TYPES[c.compare_as];
  if (!isType(a) || !isType(b)) return fail('type_mismatch');
  return OPS[c.operator](a, b) ? pass() : fail('comparison_failed');
}

module.exports = { validateConfig, run };
