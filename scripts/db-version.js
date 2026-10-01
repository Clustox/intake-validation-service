'use strict';

// Prints the database server version string (used by the evidence script).
const config = require('../src/config');
const { createAdminConnection } = require('../src/db');

(async () => {
  const cfg = config.load();
  const conn = await createAdminConnection(cfg.db, { database: null });
  try {
    const [r] = await conn.query('SELECT VERSION() AS version, @@version_comment AS comment');
    console.log(`${r.version} (${r.comment})`);
  } finally {
    await conn.end();
  }
})().catch(err => { console.error(`cannot read database version: ${err.code || err.message}`); process.exit(1); });
