'use strict';

const mariadb = require('mariadb');

// Shared connector options. dateStrings keeps DATETIME values as the exact
// strings the server stores (no timezone conversion), which the audit hash
// chain relies on. Numbers come back as JS numbers, never BigInt.
const COMMON = {
  dateStrings: true,
  bigIntAsNumber: true,
  insertIdAsNumber: true,
  decimalAsNumber: true,
  checkDuplicate: false,
  // Timestamps are stored and reported in UTC regardless of server settings, and
  // strict mode makes an over-long or invalid value an error instead of being
  // silently truncated or coerced by a server with a lax default sql_mode.
  initSql: "SET time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
};

function createPool(db, overrides = {}) {
  return mariadb.createPool({
    ...COMMON,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.poolLimit,
    acquireTimeout: db.acquireTimeoutMs,
    connectTimeout: db.connectTimeoutMs,
    minimumIdle: 0,
    ...overrides,
  });
}

function createAdminConnection(db, { database = db.database, multipleStatements = false } = {}) {
  return mariadb.createConnection({
    ...COMMON,
    host: db.host,
    port: db.port,
    user: db.adminUser,
    password: db.adminPassword,
    database: database || undefined,
    connectTimeout: db.connectTimeoutMs,
    multipleStatements,
  });
}

// JSON columns are LONGTEXT in MariaDB; depending on server metadata the
// connector may hand back either a parsed value or a string.
function parseJson(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

module.exports = { createPool, createAdminConnection, parseJson };
