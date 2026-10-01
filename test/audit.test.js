'use strict';

// Tamper evidence. The audit trail refuses modification; a modification made by
// someone who gets around that is detected; every committed row re-verifies from
// its own stored columns; and the verifier still catches a genuinely altered
// row in every column the hash commits to.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { testConfig, resetDatabase, startApp, adminQuery, cleanInvoice, uniqueId, USERS, createPool, anchorStore } = require('./helpers/env');
const audit = require('../src/audit');
const { withOrgTransaction } = require('../src/lib/tx');

let cfg, app, admin, clerk, orgId, otherOrgId;

before(async () => {
  cfg = testConfig();
  await resetDatabase(cfg);
  app = await startApp(cfg);
  admin = await app.login(USERS.northwindAdmin);
  clerk = await app.login(USERS.northwindClerk);
  for (let i = 0; i < 5; i += 1) {
    await app.call('POST', '/api/records', { token: clerk, body: { submission_id: uniqueId('a'), payload: cleanInvoice({ amount: 100 + i }) } });
  }
  [{ org_id: orgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.northwindAdmin]);
  [{ org_id: otherOrgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.contosoAdmin]);
});
after(async () => { await app.close(); });

const verify = async () => (await app.call('GET', '/api/audit/verify', { token: admin })).body;

// Simulates an attacker with DBA rights: disables the append-only triggers,
// runs the statement, restores the triggers.
async function asAttacker(sql, params) {
  await adminQuery(cfg, 'DROP TRIGGER audit_log_block_update');
  await adminQuery(cfg, 'DROP TRIGGER audit_log_block_delete');
  try {
    await adminQuery(cfg, sql, params);
  } finally {
    await adminQuery(cfg, "CREATE TRIGGER audit_log_block_update BEFORE UPDATE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: UPDATE rejected'");
    await adminQuery(cfg, "CREATE TRIGGER audit_log_block_delete BEFORE DELETE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: DELETE rejected'");
  }
}

const COLS = ['id', 'org_id', 'seq', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'data', 'created_at', 'prev_hash', 'hash'];
const asSqlValue = (c, v) => (c === 'data' && typeof v !== 'string' ? JSON.stringify(v) : v);
async function restoreRow(row) {
  await asAttacker(`UPDATE audit_log SET ${COLS.slice(1).map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...COLS.slice(1).map(c => asSqlValue(c, row[c])), row.id]);
}
const chainRows = () => adminQuery(cfg, `SELECT ${COLS.join(', ')} FROM audit_log WHERE org_id = ? ORDER BY seq`, [orgId]);

function runCli() {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'audit-verify.js')],
      { env: { ...process.env, AUDIT_VERIFY_DB: cfg.db.database, ANCHOR_DIR: cfg.anchor.dir } },
      (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
  });
}

test('[F12] an untouched chain verifies intact against its anchor (API and CLI)', async () => {
  const v = await verify();
  assert.equal(v.verdict, 'intact');
  assert.equal(v.chain.intact, true);
  assert.ok(v.chain.rows_checked >= 7);
  assert.equal(v.anchor.status, 'match');
  assert.equal(v.anchor.anchored_seq, v.chain.head.seq);
  const cli = await runCli();
  assert.equal(cli.code, 0, cli.stdout);
  assert.match(cli.stdout, /^INTACT/m);
});

test('[F12] the runtime database account cannot modify or delete audit rows', async () => {
  const pool = createPool(cfg.db); // the least-privilege account the service uses
  try {
    await assert.rejects(pool.query('UPDATE audit_log SET action = ? WHERE org_id = ?', ['x', orgId]), e => e.errno === 1142);
    await assert.rejects(pool.query('DELETE FROM audit_log WHERE org_id = ?', [orgId]), e => e.errno === 1142);
  } finally {
    await pool.end();
  }
});

test('[F12] even the admin account is refused by the append-only triggers', async () => {
  await assert.rejects(adminQuery(cfg, "UPDATE audit_log SET action = 'x' WHERE org_id = ?", [orgId]), /append-only/);
  await assert.rejects(adminQuery(cfg, 'DELETE FROM audit_log WHERE org_id = ?', [orgId]), /append-only/);
});

test('[F12] a modified audit row is detected at that row (API and CLI)', async () => {
  const rows = await chainRows();
  const target = rows.find(r => r.action === 'record.submitted');
  await asAttacker("UPDATE audit_log SET data = JSON_SET(data, '$.verdict', 'failed') WHERE id = ?", [target.id]);
  try {
    const v = await verify();
    assert.equal(v.verdict, 'tampered');
    assert.equal(v.chain.first_invalid_seq, target.seq);
    assert.match(v.chain.problem, /does not match its hash/);
    const cli = await runCli();
    assert.equal(cli.code, 1, 'CLI exits 1 on tampering');
    assert.match(cli.stdout, new RegExp(`^TAMPERED.*seq ${target.seq}`, 'm'));
  } finally {
    await restoreRow(target);
  }
  assert.equal((await verify()).verdict, 'intact', 'restoring the original content restores the chain');
});

test('[F12] a modified row whose hash is also recomputed is still detected by the next link', async () => {
  const rows = await chainRows();
  const target = rows[3];
  const data = typeof target.data === 'string' ? JSON.parse(target.data) : target.data;
  const forged = { ...target, data: { ...data, forged: true } };
  await asAttacker('UPDATE audit_log SET data = ?, hash = ? WHERE id = ?', [JSON.stringify(forged.data), audit.rowHash(target.prev_hash, forged), target.id]);
  try {
    const v = await verify();
    assert.equal(v.verdict, 'tampered');
    assert.equal(v.chain.first_invalid_seq, target.seq + 1);
    assert.match(v.chain.problem, /prev_hash/);
  } finally {
    await restoreRow(target);
  }
});

test('[F12] a row deleted from the middle of the chain is detected', async () => {
  const victim = (await chainRows())[2];
  await asAttacker('DELETE FROM audit_log WHERE id = ?', [victim.id]);
  try {
    const v = await verify();
    assert.equal(v.verdict, 'tampered');
    assert.equal(v.chain.first_invalid_seq, victim.seq + 1);
    assert.match(v.chain.problem, /sequence gap/);
  } finally {
    await asAttacker(`INSERT INTO audit_log (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map(c => asSqlValue(c, victim[c])));
  }
  assert.equal((await verify()).verdict, 'intact');
});

