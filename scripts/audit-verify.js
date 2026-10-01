'use strict';

// Usage: node scripts/audit-verify.js
// Verifies every organisation's audit chain against its stored rows and its
// external anchor. Prints one line per organisation:
//   INTACT      chain verifies and the anchor covers its head
//   TAMPERED    an altered, missing or rewritten row, or an altered anchor
//   INCOMPLETE  nothing wrong found, but not fully checked (no anchor, anchor
//               unreadable, or rows newer than the anchor)
// Exit 0 only if every chain is INTACT; 1 if any is TAMPERED; 2 if any is
// INCOMPLETE or verification could not run.

const config = require('../src/config');
const { createAdminConnection } = require('../src/db');
const { verifyChain } = require('../src/audit');
const { AnchorStore } = require('../src/anchor');

(async () => {
  let conn;
  let anchorStore;
  try {
    const cfg = config.load({ dbName: process.env.AUDIT_VERIFY_DB || undefined });
    anchorStore = new AnchorStore(cfg.anchor, cfg.db.database);
    conn = await createAdminConnection(cfg.db);
  } catch (err) {
    console.error(`NOT RUN     audit verification could not start: ${err.code || err.message}`);
    process.exit(2);
  }
  const verdicts = [];
  try {
    const orgs = await conn.query('SELECT id, name FROM organisations ORDER BY id');
    if (!orgs.length) { console.log('NOT RUN     no organisations: nothing to verify'); verdicts.push('incomplete'); }
    for (const o of orgs) {
      const v = await verifyChain(conn, o.id, { anchorStore });
      verdicts.push(v.verdict);
      const head = v.chain.head ? `head seq ${v.chain.head.seq}` : 'empty chain';
      const anchored = v.anchor.anchored_seq ? `, anchored seq ${v.anchor.anchored_seq}` : '';
      console.log(`${v.verdict.toUpperCase().padEnd(11)} org ${o.id} (${o.name}): ${v.chain.rows_checked} rows verified, ${head}${anchored}${v.notes.length ? ` - ${v.notes.join('; ')}` : ''}`);
    }
  } catch (err) {
    console.error(`NOT RUN     verification failed part-way: ${err.code || err.message}`);
    process.exit(2);
  } finally {
    await conn.end().catch(() => {});
  }
  process.exit(verdicts.includes('tampered') ? 1 : verdicts.every(v => v === 'intact') ? 0 : 2);
})();
