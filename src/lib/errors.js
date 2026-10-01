'use strict';

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (code, message, extra) => new HttpError(400, code, message, extra);
const notFound = () => new HttpError(404, 'not_found', 'resource not found');
const conflict = (code, message, extra) => new HttpError(409, code, message, extra);

// Connector error codes that mean "the database could not be reached or the
// connection was lost". Transient server-side conditions (deadlock, lock wait
// timeout) are grouped with them: the request did not complete.
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE',
  'ER_GET_CONNECTION_TIMEOUT', 'ER_CONNECTION_TIMEOUT', 'ER_SOCKET_UNEXPECTED_CLOSE',
  'ER_CLOSING_POOL', 'ER_POOL_ALREADY_CLOSED', 'ER_CMD_CONNECTION_CLOSED', 'ER_CONNECTION_ALREADY_CLOSED',
  'ER_SOCKET_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT',
]);

function isDbUnavailable(err) {
  if (!err || err instanceof HttpError) return false;
  return err.fatal === true || UNAVAILABLE_CODES.has(err.code) || (typeof err.sqlState === 'string' && err.sqlState.startsWith('08'));
}

module.exports = { HttpError, badRequest, notFound, conflict, isDbUnavailable };
