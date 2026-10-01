'use strict';

const { STATUS, unknown } = require('./outcome');
const { aggregate } = require('./aggregate');

// Rule types are dispatched by the rule_type column. Adding a rule of an
// existing type is an INSERT into validation_rules; no code changes.
const EXECUTORS = Object.freeze({
  required: require('./executors/required'),
  range: require('./executors/range'),
  date: require('./executors/date'),
  regex: require('./executors/regex'),
  lookup: require('./executors/lookup'),
  cross_field: require('./executors/cross_field'),
});

class RuleTimeout extends Error {}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new RuleTimeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Checks a rule definition. Used by the admin API before a rule is stored and
// by the engine before a stored rule is run (rows can be inserted directly).
function validateRuleDefinition({ rule_type, field, config }, ctx) {
  const executor = Object.hasOwn(EXECUTORS, rule_type) ? EXECUTORS[rule_type] : null;
  if (!executor) return [`unsupported rule_type "${rule_type}"; supported: ${Object.keys(EXECUTORS).join(', ')}`];
  const errors = [];
  if (typeof field !== 'string' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(field)) errors.push('field must be a name or dotted path');
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return [...errors, 'config must be a JSON object'];
  return [...errors, ...executor.validateConfig(config, ctx)];
}

async function runOne(payload, rule, ctx) {
  const errors = validateRuleDefinition(rule, ctx);
  if (errors.length) {
    return Object.hasOwn(EXECUTORS, rule.rule_type)
      ? unknown('invalid_rule_config', errors.join('; '))
      : unknown('unsupported_rule_type', errors.join('; '));
  }
  try {
    return await withTimeout(EXECUTORS[rule.rule_type].run(payload, rule, ctx), ctx.ruleTimeoutMs);
  } catch (err) {
    // Anything that stops a rule from reaching a decision is unknown - never pass.
    if (err instanceof RuleTimeout) return unknown('rule_timeout', `rule exceeded ${ctx.ruleTimeoutMs} ms`);
    return unknown('executor_error', 'the rule raised an error and could not be evaluated');
  }
}

/**
 * Evaluates a payload against a snapshot of rules.
 * @param {object} payload
 * @param {Array<{id,name,rule_type,field,config,message,version}>} rules - the snapshot
 * @param {{db, orgId, ruleTimeoutMs, regexTimeoutMs, lookupAllowlist}} ctx
 */
async function evaluate(payload, rules, ctx) {
  const outcomes = await Promise.all(rules.map(r => runOne(payload, r, ctx)));
  const results = rules.map((rule, i) => {
    const o = outcomes[i];
    return {
      rule_id: rule.id,
      rule_name: rule.name,
      rule_type: rule.rule_type,
      rule_version: rule.version,
      field: rule.field,
      status: o.status,
      ...(o.code ? { code: o.code } : {}),
      ...(o.status === STATUS.FAIL ? { message: rule.message } : {}),
      ...(o.detail ? { detail: o.detail } : {}),
    };
  });
  return { results, ...aggregate(results) };
}

module.exports = { evaluate, validateRuleDefinition, RULE_TYPES: Object.keys(EXECUTORS) };
