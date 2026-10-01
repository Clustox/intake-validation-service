'use strict';

// Usage: node scripts/seed.js [--reset]
// Creates the lookup reference tables (seeds/reference_tables.sql: fixtures,
// not part of the migrated schema) and loads seeds/synthetic.json. Refuses to run against a database that already
// holds organisations unless --reset is given, which drops the database and
// re-runs every migration first (the audit trail cannot be selectively deleted).

const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcrypt');
const config = require('../src/config');
const { createAdminConnection } = require('../src/db');
const { migrate } = require('./lib/migrator');
const audit = require('../src/audit');
const { AnchorStore } = require('../src/anchor');
const { validateRuleDefinition } = require('../src/engine');

const SEED_FILE = path.join(__dirname, '..', 'seeds', 'synthetic.json');
const REFERENCE_TABLES_SQL = path.join(__dirname, '..', 'seeds', 'reference_tables.sql');

async function seed(cfg, { database = cfg.db.database, password, file = SEED_FILE, log = () => {} } = {}) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Seeded rules pass the same checks as rules created through the API.
  for (const org of data.organisations) {
    for (const r of org.rules) {
      const errors = validateRuleDefinition(r, cfg.engine);
      if (errors.length) throw new Error(`seed rule "${r.name}" is invalid: ${errors.join('; ')}`);
    }
  }
  const passwordHash = await bcrypt.hash(password, cfg.bcryptCost);
  const conn = await createAdminConnection(cfg.db, { database, multipleStatements: true });
  const summary = [];
  const heads = [];
  try {
    const [{ n }] = await conn.query('SELECT COUNT(*) AS n FROM organisations');
    if (n > 0) throw new Error(`database ${database} already contains data; use --reset to rebuild it`);
    // Lookup reference tables are fixtures, not schema: the seed creates them.
    await conn.query(fs.readFileSync(REFERENCE_TABLES_SQL, 'utf8'));
    log('created lookup reference tables (fixtures): ref_suppliers, ref_cost_centres');
    await conn.beginTransaction();
    for (const org of data.organisations) {
      const { insertId: orgId } = await conn.query('INSERT INTO organisations (name) VALUES (?)', [org.name]);
      for (const u of org.users) {
        await conn.query('INSERT INTO users (org_id, email, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)',
          [orgId, u.email.toLowerCase(), u.display_name, passwordHash, u.role]);
      }
      for (const [table, rows] of Object.entries(org.reference)) {
        if (!/^ref_[a-z_]+$/.test(table)) throw new Error(`unexpected reference table ${table}`);
        for (const row of rows) {
          await conn.query(`INSERT INTO ${conn.escapeId(table)} (org_id, code, name) VALUES (?, ?, ?)`, [orgId, row.code, row.name]);
        }
      }
      for (const r of org.rules) {
        await conn.query('INSERT INTO validation_rules (org_id, name, rule_type, field, config, message) VALUES (?, ?, ?, ?, ?, ?)',
          [orgId, r.name, r.rule_type, r.field, JSON.stringify(r.config), r.message]);
      }
      heads.push(await audit.append(conn, {
        orgId, action: 'seed.loaded', entityType: 'organisation', entityId: orgId,
        data: { users: org.users.length, rules: org.rules.length, source: path.basename(file) },
      }).then(h => ({ orgId, ...h })));
      summary.push({ orgId, name: org.name, users: org.users.map(u => `${u.email} (${u.role})`), rules: org.rules.length });
      log(`seeded ${org.name}: ${org.users.length} users, ${org.rules.length} rules`);
    }
    await conn.commit();
    // Anchor each new chain outside the database, now that it is committed.
    const anchor = new AnchorStore(cfg.anchor, database);
    for (const h of heads) {
      if (!(await anchor.record(h.orgId, h))) throw new Error(`could not write the audit anchor for organisation ${h.orgId} to ${cfg.anchor.dir}`);
    }
    return summary;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  (async () => {
    const cfg = config.load();
    const password = process.env.SEED_USER_PASSWORD;
    if (!password || password.length < 12) throw new Error('SEED_USER_PASSWORD must be set (at least 12 characters)');
    if (process.argv.includes('--reset')) {
      await migrate(cfg.db, { fresh: true, log: m => console.log(`[seed] ${m}`) });
      await new AnchorStore(cfg.anchor, cfg.db.database).clear();
      console.log('[seed] cleared audit anchors of the dropped database');
    }
    const summary = await seed(cfg, { password, log: m => console.log(`[seed] ${m}`) });
    console.log('[seed] done. Sign in with any of these (password = SEED_USER_PASSWORD):');
    for (const o of summary) console.log(`  ${o.name}: ${o.users.join(', ')}`);
  })().catch(err => {
    console.error(`[seed] FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { seed };
