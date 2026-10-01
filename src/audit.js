'use strict';

// Hash-chained, append-only audit trail with one chain per organisation.
//   hash = sha256(prev_hash + "\n" + canonicalJson(row content))
// The first row of a chain links to GENESIS. seq runs 1, 2, 3... per org, so a
// row removed from the middle of a chain breaks the sequence as well as the links.
// Removal of the newest rows is caught by the external anchor (src/anchor.js).
//
// Hash what is stored, not what was handed in: the hash is always computed from
// a row's columns as read back from the database (storedRowHash). Every append
// re-reads the row it just wrote and refuses to commit if the stored row does
// not re-verify, so no committed row can fail verification merely because the
// database stored a value differently from how it was passed in.

const { canonicalJson, sha256, dbTimestamp, isoTimestamp } = require('./lib/canonical');
const { parseJson } = require('./db');
const { isWellFormedJson } = require('./lib/input');

const GENESIS = '0'.repeat(64);
const VERIFY_BATCH = 1000;

const COLUMNS = 'id, org_id, seq, actor_user_id, action, entity_type, entity_id, data, created_at, prev_hash, hash';

function rowHash(prevHash, r) {
  const content = canonicalJson({
    org_id: r.org_id,
    seq: r.seq,
    actor_user_id: r.actor_user_id ?? null,
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id ?? null,
    data: r.data,
    created_at: r.created_at,
  });
  return sha256(`${prevHash}\n${content}`);
}

// The hash of a row exactly as the database returns it.
const storedRowHash = r => rowHash(r.prev_hash, { ...r, data: parseJson(r.data) });

class AuditWriteMismatch extends Error {}

/**
 * Appends an event. Must run inside the caller's transaction so the audit row
 * commits or rolls back together with the change it describes, and that
 * transaction must already hold the organisation lock (lib/tx withOrgTransaction)
 * taken before any other write. The lock below is then a no-op re-check.
 */
async function append(conn, { orgId, actorUserId = null, action, entityType, entityId = null, data = {} }) {
  if (!isWellFormedJson([action, entityType, entityId, data])) {
    throw new AuditWriteMismatch('audit event contains invalid Unicode (an unpaired surrogate) and cannot be stored as given');
  }
  const locked = await conn.query('SELECT id FROM organisations WHERE id = ? FOR UPDATE', [orgId]);
  if (!locked.length) throw new Error(`audit append: organisation ${orgId} does not exist`);
  // A locking read returns the latest committed head even if this transaction
  // already holds an older consistent-read snapshot.
  const [head] = await conn.query('SELECT seq, hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1 FOR UPDATE', [orgId]);
  const row = {
    org_id: orgId,
    seq: head ? head.seq + 1 : 1,
    actor_user_id: actorUserId,
    action,
    entity_type: entityType,
    entity_id: entityId === null ? null : String(entityId),
    // Round-trip through JSON so the hashed value is exactly what is stored.
    data: JSON.parse(canonicalJson(data)),
    created_at: dbTimestamp(),
  };
  const prevHash = head ? head.hash : GENESIS;
  const hash = rowHash(prevHash, row);
  const res = await conn.query(
    `INSERT INTO audit_log (org_id, seq, actor_user_id, action, entity_type, entity_id, data, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.org_id, row.seq, row.actor_user_id, row.action, row.entity_type, row.entity_id,
      canonicalJson(row.data), row.created_at, prevHash, hash],
  );
  // Read back what was stored and verify it before the transaction commits.
  const [stored] = await conn.query(`SELECT ${COLUMNS} FROM audit_log WHERE id = ?`, [res.insertId]);
  if (!stored || stored.prev_hash !== prevHash || storedRowHash(stored) !== stored.hash) {
    throw new AuditWriteMismatch(`audit row seq ${row.seq} was not stored as hashed; refusing to commit`);
  }
  // Recorded for the post-commit anchor update (lib/tx withOrgTransaction).
  conn.auditHead = { orgId, seq: row.seq, hash };
  return { seq: row.seq, hash };
}

/**
 * Recomputes an organisation's chain from its stored rows, then checks it
 * against the external anchor.
 *   chain:  an edited row (content no longer matches its hash), a broken link
 *           (prev_hash differs from the previous row's hash), a missing or
 *           reordered row (seq not contiguous from 1).
 *   anchor: a chain that ends before the anchored seq (newest rows removed) or
 *           holds a different hash there (rewritten); an anchor file that was
 *           altered (signature mismatch).
 * verdict: 'tampered' if either finds a problem; 'intact' only if the chain
 * verifies AND the anchor covers its head; otherwise 'incomplete': nothing
 * wrong was found, but not everything could be checked (no anchor, anchor
 * unreadable, or rows newer than the anchor). Incomplete is never intact.
 */
async function verifyChain(db, orgId, { anchorStore = null } = {}) {
  const chain = await walkChain(db, orgId);
  const [{ maxSeq }] = await db.query('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM audit_log WHERE org_id = ?', [orgId]);
  const anchor = await checkAnchor(db, orgId, anchorStore, maxSeq);

  const notes = [];
  let verdict;
  if (!chain.intact || anchor.status === 'mismatch' || anchor.status === 'invalid') verdict = 'tampered';
  else if (anchor.status === 'match') verdict = 'intact';
  else verdict = 'incomplete';
  if (!chain.intact) notes.push(`chain broken at seq ${chain.first_invalid_seq}: ${chain.problem}`);
  if (anchor.problem) notes.push(anchor.problem);
  return { verdict, chain, anchor, notes };
}

async function walkChain(db, orgId) {
  let expectedSeq = 1;
  let prevHash = GENESIS;
  let checked = 0;
  for (;;) {
    const rows = await db.query(
      `SELECT ${COLUMNS} FROM audit_log WHERE org_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
      [orgId, expectedSeq, VERIFY_BATCH],
    );
    for (const r of rows) {
      const problem =
        r.seq !== expectedSeq ? `sequence gap: expected seq ${expectedSeq}, found ${r.seq}`
          : r.org_id !== Number(orgId) ? 'row belongs to a different organisation'
            : r.prev_hash !== prevHash ? 'prev_hash does not match the preceding row'
              : storedRowHash(r) !== r.hash ? 'row content does not match its hash'
                : null;
      if (problem) return { intact: false, rows_checked: checked, first_invalid_seq: r.seq, problem };
      prevHash = r.hash;
      expectedSeq += 1;
      checked += 1;
    }
    if (rows.length < VERIFY_BATCH) break;
  }
  return { intact: true, rows_checked: checked, head: checked ? { seq: expectedSeq - 1, hash: prevHash } : null };
}

