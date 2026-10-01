'use strict';

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { testConfig, resetDatabase, startApp, adminQuery, USERS } = require('./helpers/env');

let cfg, app, clerkToken, clerkId, orgId;

before(async () => {
  cfg = testConfig();
  await resetDatabase(cfg);
  app = await startApp(cfg);
  clerkToken = await app.login(USERS.northwindClerk);
  const [u] = await adminQuery(cfg, 'SELECT id, org_id FROM users WHERE email = ?', [USERS.northwindClerk]);
  clerkId = u.id; orgId = u.org_id;
});
after(async () => { await app.close(); });

const sign = (claims, opts = {}, secret = cfg.jwt.secret) => jwt.sign({ org: orgId, role: 'submitter', ...claims }, secret, {
  algorithm: 'HS256', subject: String(clerkId), issuer: cfg.jwt.issuer, audience: cfg.jwt.audience,
  ...('exp' in claims ? {} : { expiresIn: 600 }), ...opts,
});
const get = token => app.call('GET', '/api/records', { token });

test('[A00] a valid token is accepted', async () => {
  assert.equal((await get(clerkToken)).status, 200);
});

test('[F05] absent token is rejected with 401', async () => {
  const r = await get(undefined);
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'missing_token');
});

test('[F05] malformed Authorization header is rejected with 401', async () => {
  for (const h of ['Bearer', 'Bearer not-a-jwt', 'Basic dXNlcjpwYXNz', `bearer${clerkToken}`]) {
    const r = await app.call('GET', '/api/records', { headers: { authorization: h } });
    assert.equal(r.status, 401, h);
  }
});

test('[F06] expired token is rejected with 401 token_expired', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = sign({ iat: now - 7200, exp: now - 60 });
  const r = await get(expired);
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'token_expired');
});

test('[F07] token signed with a different secret is rejected with 401', async () => {
  const r = await get(sign({}, {}, 'a-completely-different-secret-that-is-long-enough'));
  assert.equal(r.status, 401);
  assert.equal(r.body.reason, 'invalid_token');
});

test('[F07] token with a tampered payload (original signature) is rejected', async () => {
  const [h, , s] = clerkToken.split('.');
  const forged = Buffer.from(JSON.stringify({ ...jwt.decode(clerkToken), role: 'admin', org: orgId + 1 })).toString('base64url');
  assert.equal((await get(`${h}.${forged}.${s}`)).status, 401);
});

test('[F07] unsigned token (alg none) is rejected', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(jwt.decode(clerkToken))).toString('base64url');
  assert.equal((await get(`${header}.${body}.`)).status, 401);
});

test('[F07] token with wrong issuer or audience is rejected', async () => {
  assert.equal((await get(sign({}, { issuer: 'someone-else' }))).status, 401);
  assert.equal((await get(sign({}, { audience: 'another-api' }))).status, 401);
});

test('[A01] token for a deactivated user is rejected', async () => {
  await adminQuery(cfg, 'UPDATE users SET active = 0 WHERE id = ?', [clerkId]);
  try {
    const r = await get(clerkToken);
    assert.equal(r.status, 401);
    assert.equal(r.body.reason, 'user_not_active');
  } finally {
    await adminQuery(cfg, 'UPDATE users SET active = 1 WHERE id = ?', [clerkId]);
  }
});

test('[A01] token whose org claim does not match the user is rejected', async () => {
  assert.equal((await get(sign({ org: orgId + 1 }))).status, 401);
});

test('[A02] wrong password and unknown email both give the same 401', async () => {
  const a = await app.call('POST', '/api/auth/login', { body: { email: USERS.northwindClerk, password: 'wrong-password' } });
  const b = await app.call('POST', '/api/auth/login', { body: { email: 'nobody@nowhere.example', password: 'wrong-password' } });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body);
});

test('[A02] passwords are stored as bcrypt hashes', async () => {
  const [u] = await adminQuery(cfg, 'SELECT password_hash FROM users WHERE id = ?', [clerkId]);
  assert.match(u.password_hash, /^\$2[aby]\$\d{2}\$.{53}$/);
});

test('[A03] a submitter cannot administer rules (403)', async () => {
  const r = await app.call('POST', '/api/rules', { token: clerkToken, body: { name: 'x', rule_type: 'required', field: 'x', config: {}, message: 'x' } });
  assert.equal(r.status, 403);
});

test('[A04] security headers are set (helmet) and the framework is not advertised', async () => {
  const res = await fetch(`${app.baseUrl}/api/health/live`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy'));
  assert.ok(res.headers.get('strict-transport-security'));
});
