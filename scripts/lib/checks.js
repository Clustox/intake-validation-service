'use strict';

// The verifier's manifest: every check it must report. A check with no test
// result is reported NOT RUN, never PASS. Test names carry the id in brackets,
// e.g. "[F01] ...", which is how results are matched to checks.

const GROUPS = {
  ENV: 'Runtime and environment',
  REQ: 'Required failure-path tests (specification list)',
  P1: 'Principle 1: a rule that could not be evaluated is not a pass',
  P2: 'Principle 2: organisation scoping on every path',
  P3: 'Principle 3: rules are data, not code',
  P4: 'Principle 4: a dependency failure surfaces as a failure',
  AUD: 'Audit trail: external anchor and hash integrity',
  FN: 'Functional behaviour',
};

const CHECKS = [
  { id: 'ENV-NODE', group: 'ENV', kind: 'preflight', title: 'Node.js runtime is 20.x' },
  { id: 'ENV-DB', group: 'ENV', kind: 'preflight', title: 'Database reachable with the configured admin credentials' },
  { id: 'ENV-MARIADB', group: 'ENV', kind: 'preflight', title: 'Database server is MariaDB 11.4.x' },
  { id: 'ENV-DEPS', group: 'ENV', kind: 'preflight', title: 'Installed dependencies match the exact versions in package.json' },

  { id: 'F01', group: 'REQ', kind: 'test', title: 'Database unreachable mid-submission: 503, nothing persisted' },
  { id: 'F02', group: 'REQ', kind: 'test', title: 'Missing lookup table produces unknown, not pass' },
  { id: 'F03', group: 'REQ', kind: 'test', title: 'Malformed payload rejected' },
  { id: 'F04', group: 'REQ', kind: 'test', title: 'Missing required fields' },
  { id: 'F05', group: 'REQ', kind: 'test', title: 'Absent token rejected' },
  { id: 'F06', group: 'REQ', kind: 'test', title: 'Expired token rejected' },
  { id: 'F07', group: 'REQ', kind: 'test', title: 'Wrongly-signed token rejected' },
  { id: 'F08', group: 'REQ', kind: 'test', title: "One organisation cannot read another's record" },
  { id: 'F09', group: 'REQ', kind: 'test', title: 'Duplicate submission (a replay is labelled as a replay)' },
  { id: 'F10', group: 'REQ', kind: 'test', title: 'Rule deactivated mid-run' },
  { id: 'F11', group: 'REQ', kind: 'test', title: 'Numeric boundary values' },
  { id: 'F12', group: 'REQ', kind: 'test', title: 'Modified audit row detected' },

  { id: 'T01', group: 'AUD', kind: 'test', title: 'External anchor: removal or rewrite of the newest rows is detected' },
  { id: 'T02', group: 'AUD', kind: 'test', title: 'External anchor: a missing, edited or foreign anchor is never read as intact' },
  { id: 'T03', group: 'AUD', kind: 'test', title: 'Hash what is stored: every committed row re-verifies from its own columns' },
  { id: 'T04', group: 'AUD', kind: 'test', title: 'Altering any single hashed column of a genuine row fails verification' },

  { id: 'U01', group: 'P1', kind: 'test', title: 'Verdict aggregation never folds unknown into clean' },
  { id: 'U02', group: 'P1', kind: 'test', title: 'Errors, timeouts, unreachable lookups and absent data yield unknown' },
  { id: 'U03', group: 'P1', kind: 'test', title: 'Catastrophic regex yields unknown without blocking the service' },
  { id: 'C02', group: 'P1', kind: 'test', title: 'API reports a record carrying an unknown as incomplete' },
  { id: 'L02', group: 'P1', kind: 'test', title: 'Lookup allow-list fails closed (unknown, not pass, not a crash)' },

  { id: 'S01', group: 'P2', kind: 'test', title: 'Pagination returns only own records' },
  { id: 'S02', group: 'P2', kind: 'test', title: "Cannot correct another organisation's record" },
  { id: 'S03', group: 'P2', kind: 'test', title: 'Audit trail and verification are organisation-scoped' },
  { id: 'S04', group: 'P2', kind: 'test', title: "Cannot read or change another organisation's rules" },
  { id: 'S05', group: 'P2', kind: 'test', title: 'Client-supplied organisation parameter refused' },
  { id: 'S06', group: 'P2', kind: 'test', title: 'Lookups are organisation-scoped' },
  { id: 'A01', group: 'P2', kind: 'test', title: 'Token scope re-checked against the users table' },

  { id: 'R01', group: 'P3', kind: 'test', title: 'A rule inserted as a row applies with no code change' },
  { id: 'R02', group: 'P3', kind: 'test', title: 'Malformed or unsupported stored rules yield unknown' },
  { id: 'R03', group: 'P3', kind: 'test', title: 'Rule administration API validates, versions and audits' },

  { id: 'H01', group: 'P4', kind: 'test', title: 'Readiness reports the failed dependency; liveness is separate' },
  { id: 'H03', group: 'P4', kind: 'test', title: 'Readiness reports a schema behind the code' },
  { id: 'H04', group: 'P4', kind: 'test', title: 'Reads with the database down fail loudly (no empty list, no 401)' },
  { id: 'H05', group: 'P4', kind: 'test', title: 'Anchor store failure surfaces in readiness, the response and verification' },

  { id: 'A00', group: 'FN', kind: 'test', title: 'Valid token accepted' },
  { id: 'A02', group: 'FN', kind: 'test', title: 'Login: bcrypt hashes, uniform failure response' },
  { id: 'A03', group: 'FN', kind: 'test', title: 'Role enforcement on rule administration' },
  { id: 'A04', group: 'FN', kind: 'test', title: 'Security headers set by helmet' },
  { id: 'C01', group: 'FN', kind: 'test', title: 'A valid record is reported checked and clean' },
  { id: 'C03', group: 'FN', kind: 'test', title: 'Record correction re-validates, versions and audits' },
  { id: 'E01', group: 'FN', kind: 'test', title: 'Executors: required, date, cross-field, regex, messages' },
  { id: 'L01', group: 'FN', kind: 'test', title: 'Lookup pass and fail' },
  { id: 'M01', group: 'FN', kind: 'test', title: 'Migrations create exactly the five specified tables (plus the migration tracker)' },
  { id: 'SMOKE', group: 'FN', kind: 'smoke', title: 'Service starts on the seeded database, reports ready, validates a record end to end' },
];

module.exports = { CHECKS, GROUPS };
