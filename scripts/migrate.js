'use strict';

// Usage: node scripts/migrate.js [--fresh]
//   --fresh  drop and recreate the database first (destroys all data).

const config = require('../src/config');
const { migrate } = require('./lib/migrator');
const { AnchorStore } = require('../src/anchor');

(async () => {
  const cfg = config.load();
  const fresh = process.argv.includes('--fresh');
  const applied = await migrate(cfg.db, { fresh, log: m => console.log(`[migrate] ${m}`) });
  if (fresh) {
    // The old chains are gone with the old database; so must their anchors be.
    await new AnchorStore(cfg.anchor, cfg.db.database).clear();
    console.log(`[migrate] cleared audit anchors for ${cfg.db.database}`);
  }
  console.log(`[migrate] done: ${applied.length} new migration(s) applied to ${cfg.db.database}`);
})().catch(err => {
  console.error(`[migrate] FAILED: ${err.message}`);
  process.exit(1);
});
