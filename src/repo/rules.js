'use strict';

// Every function takes orgId: there is no unscoped way to read or change a rule.

const { parseJson } = require('../db');

const COLUMNS = 'id, org_id, name, rule_type, field, config, message, active, version, created_at, updated_at';

const hydrate = r => ({ ...r, config: parseJson(r.config), active: r.active === 1 });

async function activeSnapshot(db, orgId) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM validation_rules WHERE org_id = ? AND active = 1 ORDER BY id`, [orgId]);
  return rows.map(hydrate);
}

async function currentVersions(db, orgId, ids) {
  if (!ids.length) return new Map();
  const rows = await db.query(
    `SELECT id, version, active FROM validation_rules WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [orgId, ...ids]);
  return new Map(rows.map(r => [r.id, { version: r.version, active: r.active === 1 }]));
}

async function list(db, orgId, { afterId, limit, includeInactive }) {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM validation_rules WHERE org_id = ? AND id > ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY id LIMIT ?`,
    [orgId, afterId, limit]);
  return rows.map(hydrate);
}

async function findById(db, orgId, id, { forUpdate = false } = {}) {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM validation_rules WHERE id = ? AND org_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id, orgId]);
  return rows[0] ? hydrate(rows[0]) : null;
}

async function insert(db, orgId, r) {
  const res = await db.query(
    'INSERT INTO validation_rules (org_id, name, rule_type, field, config, message, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [orgId, r.name, r.rule_type, r.field, JSON.stringify(r.config), r.message, r.active ? 1 : 0]);
  return res.insertId;
}

async function update(db, orgId, id, expectedVersion, r) {
  const res = await db.query(
    `UPDATE validation_rules SET name = ?, field = ?, config = ?, message = ?, active = ?, version = version + 1
     WHERE id = ? AND org_id = ? AND version = ?`,
    [r.name, r.field, JSON.stringify(r.config), r.message, r.active ? 1 : 0, id, orgId, expectedVersion]);
  return res.affectedRows === 1;
}

module.exports = { activeSnapshot, currentVersions, list, findById, insert, update };
