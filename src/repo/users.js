'use strict';

// Login is the only lookup that is not organisation-scoped: the organisation
// is not known until the user is identified.
async function findByEmailForLogin(db, email) {
  const rows = await db.query(
    `SELECT u.id, u.org_id, u.email, u.display_name, u.password_hash, u.role, u.active, o.name AS org_name
     FROM users u JOIN organisations o ON o.id = u.org_id WHERE u.email = ?`, [email]);
  return rows[0] || null;
}

async function findActive(db, orgId, id) {
  const rows = await db.query(
    'SELECT id, org_id, role FROM users WHERE id = ? AND org_id = ? AND active = 1', [id, orgId]);
  return rows[0] || null;
}

module.exports = { findByEmailForLogin, findActive };
