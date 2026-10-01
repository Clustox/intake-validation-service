'use strict';

const { pass, fail, getField, isAbsent, absent } = require('../outcome');

const KEYS = new Set(['min', 'max', 'optional']);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A real calendar date in YYYY-MM-DD form (rejects 2026-02-30).
function isCalendarDate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function validateConfig(c) {
  const errors = [];
  for (const k of Object.keys(c)) if (!KEYS.has(k)) errors.push(`unsupported key "${k}"`);
  for (const k of ['min', 'max']) if (k in c && !isCalendarDate(c[k])) errors.push(`${k} must be a YYYY-MM-DD date`);
  if ('optional' in c && typeof c.optional !== 'boolean') errors.push('optional must be boolean');
  if (isCalendarDate(c.min) && isCalendarDate(c.max) && c.min > c.max) errors.push('min must not be after max');
  return errors;
}

async function run(payload, rule) {
  const c = rule.config;
  const v = getField(payload, rule.field);
  if (isAbsent(v)) return absent(c, rule.field);
  if (!isCalendarDate(v)) return fail('invalid_date');
  // ISO dates compare correctly as strings.
  if (c.min && v < c.min) return fail('before_min');
  if (c.max && v > c.max) return fail('after_max');
  return pass();
}

module.exports = { validateConfig, run, isCalendarDate };
