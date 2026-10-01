'use strict';

// The external anchor: removal of the newest audit rows, which a hash chain
// alone cannot see, is detected; an altered or missing anchor is never read as
// intact; an anchor-store failure surfaces as a failure.

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { testConfig, resetDatabase, startApp, adminQuery, cleanInvoice, uniqueId, USERS, anchorStore } = require('./helpers/env');
const audit = require('../src/audit');

let cfg, app, admin, clerk, orgId, otherOrgId, store;

before(async () => {
  cfg = testConfig();
  await resetDatabase(cfg);
  app = await startApp(cfg);
  store = anchorStore(cfg);
  admin = await app.login(USERS.northwindAdmin);
  clerk = await app.login(USERS.northwindClerk);
  for (let i = 0; i < 4; i += 1) {
    await app.call('POST', '/api/records', { token: clerk, body: { submission_id: uniqueId('an'), payload: cleanInvoice({ amount: 10 + i }) } });
  }
  [{ org_id: orgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.northwindAdmin]);
  [{ org_id: otherOrgId }] = await adminQuery(cfg, 'SELECT org_id FROM users WHERE email = ?', [USERS.contosoAdmin]);
});
after(async () => { await app.close(); });

const verify = async () => (await app.call('GET', '/api/audit/verify', { token: admin })).body;
const COLS = ['id', 'org_id', 'seq', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'data', 'created_at', 'prev_hash', 'hash'];
const rowsOf = () => adminQuery(cfg, `SELECT ${COLS.join(', ')} FROM audit_log WHERE org_id = ? ORDER BY seq`, [orgId]);

async function asAttacker(sql, params) {
  await adminQuery(cfg, 'DROP TRIGGER audit_log_block_delete');
  try {
    await adminQuery(cfg, sql, params);
  } finally {
    await adminQuery(cfg, "CREATE TRIGGER audit_log_block_delete BEFORE DELETE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: DELETE rejected'");
  }
}
const reinsert = rows => Promise.all(rows.map(r => adminQuery(cfg,
  `INSERT INTO audit_log (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`,
  COLS.map(c => (c === 'data' && typeof r[c] !== 'string' ? JSON.stringify(r[c]) : r[c])))));

function runCli() {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'audit-verify.js')],
      { env: { ...process.env, AUDIT_VERIFY_DB: cfg.db.database, ANCHOR_DIR: cfg.anchor.dir } },
      (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
  });
}

test('[T01] the anchor is written outside the database and covers the chain head', async () => {
  const rows = await rowsOf();
  const a = await store.read(orgId);
  assert.equal(a.status, 'ok');
  assert.deepEqual([a.anchor.seq, a.anchor.hash], [rows.length, rows[rows.length - 1].hash]);
  const file = JSON.parse(await fs.readFile(store.file(orgId), 'utf8'));
  assert.match(file.mac, /^[0-9a-f]{64}$/);
  assert.equal(file.database, cfg.db.database);
});

test('[T01] removing the newest rows (a still-valid, shorter chain) is detected via the anchor', async () => {
  const rows = await rowsOf();
  const removed = rows.slice(-2);
  await asAttacker('DELETE FROM audit_log WHERE org_id = ? AND seq > ?', [orgId, rows.length - 2]);
  try {
    const v = await verify();
    assert.equal(v.chain.intact, true, 'the truncated chain is internally consistent: the chain alone cannot see this');
    assert.equal(v.verdict, 'tampered');
    assert.equal(v.anchor.status, 'mismatch');
    assert.match(v.anchor.problem, /rows have been removed/);
    const cli = await runCli();
    assert.equal(cli.code, 1, cli.stdout);
    assert.match(cli.stdout, /^TAMPERED/m);
  } finally {
    await reinsert(removed);
  }
  assert.equal((await verify()).verdict, 'intact');
});

test('[T01] replacing the newest row with a forged, correctly chained one is detected', async () => {
  const rows = await rowsOf();
  const last = rows[rows.length - 1];
  const data = typeof last.data === 'string' ? JSON.parse(last.data) : last.data;
  const forged = { ...last, data: { ...data, verdict: 'clean', forged: true } };
  forged.hash = audit.rowHash(last.prev_hash, forged);
  await asAttacker('DELETE FROM audit_log WHERE id = ?', [last.id]);
  await reinsert([forged]);
  try {
    const v = await verify();
    assert.equal(v.chain.intact, true, 'the forged row chains correctly');
    assert.equal(v.verdict, 'tampered');
    assert.match(v.anchor.problem, /rewritten/);
  } finally {
    await asAttacker('DELETE FROM audit_log WHERE id = ?', [last.id]);
    await reinsert([last]);
  }
  assert.equal((await verify()).verdict, 'intact');
});

