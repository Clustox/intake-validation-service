'use strict';

// The four possible results of running one rule. There is deliberately no
// path that turns an unknown into a pass: see aggregate.js.
const STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  UNKNOWN: 'unknown',   // the rule could not run: the answer is not known
  SKIPPED: 'skipped',   // the rule did not apply (an optional field was absent)
});

const pass = () => ({ status: STATUS.PASS });
const fail = (code, detail) => ({ status: STATUS.FAIL, code, ...(detail ? { detail } : {}) });
const unknown = (code, detail) => ({ status: STATUS.UNKNOWN, code, ...(detail ? { detail } : {}) });
const skipped = code => ({ status: STATUS.SKIPPED, code });

// Reads a dotted path ("supplier.code") using own properties only.
function getField(payload, path) {
  let cur = payload;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

const isAbsent = v => v === undefined || v === null;

// For every rule type except `required`: a value the rule needs is missing.
// The rule cannot decide, so the result is unknown - unless the rule's own
// configuration marks the field optional, in which case it does not apply.
function absent(config, field) {
  return config.optional === true
    ? skipped('optional_field_absent')
    : unknown('field_absent', `field "${field}" is absent; the rule cannot be evaluated`);
}

module.exports = { STATUS, pass, fail, unknown, skipped, getField, isAbsent, absent };
