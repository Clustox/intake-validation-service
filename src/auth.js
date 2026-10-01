'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const users = require('./repo/users');
const audit = require('./audit');
const { withOrgTransaction } = require('./lib/tx');
const { HttpError, badRequest } = require('./lib/errors');
const { requireObject } = require('./lib/input');

const ALGORITHM = 'HS256';
const unauthenticated = reason => new HttpError(401, 'unauthenticated', 'authentication required', { reason });
const forbidden = () => new HttpError(403, 'forbidden', 'your role does not permit this action');

// Compared against when the email is unknown, so response time does not
// reveal which emails exist.
let dummyHash;
async function dummy(cost) {
  if (!dummyHash) dummyHash = await bcrypt.hash('not-a-real-password', cost);
  return dummyHash;
}

async function login(deps, body) {
  requireObject(body, ['email', 'password']);
  if (typeof body.email !== 'string' || typeof body.password !== 'string' || !body.email || !body.password) {
    throw badRequest('missing_fields', 'email and password are required');
  }
  const user = await users.findByEmailForLogin(deps.pool, body.email.trim().toLowerCase());
  const ok = await bcrypt.compare(body.password, user ? user.password_hash : await dummy(deps.config.bcryptCost));
  if (!user || !ok || user.active !== 1) {
    if (user) {
      await withOrgTransaction(deps, user.org_id, conn => audit.append(conn, {
        orgId: user.org_id, actorUserId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id,
        data: { reason: !ok ? 'bad_password' : 'user_inactive' },
      }));
    }
    throw new HttpError(401, 'invalid_credentials', 'email or password is incorrect');
  }
  const { secret, issuer, audience, ttlSeconds } = deps.config.jwt;
  const token = jwt.sign({ org: user.org_id, role: user.role }, secret,
    { algorithm: ALGORITHM, subject: String(user.id), issuer, audience, expiresIn: ttlSeconds });
  await withOrgTransaction(deps, user.org_id, conn => audit.append(conn, {
    orgId: user.org_id, actorUserId: user.id, action: 'auth.login_succeeded', entityType: 'user', entityId: user.id, data: {},
  }));
  return {
    token, token_type: 'Bearer', expires_in: ttlSeconds,
    user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role, organisation: { id: user.org_id, name: user.org_name } },
  };
}

// Organisation scope comes from the verified token and the users table - never
// from anything the client sends.
function requireAuth(deps) {
  return async (req, res, next) => {
    try {
      const header = req.get('authorization') || '';
      const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(header);
      if (!header) throw unauthenticated('missing_token');
      if (!m) throw unauthenticated('malformed_token');
      let claims;
      try {
        const { secret, issuer, audience } = deps.config.jwt;
        claims = jwt.verify(m[1], secret, { algorithms: [ALGORITHM], issuer, audience });
      } catch (err) {
        throw unauthenticated(err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token');
      }
      const userId = Number(claims.sub);
      if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(claims.org)) throw unauthenticated('invalid_token');
      // Database errors propagate (503); a missing or inactive user is a 401.
      const user = await users.findActive(deps.pool, claims.org, userId);
      if (!user) throw unauthenticated('user_not_active');
      req.auth = { userId: user.id, orgId: user.org_id, role: user.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

const requireRole = role => (req, res, next) => (req.auth.role === role ? next() : next(forbidden()));

module.exports = { login, requireAuth, requireRole };
