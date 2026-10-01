'use strict';

const { pass, fail, getField, isAbsent, absent } = require('../outcome');

const KEYS = new Set(['min', 'max', 'min_inclusive', 'max_inclusive', 'optional']);

function validateConfig(c) {
  const errors = [];
  for (const k of Object.keys(c)) if (!KEYS.has(k)) errors.push(`unsupported key "${k}"`);
  if (!('min' in c) && !('max' in c)) errors.push('at least one of min or max is required');
  for (const k of ['min', 'max']) {
    if (k in c && !(typeof c[k] === 'number' && Number.isFinite(c[k]))) errors.push(`${k} must be a finite number`);
  }
  for (const k of ['min_inclusive', 'max_inclusive', 'optional']) {
    if (k in c && typeof c[k] !== 'boolean') errors.push(`${k} must be boolean`);
  }
  if (typeof c.min === 'number' && typeof c.max === 'number' && c.min > c.max) errors.push('min must not exceed max');
  return errors;
}

async function run(payload, rule) {
  const c = rule.config;
  const v = getField(payload, rule.field);
  if (isAbsent(v)) return absent(c, rule.field);
  // Strings such as "5000" are not numbers: coercion would hide bad input.
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail('not_a_number');
  if ('min' in c) {
    const ok = c.min_inclusive === false ? v > c.min : v >= c.min;
    if (!ok) return fail('below_min');
  }
  if ('max' in c) {
    const ok = c.max_inclusive === false ? v < c.max : v <= c.max;
    if (!ok) return fail('above_max');
  }
  return pass();
}

module.exports = { validateConfig, run };
