'use strict';

// Usage: node scripts/verify.js
//
// Runs every check in scripts/lib/checks.js and prints one line per check:
//   PASS     the check ran and every assertion held
//   FAIL     the check ran and something did not hold
//   NOT RUN  the check could not run (e.g. database unreachable, test missing)
// Exit code is 0 only when every check is PASS. NOT RUN is never counted as a
// pass. A machine-readable copy is written to verify-report.json.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CHECKS, GROUPS } = require('./lib/checks');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(ROOT, 'verify-report.json');
const TEST_RUN_TIMEOUT_MS = 10 * 60 * 1000;

const results = new Map(); // id -> { status, detail, tests }
const set = (id, status, detail, extra = {}) => results.set(id, { status, detail, ...extra });
const env = { node: process.version, platform: `${os.type()} ${os.release()} ${os.arch()}`, database: null };

// ---------------------------------------------------------------- preflight

function checkNode() {
  if (/^v20\./.test(process.version)) set('ENV-NODE', 'PASS', process.version);
  else set('ENV-NODE', 'FAIL', `running ${process.version}; the acceptance runtime is Node.js 20.x`);
}

function checkDeps() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const problems = [];
  for (const [name, want] of Object.entries(pkg.dependencies)) {
    try {
      const got = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
      if (got !== want) problems.push(`${name} ${got} (package.json pins ${want})`);
    } catch {
      problems.push(`${name} not installed`);
    }
  }
  if (problems.length) set('ENV-DEPS', 'FAIL', problems.join('; '));
  else set('ENV-DEPS', 'PASS', Object.entries(pkg.dependencies).map(([n, v]) => `${n}@${v}`).join(', '));
}

async function checkDatabase() {
  let cfg;
  try {
    cfg = require('../src/config').load();
  } catch (err) {
    set('ENV-DB', 'NOT RUN', `configuration invalid: ${err.message}`);
    set('ENV-MARIADB', 'NOT RUN', 'configuration invalid');
    return { cfg: null, reachable: false };
  }
  const { createAdminConnection } = require('../src/db');
  let conn;
  try {
    conn = await createAdminConnection(cfg.db, { database: null });
    const [{ v }] = await conn.query('SELECT VERSION() AS v');
    env.database = v;
    set('ENV-DB', 'PASS', `${cfg.db.host}:${cfg.db.port} as ${cfg.db.adminUser}`);
    if (/^11\.4\.\d+-MariaDB/.test(v)) set('ENV-MARIADB', 'PASS', v);
    else set('ENV-MARIADB', 'FAIL', `server reports "${v}"; the acceptance database is MariaDB 11.4`);
    return { cfg, reachable: true };
  } catch (err) {
    set('ENV-DB', 'FAIL', `cannot connect to ${cfg.db.host}:${cfg.db.port}: ${err.code || err.message}`);
    set('ENV-MARIADB', 'NOT RUN', 'database unreachable');
    return { cfg, reachable: false };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

// ---------------------------------------------------------------- test suite

function runTests() {
  return new Promise(resolve => {
    // Explicit file list: directory arguments to --test differ between Node versions.
    const files = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
    const args = ['--test', '--test-concurrency=1', `--test-reporter=${path.join(__dirname, 'lib', 'jsonl-reporter.js')}`, '--test-reporter-destination=stdout', ...files];
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    const events = [];
    let buf = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith('IVS-RESULT ')) events.push(JSON.parse(line.slice(11)));
      }
    });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TEST_RUN_TIMEOUT_MS);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, events, stderr }); });
  });
}

