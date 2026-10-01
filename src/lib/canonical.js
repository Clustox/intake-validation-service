'use strict';

const crypto = require('node:crypto');

// Deterministic JSON: object keys sorted at every level, no whitespace.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// 'YYYY-MM-DD HH:MM:SS.mmm' in UTC: the exact DATETIME(3) text MariaDB stores.
const dbTimestamp = (d = new Date()) => d.toISOString().replace('T', ' ').replace('Z', '');
// Converts a stored DATETIME(3) string back to ISO-8601 for API responses.
const isoTimestamp = s => (s ? `${s.replace(' ', 'T')}Z` : s);

module.exports = { canonicalJson, sha256, dbTimestamp, isoTimestamp };