// ---- Every column the hash commits to --------------------------------------

test('[T04] altering any single hashed column of a genuine row fails verification', async () => {
  const rows = await chainRows();
  const target = rows.find(r => r.action === 'record.submitted' && r.actor_user_id !== null);
  const flip = h => (h[0] === 'a' ? `b${h.slice(1)}` : `a${h.slice(1)}`);
  const alterations = {
    org_id: ['org_id = ?, seq = ?', [otherOrgId, 900000 + target.seq]], // moved to another chain (seq kept unique)
    seq: ['seq = ?', [900000]],
    actor_user_id: ['actor_user_id = ?', [target.actor_user_id + 1]],
    action: ['action = ?', ['record.corrected']],
    entity_type: ['entity_type = ?', ['rule']],
    entity_id: ['entity_id = ?', [`${target.entity_id}0`]],
    data: ["data = JSON_SET(data, '$.verdict', 'incomplete')", []],
    created_at: ['created_at = created_at + INTERVAL 1000 MICROSECOND', []],
    prev_hash: ['prev_hash = ?', [flip(target.prev_hash)]],
    hash: ['hash = ?', [flip(target.hash)]],
  };
  // The hash must commit to every stored column except the surrogate id.
  assert.deepEqual(Object.keys(alterations).sort(), COLS.filter(c => c !== 'id').sort());
  for (const [col, [set, params]] of Object.entries(alterations)) {
    await asAttacker(`UPDATE audit_log SET ${set} WHERE id = ?`, [...params, target.id]);
    try {
      const v = await verify();
      assert.equal(v.verdict, 'tampered', `altering ${col} must be detected`);
      assert.ok(v.chain.first_invalid_seq <= target.seq + 1, `${col}: detected at or next to the altered row (got ${v.chain.first_invalid_seq})`);
    } finally {
      await restoreRow(target);
    }
    assert.equal((await verify()).verdict, 'intact', `${col}: restored row verifies again (the test itself restored cleanly)`);
  }
});

// ---- Hash what you store -----------------------------------------------------

