'use strict';

// All tunables come from the environment. Missing or malformed values stop the
// process at startup rather than falling back to a silent default.

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function loadEnvFile() {
  // Node 20.12+ reads .env natively; no dotenv dependency. Real environment
  // variables take precedence over the file.
  if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

class ConfigError extends Error {}

function str(name, { minLength = 1 } = {}) {
  const v = process.env[name];
  if (v === undefined || v.length < minLength) {
    throw new ConfigError(`${name} must be set${minLength > 1 ? ` (at least ${minLength} characters)` : ''}`);
  }
  return v;
}

function int(name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = str(name);
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
  const v = Number(raw);
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${v}`);
  return v;
}

function identifier(name) {
  const v = str(name);
  if (!/^[A-Za-z0-9_]+$/.test(v)) throw new ConfigError(`${name} must contain only letters, digits and underscores`);
  return v;
}

function lookupAllowlist(name) {
  const raw = process.env[name] || '';
  const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
  const set = new Set();
  for (const e of entries) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(e)) {
      throw new ConfigError(`${name} entry "${e}" must look like table.column (lowercase identifiers)`);
    }
    set.add(e);
  }
  return set;
}

function load({ dbName } = {}) {
  loadEnvFile();
  const cfg = {
    port: int('PORT', { max: 65535 }),
    db: {
      host: str('DB_HOST'),
      port: int('DB_PORT', { min: 1, max: 65535 }),
      database: dbName || identifier('DB_NAME'),
      user: str('DB_USER'),
      password: str('DB_PASSWORD'),
      appHost: str('DB_APP_HOST'),
      adminUser: str('DB_ADMIN_USER'),
      adminPassword: str('DB_ADMIN_PASSWORD'),
      poolLimit: int('DB_POOL_LIMIT', { min: 1, max: 500 }),
      acquireTimeoutMs: int('DB_ACQUIRE_TIMEOUT_MS', { min: 100 }),
      connectTimeoutMs: int('DB_CONNECT_TIMEOUT_MS', { min: 100 }),
      testDatabase: identifier('TEST_DB_NAME'),
    },
    jwt: {
      secret: str('JWT_SECRET', { minLength: 32 }),
      issuer: str('JWT_ISSUER'),
      audience: str('JWT_AUDIENCE'),
      ttlSeconds: int('JWT_TTL_SECONDS', { min: 60 }),
    },
    bcryptCost: int('BCRYPT_COST', { min: 4, max: 15 }),
    engine: {
      ruleTimeoutMs: int('RULE_TIMEOUT_MS', { min: 10 }),
      regexTimeoutMs: int('REGEX_TIMEOUT_MS', { min: 10 }),
      lookupAllowlist: lookupAllowlist('LOOKUP_ALLOWLIST'),
    },
    api: {
      maxBodyBytes: int('MAX_BODY_BYTES', { min: 1024 }),
      pageSizeDefault: int('PAGE_SIZE_DEFAULT', { min: 1 }),
      pageSizeMax: int('PAGE_SIZE_MAX', { min: 1 }),
    },
    health: {
      dbTimeoutMs: int('HEALTH_DB_TIMEOUT_MS', { min: 100 }),
    },
    anchor: {
      dir: path.resolve(path.join(__dirname, '..'), str('ANCHOR_DIR')),
      key: str('ANCHOR_KEY', { minLength: 32 }),
    },
  };
  if (cfg.api.pageSizeDefault > cfg.api.pageSizeMax) {
    throw new ConfigError('PAGE_SIZE_DEFAULT must not exceed PAGE_SIZE_MAX');
  }
  return cfg;
}

module.exports = { load, ConfigError };
