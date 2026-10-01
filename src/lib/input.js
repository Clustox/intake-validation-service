'use strict';

const { badRequest } = require('./errors');

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// JSON text can carry unpaired UTF-16 surrogates ("\ud800") that are not valid
// Unicode; MariaDB's JSON columns reject them. Check keys and strings anywhere.
function isWellFormedJson(v) {
  if (typeof v === 'string') return v.isWellFormed();
  if (Array.isArray(v)) return v.every(isWellFormedJson);
  if (v !== null && typeof v === 'object') return Object.entries(v).every(([k, x]) => k.isWellFormed() && isWellFormedJson(x));
  return true;
}

function requireObject(body, allowedKeys) {
  if (!isPlainObject(body)) throw badRequest('malformed_body', 'request body must be a JSON object');
  const unknown = Object.keys(body).filter(k => !allowedKeys.includes(k));
  if (unknown.length) throw badRequest('unknown_fields', `unexpected field(s): ${unknown.join(', ')}`, { fields: unknown });
  return body;
}

function positiveInt(value, name) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) return Number(value);
  throw badRequest('invalid_parameter', `${name} must be a positive integer`);
}

// Route ids: anything that is not a positive integer cannot exist.
const routeId = raw => (/^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null);

function pagination(query, api) {
  const afterId = query.after === undefined ? 0 : positiveIntOrZero(query.after, 'after');
  const limit = query.limit === undefined ? api.pageSizeDefault : positiveInt(query.limit, 'limit');
  if (limit > api.pageSizeMax) throw badRequest('invalid_parameter', `limit must not exceed ${api.pageSizeMax}`);
  return { afterId, limit };
}

function positiveIntOrZero(value, name) {
  if (typeof value === 'string' && /^(0|[1-9]\d{0,15})$/.test(value)) return Number(value);
  throw badRequest('invalid_parameter', `${name} must be a non-negative integer`);
}

function page(items, limit, cursorOf) {
  return { items, next_cursor: items.length === limit ? cursorOf(items[items.length - 1]) : null };
}

module.exports = { isPlainObject, isWellFormedJson, requireObject, positiveInt, routeId, pagination, page };
