'use strict';

const { pass, fail, getField, isAbsent } = require('../outcome');

function validateConfig(config) {
  const errors = [];
  for (const k of Object.keys(config)) if (k !== 'allow_blank') errors.push(`unsupported key "${k}"`);
  if ('allow_blank' in config && typeof config.allow_blank !== 'boolean') errors.push('allow_blank must be boolean');
  return errors;
}

async function run(payload, rule) {
  const v = getField(payload, rule.field);
  if (isAbsent(v)) return fail('missing');
  if (typeof v === 'string' && v.trim() === '' && rule.config.allow_blank !== true) return fail('blank');
  return pass();
}

module.exports = { validateConfig, run };