function applyTestResults(run) {
  const byId = new Map();
  const untracked = [];
  const fileLevel = [];
  for (const e of run.events) {
    const m = /^\[([A-Z0-9-]+)\]/.exec(e.name);
    if (!m) { (e.nesting === 0 && /\.test\.js$/.test(e.name) ? fileLevel : untracked).push(e); continue; }
    if (!byId.has(m[1])) byId.set(m[1], []);
    byId.get(m[1]).push(e);
  }
  for (const c of CHECKS.filter(x => x.kind === 'test')) {
    const tests = byId.get(c.id) || [];
    const ran = tests.filter(t => !t.skip && !t.todo);
    const failed = ran.filter(t => !t.passed);
    const summary = tests.map(t => ({ name: t.name, result: t.skip || t.todo ? 'NOT RUN' : t.passed ? 'PASS' : 'FAIL', duration_ms: t.duration_ms, error: t.error }));
    if (!tests.length) set(c.id, 'NOT RUN', run.signal ? 'test run was killed before this check reported' : 'no test reported a result for this check', { tests: summary });
    else if (failed.length) set(c.id, 'FAIL', `${failed.length}/${ran.length} failed: ${failed[0].name} -> ${failed[0].error}`, { tests: summary });
    else if (ran.length < tests.length) set(c.id, 'NOT RUN', `${tests.length - ran.length} of ${tests.length} tests skipped`, { tests: summary });
    else set(c.id, 'PASS', `${ran.length}/${ran.length} tests passed`, { tests: summary });
  }
  const problems = [
    ...untracked.filter(e => !e.passed).map(e => `untracked test failed: ${e.name}: ${e.error}`),
    ...fileLevel.filter(e => !e.passed).map(e => `test file failed outside a test (hook/timeout): ${path.basename(e.name)}: ${e.error}`),
  ];
  const failedEvents = run.events.filter(e => !e.passed).length;
  if (run.code !== 0 && failedEvents === 0) problems.push(`test runner exited with code ${run.code}${run.signal ? ` (signal ${run.signal})` : ''}: ${run.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return problems;
}

// ---------------------------------------------------------------- smoke

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function smoke() {
  const password = process.env.SEED_USER_PASSWORD;
  if (!password) return set('SMOKE', 'NOT RUN', 'SEED_USER_PASSWORD not set');
  const port = await freePort();
  const server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port) } });
  let log = '';
  server.stdout.on('data', c => { log += c; });
  server.stderr.on('data', c => { log += c; });
  const base = `http://127.0.0.1:${port}/api`;
  const req = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    let live = false;
    for (let i = 0; i < 50 && !live; i += 1) {
      await new Promise(r => setTimeout(r, 200));
      live = await req('GET', '/health/live').then(r => r.status === 200).catch(() => false);
    }
    if (!live) return set('SMOKE', 'FAIL', `service did not start: ${log.trim().split('\n').slice(-2).join(' | ')}`);
    const ready = await req('GET', '/health');
    if (ready.status !== 200) return set('SMOKE', 'FAIL', `readiness ${ready.status}: ${JSON.stringify(ready.body)}`);
    const login = await req('POST', '/auth/login', { email: 'admin@northwind.example', password });
    if (login.status !== 200) return set('SMOKE', 'FAIL', `seed login failed (${login.status}); has "npm run seed" been run?`);
    const token = login.body.token;
    const sub = await req('POST', '/records', {
      submission_id: `verify-smoke-${Date.now()}`,
      payload: { invoice_number: 'INV-2026-0042', amount: 250, currency: 'GBP', invoice_date: '2026-09-01', due_date: '2026-09-30', supplier_code: 'SUP-200' },
    }, token);
    if (sub.status !== 201 || sub.body.verdict !== 'clean' || sub.body.fully_evaluated !== true) {
      return set('SMOKE', 'FAIL', `expected 201 clean/fully_evaluated, got ${sub.status} ${sub.body && sub.body.verdict}`);
    }
    const unk = await req('POST', '/records', {
      submission_id: `verify-smoke-unknown-${Date.now()}`,
      payload: { invoice_number: 'INV-2026-0043', amount: 250, currency: 'GBP', invoice_date: '2026-09-01', due_date: '2026-09-30' },
    }, token);
    if (unk.status !== 201 || unk.body.verdict === 'clean') {
      return set('SMOKE', 'FAIL', `record missing its lookup field should not be clean; got ${unk.status} ${unk.body && unk.body.verdict}`);
    }
    const replay = await req('POST', '/records', { submission_id: sub.body.submission_id, payload: sub.body.payload }, token);
    if (replay.status !== 200 || replay.body.replayed !== true || replay.body.id !== sub.body.id) {
      return set('SMOKE', 'FAIL', `resubmission should be a labelled replay of record ${sub.body.id}; got ${replay.status} replayed=${replay.body && replay.body.replayed}`);
    }
    const chain = await req('GET', '/audit/verify', null, token);
    if (chain.status !== 200 || chain.body.verdict !== 'intact') return set('SMOKE', 'FAIL', `audit trail not verified intact: ${JSON.stringify(chain.body)}`);
    return set('SMOKE', 'PASS', `ready; clean record ${sub.body.id}; unverifiable record ${unk.body.id} reported ${unk.body.verdict}; resubmission replayed; audit trail intact against its anchor (${chain.body.chain.rows_checked} rows, anchored seq ${chain.body.anchor.anchored_seq})`);
  } catch (err) {
    return set('SMOKE', 'FAIL', `smoke check error: ${err.message}`);
  } finally {
    server.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------- main

(async () => {
  const started = new Date();
  console.log('Intake Validation Service - verifier');
  console.log(`node ${process.version} | ${env.platform}`);

  checkNode();
  checkDeps();
  const db = await checkDatabase();
  if (env.database) console.log(`database ${env.database}`);

  let extraProblems = [];
  if (db.reachable) {
    process.stdout.write('running test suite...\n');
    const run = await runTests();
    extraProblems = applyTestResults(run);
    await smoke();
  } else {
    for (const c of CHECKS.filter(x => x.kind !== 'preflight')) set(c.id, 'NOT RUN', 'database unreachable: check could not run');
  }

  console.log('');
  let lastGroup;
  for (const c of CHECKS) {
    if (c.group !== lastGroup) { console.log(`\n${GROUPS[c.group]}`); lastGroup = c.group; }
    const r = results.get(c.id) || { status: 'NOT RUN', detail: 'check did not execute' };
    results.set(c.id, r);
    console.log(`  ${r.status.padEnd(8)} [${c.id}] ${c.title}${r.detail ? `\n           ${r.detail}` : ''}`);
  }
  if (extraProblems.length) {
    console.log('\nOther failures');
    for (const p of extraProblems) console.log(`  FAIL     ${p}`);
  }

  const counts = { PASS: 0, FAIL: 0, 'NOT RUN': 0 };
  for (const r of results.values()) counts[r.status] += 1;
  const ok = counts.FAIL === 0 && counts['NOT RUN'] === 0 && extraProblems.length === 0;
  console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts['NOT RUN']} not run${extraProblems.length ? `, ${extraProblems.length} other failure(s)` : ''}`);
  console.log(ok ? 'VERIFIED: every check ran and passed.' : 'NOT VERIFIED: see FAIL / NOT RUN above.');

  fs.writeFileSync(REPORT, `${JSON.stringify({
    started_at: started.toISOString(), finished_at: new Date().toISOString(), environment: env, verified: ok, counts,
    checks: CHECKS.map(c => ({ ...c, ...results.get(c.id) })), other_failures: extraProblems,
  }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
})().catch(err => {
  console.error(`verifier crashed: ${err.stack || err.message}`);
  console.error('NOT VERIFIED');
  process.exit(1);
});