test('[T03] awkward values are hashed as stored: every committed row re-verifies from its own columns', async () => {
  const awkward = [
    { entityId: 'trailing space ', data: { s: 'trailing space ', t: '\ttab\nnewline' } },
    { entityId: 'ünïcødé-é-é', data: { composed: '\u00e9', decomposed: 'e\u0301', emoji: '🧾✅', rtl: 'مرحبا', zwj: '👩‍💻' } },
    { entityId: null, data: { big: 1e21, small: 5e-324, negzero: -0, frac: 0.1 + 0.2, maxsafe: Number.MAX_SAFE_INTEGER, beyond: 2 ** 60 } },
    { entityId: 'x'.repeat(64), data: { nested: { z: [1, { b: 2, a: 1 }], a: null }, 'key with "quotes"': true, '': 'empty key' } },
    { entityId: 'nul', data: { control: '\u0000\u0001\u001f', bs: 'back\\slash', pair: '\ud83e\uddfe' } },
  ];
  const deps = { pool: app.pool, anchor: anchorStore(cfg) };
  for (const a of awkward) {
    await withOrgTransaction(deps, orgId, conn => audit.append(conn, {
      orgId, actorUserId: null, action: 'test.awkward_value', entityType: 'test', entityId: a.entityId, data: a.data,
    }));
  }
  for (const r of await chainRows()) assert.equal(audit.storedRowHash(r), r.hash, `seq ${r.seq} re-verifies from its stored columns`);
  assert.equal((await verify()).verdict, 'intact');
});

test('[T03] a value that cannot be stored as given (unpaired surrogate) is refused before writing', async () => {
  const before = (await chainRows()).length;
  const deps = { pool: app.pool, anchor: anchorStore(cfg) };
  await assert.rejects(withOrgTransaction(deps, orgId, c => audit.append(c, { orgId, action: 'test.lone', entityType: 'test', data: { s: '\ud800' } })),
    err => err instanceof audit.AuditWriteMismatch);
  assert.equal((await chainRows()).length, before);
});

test('[T03] a value the database would store differently is refused, not committed', async () => {
  const before = await chainRows();
  const pool = createPool(cfg.db);
  const conn = await pool.getConnection();
  try {
    // A lax server: non-strict mode silently truncates an over-long VARCHAR.
    await conn.query("SET SESSION sql_mode = ''");
    await conn.beginTransaction();
    await conn.query('SELECT id FROM organisations WHERE id = ? FOR UPDATE', [orgId]);
    await assert.rejects(
      audit.append(conn, { orgId, action: `test.${'x'.repeat(80)}`, entityType: 'test', data: {} }),
      err => err instanceof audit.AuditWriteMismatch,
    );
    await conn.rollback();
  } finally {
    conn.release();
    await pool.end();
  }
  // The service's own sessions are strict: the same value is an error, not a truncation.
  const deps = { pool: app.pool, anchor: anchorStore(cfg) };
  await assert.rejects(withOrgTransaction(deps, orgId, c => audit.append(c, { orgId, action: `test.${'x'.repeat(80)}`, entityType: 'test', data: {} })),
    err => err.errno === 1406);
  assert.equal((await chainRows()).length, before.length, 'nothing was committed');
  assert.equal((await verify()).verdict, 'intact');
});

// ---- Concurrency ---------------------------------------------------------------

test('[F12] concurrent writers keep one contiguous, valid, anchored chain', async () => {
  const results = await Promise.all([...Array(20)].map((_, i) => app.call('POST', '/api/records',
    { token: clerk, body: { submission_id: uniqueId('conc'), payload: cleanInvoice({ amount: 500 + i }) } })));
  assert.deepEqual(results.map(r => r.status).filter(s => s !== 201), [], JSON.stringify(results.filter(r => r.status !== 201).map(r => r.body)));
  assert.ok(results.every(r => r.body.audit_anchored === true));
  const v = await verify();
  assert.equal(v.verdict, 'intact');
  const [{ n }] = await adminQuery(cfg, 'SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?', [orgId]);
  assert.equal(v.chain.rows_checked, n);
  assert.equal(v.anchor.anchored_seq, n);
});

test('[F12] an append from a transaction holding an old snapshot still extends the latest head', async () => {
  const deps = { pool: createPool(cfg.db), anchor: anchorStore(cfg) };
  const early = await deps.pool.getConnection();
  try {
    await early.beginTransaction();
    await early.query('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?', [orgId]); // fixes the read snapshot
    await withOrgTransaction(deps, orgId, conn => audit.append(conn, { orgId, action: 'test.other_writer', entityType: 'test', data: {} }));
    await early.query('SELECT id FROM organisations WHERE id = ? FOR UPDATE', [orgId]);
    const head = await audit.append(early, { orgId, action: 'test.late_writer', entityType: 'test', data: {} });
    await early.commit();
    await deps.anchor.record(orgId, head);
  } finally {
    early.release();
    await deps.pool.end();
  }
  assert.equal((await verify()).verdict, 'intact');
});
