'use strict';

// Every function takes orgId: there is no unscoped way to read or change a record.

const COLUMNS = `id, org_id, submission_id, payload, payload_hash, verdict, fully_evaluated, summary, results,
  version, submitted_by, updated_by, created_at, updated_at`;

async function findById(db, orgId, id) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM submitted_records WHERE id = ? AND org_id = ?`, [id, orgId]);
  return rows[0] || null;
}

async function findBySubmissionId(db, orgId, submissionId) {
  const rows = await db.query(`SELECT ${COLUMNS} FROM submitted_records WHERE submission_id = ? AND org_id = ?`, [submissionId, orgId]);
  return rows[0] || null;
}

async function list(db, orgId, { afterId, limit, verdict }) {
  const rows = await db.query(
    `SELECT id, submission_id, verdict, fully_evaluated, version, created_at, updated_at
     FROM submitted_records WHERE org_id = ? AND id > ? ${verdict ? 'AND verdict = ?' : ''} ORDER BY id LIMIT ?`,
    verdict ? [orgId, afterId, verdict, limit] : [orgId, afterId, limit]);
  return rows;
}

async function insert(db, orgId, userId, rec) {
  const res = await db.query(
    `INSERT INTO submitted_records
       (org_id, submission_id, payload, payload_hash, verdict, fully_evaluated, summary, results, submitted_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, rec.submission_id, JSON.stringify(rec.payload), rec.payload_hash, rec.verdict, rec.fully_evaluated ? 1 : 0,
      JSON.stringify(rec.summary), JSON.stringify(rec.results), userId, userId]);
  return res.insertId;
}

async function update(db, orgId, id, expectedVersion, userId, rec) {
  const res = await db.query(
    `UPDATE submitted_records SET payload = ?, payload_hash = ?, verdict = ?, fully_evaluated = ?, summary = ?, results = ?,
       version = version + 1, updated_by = ?
     WHERE id = ? AND org_id = ? AND version = ?`,
    [JSON.stringify(rec.payload), rec.payload_hash, rec.verdict, rec.fully_evaluated ? 1 : 0,
      JSON.stringify(rec.summary), JSON.stringify(rec.results), userId, id, orgId, expectedVersion]);
  return res.affectedRows === 1;
}

module.exports = { findById, findBySubmissionId, list, insert, update };
