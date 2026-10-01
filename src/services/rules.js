'use strict';

const rules = require('../repo/rules');
const audit = require('../audit');
const { validateRuleDefinition } = require('../engine');
const { withOrgTransaction } = require('../lib/tx');
const { isoTimestamp } = require('../lib/canonical');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { requireObject, positiveInt, isWellFormedJson } = require('../lib/input');

const ER_DUP_ENTRY = 1062;
const EDITABLE = ['name', 'field', 'config', 'message', 'active'];

function present(r) {
  return {
    id: r.id, name: r.name, rule_type: r.rule_type, field: r.field, config: r.config, message: r.message,
    active: r.active, version: r.version, created_at: isoTimestamp(r.created_at), updated_at: isoTimestamp(r.updated_at),
  };
}

function checkDefinition(def, deps) {
  const errors = [];
  if (typeof def.name !== 'string' || def.name.trim() === '' || def.name.length > 120) errors.push('name must be 1-120 characters');
  if (typeof def.message !== 'string' || def.message.trim() === '' || def.message.length > 500) errors.push('message must be 1-500 characters');
  if (typeof def.active !== 'boolean') errors.push('active must be boolean');
  if (!isWellFormedJson([def.name, def.field, def.config, def.message])) errors.push('rule contains invalid Unicode (an unpaired surrogate)');
  errors.push(...validateRuleDefinition(def, deps.config.engine));
  if (errors.length) throw badRequest('invalid_rule', 'rule definition is invalid', { errors });
}

const duplicateName = err => {
  if (err.errno === ER_DUP_ENTRY) throw conflict('rule_name_taken', 'a rule with this name already exists');
  throw err;
};

async function create(deps, auth, body) {
  requireObject(body, ['name', 'rule_type', 'field', 'config', 'message', 'active']);
  const def = { active: true, ...body };
  checkDefinition(def, deps);
  const id = await withOrgTransaction(deps, auth.orgId, async conn => {
    const newId = await rules.insert(conn, auth.orgId, def);
    await audit.append(conn, {
      orgId: auth.orgId, actorUserId: auth.userId, action: 'rule.created', entityType: 'rule', entityId: newId,
      data: { name: def.name, rule_type: def.rule_type, field: def.field, config: def.config, message: def.message, active: def.active, version: 1 },
    });
    return newId;
  }).catch(duplicateName);
  return present(await rules.findById(deps.pool, auth.orgId, id));
}

async function update(deps, auth, id, body) {
  requireObject(body, ['expected_version', ...EDITABLE]);
  if (body.expected_version === undefined) throw badRequest('missing_fields', 'expected_version is required');
  const expectedVersion = positiveInt(body.expected_version, 'expected_version');
  if (!EDITABLE.some(k => k in body)) throw badRequest('missing_fields', `provide at least one of: ${EDITABLE.join(', ')}`);

  await withOrgTransaction(deps, auth.orgId, async conn => {
    const current = await rules.findById(conn, auth.orgId, id, { forUpdate: true });
    if (!current) throw notFound();
    if (current.version !== expectedVersion) {
      throw conflict('version_conflict', `rule is at version ${current.version}`, { current_version: current.version });
    }
    const next = { ...current, ...Object.fromEntries(EDITABLE.filter(k => k in body).map(k => [k, body[k]])) };
    checkDefinition(next, deps);
    await rules.update(conn, auth.orgId, id, expectedVersion, next);
    const changes = Object.fromEntries(EDITABLE
      .filter(k => JSON.stringify(current[k]) !== JSON.stringify(next[k]))
      .map(k => [k, { from: current[k], to: next[k] }]));
    const action = current.active && !next.active ? 'rule.deactivated'
      : !current.active && next.active ? 'rule.activated' : 'rule.updated';
    await audit.append(conn, {
      orgId: auth.orgId, actorUserId: auth.userId, action, entityType: 'rule', entityId: id,
      data: { version: current.version + 1, changes },
    });
  }).catch(duplicateName);
  return present(await rules.findById(deps.pool, auth.orgId, id));
}

async function get(deps, auth, id) {
  const r = await rules.findById(deps.pool, auth.orgId, id);
  if (!r) throw notFound();
  return present(r);
}

async function list(deps, auth, opts) {
  return (await rules.list(deps.pool, auth.orgId, opts)).map(present);
}

module.exports = { create, update, get, list };
