'use strict';

// Runs fn(conn) in a transaction. Any error rolls back; if the connection is
// already gone the server discards the uncommitted work itself. The original
// error is always the one rethrown.
async function withTransaction(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection lost: nothing was committed */ }
    throw err;
  } finally {
    try { await conn.release(); } catch { /* already destroyed */ }
  }
}

module.exports = { withTransaction };

// A transaction that will append to an organisation's audit chain. The chain
// lock (the organisation row, FOR UPDATE) is taken first, before any insert:
// child-row inserts take a shared lock on the same row through their foreign
// key, and upgrading that later would deadlock concurrent writers.
// After a successful commit the new chain head is recorded in the external
// anchor. The anchor is written only for committed rows; if that write fails
// the commit stands, `meta.anchored` is false, the failure is logged, and the
// verifier reports the rows it does not cover as unanchored (never as intact).
async function withOrgTransaction(deps, orgId, fn, meta = {}) {
  let head = null;
  const value = await withTransaction(deps.pool, async conn => {
    const rows = await conn.query('SELECT id FROM organisations WHERE id = ? FOR UPDATE', [orgId]);
    if (!rows.length) throw new Error(`organisation ${orgId} does not exist`);
    conn.auditHead = null;
    const result = await fn(conn);
    head = conn.auditHead;
    return result;
  });
  meta.anchored = head ? await deps.anchor.record(head.orgId, head) : null;
  if (meta.anchored === false) {
    (deps.logger || console).error(`[ivs] audit anchor could not be updated for organisation ${orgId} (seq ${head.seq})`);
  }
  return value;
}

module.exports.withOrgTransaction = withOrgTransaction;