test('[T02] truncating the chain and deleting its anchor is reported incomplete, never intact', async () => {
  const rows = await rowsOf();
  const saved = await fs.readFile(store.file(orgId), 'utf8');
  const removed = rows.slice(-1);
  await asAttacker('DELETE FROM audit_log WHERE org_id = ? AND seq = ?', [orgId, rows.length]);
  await fs.unlink(store.file(orgId));
  try {
    const v = await verify();
    assert.equal(v.verdict, 'incomplete');
    assert.equal(v.anchor.status, 'missing');
    assert.match(v.notes.join(' '), /not checked/);
    const cli = await runCli();
    assert.equal(cli.code, 2, 'CLI exits 2 when not everything could be verified');
    assert.match(cli.stdout, /^INCOMPLETE/m);
  } finally {
    await reinsert(removed);
    await fs.writeFile(store.file(orgId), saved);
  }
  assert.equal((await verify()).verdict, 'intact');
});

test('[T02] an anchor edited to hide a truncation fails its signature and is reported as tampering', async () => {
  const saved = await fs.readFile(store.file(orgId), 'utf8');
  const rows = await rowsOf();
  const a = JSON.parse(saved);
  await fs.writeFile(store.file(orgId), JSON.stringify({ ...a, seq: rows.length - 1, hash: rows[rows.length - 2].hash }));
  try {
    const v = await verify();
    assert.equal(v.verdict, 'tampered');
    assert.equal(v.anchor.status, 'invalid');
  } finally {
    await fs.writeFile(store.file(orgId), saved);
  }
});

test("[T02] another organisation's valid anchor copied over this one is rejected", async () => {
  const saved = await fs.readFile(store.file(orgId), 'utf8');
  await fs.copyFile(store.file(otherOrgId), store.file(orgId));
  try {
    const v = await verify();
    assert.equal(v.verdict, 'tampered');
    assert.equal(v.anchor.status, 'invalid');
  } finally {
    await fs.writeFile(store.file(orgId), saved);
  }
});

test('[T02] an anchor signed with a different key is rejected', async () => {
  const { AnchorStore } = require('../src/anchor');
  const saved = await fs.readFile(store.file(orgId), 'utf8');
  const rows = await rowsOf();
  const rogue = new AnchorStore({ dir: cfg.anchor.dir, key: 'a-different-key-that-is-long-enough-to-pass' }, cfg.db.database);
  await fs.unlink(store.file(orgId));
  await rogue.record(orgId, { seq: rows.length, hash: rows[rows.length - 1].hash });
  try {
    assert.equal((await verify()).anchor.status, 'invalid');
  } finally {
    await fs.writeFile(store.file(orgId), saved);
  }
});

test('[H05] an anchor store that cannot be written surfaces as a failure and is never read as intact', async () => {
  // A path that is a regular file cannot be used as the anchor directory.
  const blocked = path.join(os.tmpdir(), `ivs-anchor-blocked-${process.pid}`);
  await fs.writeFile(blocked, 'not a directory');
  const broken = await startApp({ ...cfg, anchor: { ...cfg.anchor, dir: blocked } });
  try {
    const h = await broken.call('GET', '/api/health');
    assert.equal(h.status, 503);
    assert.equal(h.body.checks.audit_anchor.status, 'down');
    assert.equal(h.body.checks.database.status, 'up');
    const token = await broken.login(USERS.northwindClerk);
    const r = await broken.call('POST', '/api/records', { token, body: { submission_id: uniqueId('noanchor'), payload: cleanInvoice() } });
    assert.equal(r.status, 201, 'the record itself is stored and valid');
    assert.equal(r.body.audit_anchored, false, 'the response says the anchor was not updated');
    const v = await verify();
    assert.equal(v.verdict, 'incomplete', 'rows the anchor does not cover are not reported intact');
    assert.equal(v.anchor.status, 'behind');
    assert.ok(v.anchor.unanchored_rows >= 1);
  } finally {
    await broken.close();
    await fs.unlink(blocked);
  }
  // The next write through a working store re-anchors the latest head.
  const again = await app.call('POST', '/api/records', { token: clerk, body: { submission_id: uniqueId('reanchor'), payload: cleanInvoice() } });
  assert.equal(again.body.audit_anchored, true);
  assert.equal((await verify()).verdict, 'intact');
});
