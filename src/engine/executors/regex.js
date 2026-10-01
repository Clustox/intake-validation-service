'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { pass, fail, unknown, getField, isAbsent, absent } = require('../outcome');

const KEYS = new Set(['pattern', 'flags', 'optional']);
const ALLOWED_FLAGS = /^[imsu]*$/; // g and y make RegExp.test stateful
const WORKER = path.join(__dirname, '..', 'regex-worker.js');

function validateConfig(c) {
  const errors = [];
  for (const k of Object.keys(c)) if (!KEYS.has(k)) errors.push(`unsupported key "${k}"`);
  if (typeof c.pattern !== 'string' || c.pattern === '') errors.push('pattern must be a non-empty string');
  if ('flags' in c && (typeof c.flags !== 'string' || !ALLOWED_FLAGS.test(c.flags))) errors.push('flags may only contain i, m, s, u');
  if ('optional' in c && typeof c.optional !== 'boolean') errors.push('optional must be boolean');
  if (!errors.length) {
    try { new RegExp(c.pattern, c.flags || ''); } catch (e) { errors.push(`pattern does not compile: ${e.message}`); }
  }
  return errors;
}

// Patterns come from the database, so a catastrophic one must not be able to
// block the event loop. Matching runs in a worker thread with a time budget;
// exceeding it yields unknown.
function matchInWorker(pattern, flags, value, timeoutMs) {
  return new Promise(resolve => {
    const worker = new Worker(WORKER, { workerData: { pattern, flags, value } });
    let settled = false;
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(r);
    };
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
    worker.once('message', m => finish(m));
    worker.once('error', e => finish({ error: e.message }));
    worker.once('exit', code => finish({ error: `worker exited with code ${code}` }));
  });
}

async function run(payload, rule, ctx) {
  const c = rule.config;
  const v = getField(payload, rule.field);
  if (isAbsent(v)) return absent(c, rule.field);
  if (typeof v !== 'string') return fail('not_a_string');
  const r = await matchInWorker(c.pattern, c.flags || '', v, ctx.regexTimeoutMs);
  if (r.timeout) return unknown('evaluation_timeout', `pattern evaluation exceeded ${ctx.regexTimeoutMs} ms`);
  if (r.error) return unknown('evaluation_error', r.error);
  return r.matched ? pass() : fail('no_match');
}

module.exports = { validateConfig, run };