async function checkAnchor(db, orgId, anchorStore, maxSeq) {
  if (!anchorStore) return { status: 'not_configured', problem: 'no anchor store: removal of the newest rows was not checked' };
  const read = await anchorStore.read(orgId);
  if (read.status === 'missing') {
    return { status: 'missing', chain_head_seq: maxSeq, problem: 'no external anchor for this chain: removal of the newest rows was not checked' };
  }
  if (read.status === 'unreadable') return { status: 'unreadable', problem: `anchor could not be read (${read.reason}): removal of the newest rows was not checked` };
  if (read.status === 'invalid') return { status: 'invalid', problem: `anchor rejected: ${read.reason}` };
  const a = read.anchor;
  const base = { anchored_seq: a.seq, anchored_hash: a.hash, anchored_at: a.anchored_at, chain_head_seq: maxSeq };
  const [row] = await db.query('SELECT hash FROM audit_log WHERE org_id = ? AND seq = ?', [orgId, a.seq]);
  if (!row) {
    return { ...base, status: 'mismatch', problem: `anchor records ${a.seq} rows but the chain ends at seq ${maxSeq}: rows have been removed` };
  }
  if (row.hash !== a.hash) {
    return { ...base, status: 'mismatch', problem: `hash at anchored seq ${a.seq} differs from the anchor: the chain has been rewritten` };
  }
  if (maxSeq > a.seq) {
    return { ...base, status: 'behind', unanchored_rows: maxSeq - a.seq,
      problem: `${maxSeq - a.seq} row(s) newer than the anchor are not covered by it` };
  }
  return { ...base, status: 'match', unanchored_rows: 0 };
}

async function listEvents(db, orgId, { afterId, limit }) {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM audit_log WHERE org_id = ? AND seq > ? ORDER BY seq LIMIT ?`, [orgId, afterId, limit]);
  return rows.map(formatEvent);
}

function formatEvent(r) {
  return {
    seq: r.seq,
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    actor_user_id: r.actor_user_id,
    data: parseJson(r.data),
    created_at: isoTimestamp(r.created_at),
    hash: r.hash,
    prev_hash: r.prev_hash,
  };
}

module.exports = { append, verifyChain, listEvents, formatEvent, rowHash, storedRowHash, AuditWriteMismatch, GENESIS };
