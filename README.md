# Intake Validation Service

A small, self-contained service that accepts submitted records, validates each one against rules stored in the database, returns a verdict, and writes a tamper-evident audit trail. Everything runs on synthetic data.

**Stack:** Node.js 20 · Express 4 · MariaDB 11.4 (connection pool) · JWT bearer tokens · bcrypt · helmet · configuration through environment variables · server-rendered HTML with plain JavaScript · ordered SQL migrations, no ORM.

---

## Standing it up from a clean checkout

**Requirements**

- **Node.js 20.x**, at least 20.12. `.env` is read with Node's built-in `process.loadEnvFile`, so there is no dotenv dependency. `.nvmrc` and `engines` pin this, and `.npmrc` sets `engine-strict`, so `npm ci` refuses any other major version.
- **A MariaDB 11.4 server**, plus an account that can create databases, users and triggers. It's used only by migrate, seed and the tests. `docker-compose.yml` starts `mariadb:11.4` if you don't have one. Docker is optional; any MariaDB 11.4 reachable through the `DB_*` variables works (see "Using an existing MariaDB 11.4 server" below).
- No compiler toolchain is needed on common platforms. `bcrypt@6` ships prebuilt binaries and only falls back to `node-gyp` where no prebuild exists.

**Steps**

```bash
cp .env.example .env          # then set DB_*, DB_ADMIN_*, JWT_SECRET, ANCHOR_KEY, SEED_USER_PASSWORD
npm run db:up                 # optional: MariaDB 11.4 in Docker on 127.0.0.1:${DB_PORT}
npm ci
npm run migrate               # creates the database, applies migrations/NNN_*.sql, creates the least-privilege runtime account
npm run seed                  # synthetic organisations, users, rules, and the lookup fixture tables
npm run verify                # every check; prints PASS / FAIL / NOT RUN; exit 0 only if all PASS
npm start                     # http://localhost:${PORT}  (UI at /, API under /api)
```

**Using an existing MariaDB 11.4 server (no Docker)**

The service needs nothing from Docker. Any MariaDB 11.4 server reachable over TCP works; skip `npm run db:up`. Two settings differ from the Docker defaults:

- **Port.** Set `DB_PORT=3306` (or whatever your server listens on). The default `3307` is only the port the Compose file publishes.
- **Admin account.** `DB_ADMIN_USER` must be an account that logs in with a password over TCP. On a packaged install, `root` authenticates through the local socket, so `npm run migrate` fails with `Access denied for user 'root'@'localhost'`. Create an admin account for migrate, seed and the tests, and put it in `.env`:

  ```sql
  CREATE USER 'ivs_admin'@'localhost' IDENTIFIED BY '<a strong password>';
  GRANT ALL PRIVILEGES ON *.* TO 'ivs_admin'@'localhost' WITH GRANT OPTION;
  FLUSH PRIVILEGES;
  ```

  It needs to create databases, users and triggers; the test suite also locks and renames tables and reads the process list. The running service never uses this account. It connects as the least-privilege `DB_USER`, which `npm run migrate` creates.

`DB_APP_HOST=%` (the default) worked unchanged on a packaged install with the service on the same host. Set it to `localhost` if you want the runtime account restricted to local connections.

This path was rehearsed on Debian 12 with MariaDB 11.4 from MariaDB's own apt repository; see the notes in `EVIDENCE.md`.

Seed users (the password for all of them is `SEED_USER_PASSWORD`):

| Organisation | Admin | Submitter |
|---|---|---|
| Northwind Synthetic Ltd | admin@northwind.example | clerk@northwind.example |
| Contoso Synthetic GmbH | admin@contoso.example | clerk@contoso.example |

`npm run seed -- --reset` drops and rebuilds the database. The audit trail can't be selectively deleted, so this is the only way to reseed.

---

## Tables

The migrations create **exactly the five specified tables**: `organisations`, `users`, `validation_rules`, `submitted_records` and `audit_log`. Test `[M01]` migrates an empty database and asserts that list.

Two other things exist, and neither is part of the service's data model:

- **`schema_migrations`** is the migration runner's own bookkeeping: which SQL files were applied, with checksums. It makes `npm run migrate` safe to re-run, and it lets readiness report a schema that is behind the code.
- **`ref_suppliers` and `ref_cost_centres`** are synthetic lookup targets. A lookup rule needs reference data to check against, and none of the five tables holds any. They are **fixtures**, created and filled by `npm run seed` from `seeds/reference_tables.sql`, standing in for the external reference sets a real lookup would use. Until the seed has run they don't exist, and a lookup rule returns `unknown`.

---

## The four requirements, and where each is enforced

### 1. A rule that could not be evaluated is not a rule that passed

Every rule execution returns exactly one of `pass`, `fail`, `unknown` or `skipped` (`src/engine/outcome.js`).

- **`unknown`** means the rule could not reach a decision. The causes are:
  - a lookup that was unreachable, or whose target table or column is missing;
  - a rule that timed out (`RULE_TIMEOUT_MS`);
  - a regex that exceeded `REGEX_TIMEOUT_MS`;
  - an executor that threw;
  - a stored rule with invalid configuration or an unsupported type;
  - data the rule needs that is absent.
- **`skipped`** only happens when the rule's own configuration marks the field `"optional": true` and the field is absent.
- `src/engine/index.js` catches every exception or timeout and turns it into `unknown`. No path turns any of them into `pass`.

The record verdict (`src/engine/aggregate.js`) has three states:

| `verdict` | Meaning |
|---|---|
| `clean` | Checked and clean: every applicable rule was evaluated and passed. |
| `failed` | At least one rule failed. |
| `incomplete` | Could not fully check. Nothing failed, but at least one rule returned `unknown`, or no rule reached a decision at all (for example, no active rules). |

`fully_evaluated` is reported separately. A `failed` record still says whether some of its rules couldn't run. A caller tests `verdict === "clean"` (equivalently `fully_evaluated && summary.fail === 0`) without reading the source:

```json
{
  "id": 42, "submission_id": "INV-2026-0042", "version": 1,
  "verdict": "incomplete", "fully_evaluated": false,
  "summary": { "total": 9, "pass": 7, "fail": 0, "unknown": 1, "skipped": 1,
               "notes": ["1 rule(s) could not be evaluated"], "rules_changed_during_evaluation": [] },
  "results": [
    { "rule_id": 8, "rule_name": "Supplier is known", "rule_type": "lookup", "rule_version": 1,
      "field": "supplier_code", "status": "unknown", "code": "lookup_target_missing",
      "detail": "ref_suppliers.code does not exist" }
  ]
}
```

### 2. Organisation scoping holds on every path

- **Scope comes only from the token.** `src/auth.js` verifies the JWT (HS256 only, plus issuer, audience and expiry). It then re-reads the user, requiring `users.id = sub AND org_id = org AND active = 1`, so a deactivated user or a token whose `org` doesn't match the user is rejected.
- **Client-supplied scope is refused.** A request that sends `org_id` (or `orgId` / `organisation_id`) in the query or body gets `400 org_scope_not_accepted`. It isn't silently ignored.
- **Every repository function takes `orgId` and filters on it** (`src/repo/*.js`). There's no unscoped read or write of records, rules or audit events. Lookups add `AND org_id = ?` as well.
- **Another organisation's record returns the same 404 body as a nonexistent id.** That applies to reads and to corrections, so ids can't be probed.
- **Pagination is keyset-based and scoped** (`WHERE org_id = ? AND id > ?`), so a cursor copied from another organisation's id range still only returns your own records. The audit trail and its verification are also per organisation, and each organisation has its own hash chain.

### 3. Rules are data, not code

- `validation_rules` holds `rule_type`, `field` (a name or dotted path), `config` (JSON: every threshold, pattern and lookup target) and `message` (the text returned on failure).
- The engine dispatches on `rule_type`. Adding a rule of an existing type is an `INSERT`, and it applies to the next submission with no code change or restart (test `[R01]`).
- The `.js` files contain no field names, thresholds or messages. Runtime tunables (timeouts, page sizes, bcrypt cost, the lookup allowlist) come from environment variables, and `src/config.js` refuses to start when one is missing or malformed.
- Each rule carries a `version` that is bumped on every change, and every result records the version it ran.

Supported rule types and their `config`:

| `rule_type` | `config` keys | Passes when |
|---|---|---|
| `required` | `allow_blank?` | field present, not null, and (unless `allow_blank`) not an empty or blank string |
| `range` | `min?`, `max?` (at least one), `min_inclusive?`=true, `max_inclusive?`=true, `optional?` | value is a finite JSON number within bounds. Strings are never coerced: `"5000"` fails `not_a_number`. |
| `date` | `min?`, `max?` (YYYY-MM-DD), `optional?` | value is a real calendar date `YYYY-MM-DD` within bounds (`2026-02-30` fails) |
| `regex` | `pattern`, `flags?` (only `i m s u`), `optional?` | string matches. Evaluated in a worker thread with a time limit, so a catastrophic pattern returns `unknown` and can't block the service. |
| `lookup` | `table`, `column`, `optional?` | value exists in `table.column` for the caller's organisation. `table.column` must be in `LOOKUP_ALLOWLIST`, and identifiers are validated and escaped. |
| `cross_field` | `other_field`, `operator` (`eq neq lt lte gt gte`), `compare_as` (`number date string`), `optional?` | `field <operator> other_field` holds |

Rule definitions are validated by the same code in two places. The admin API rejects an invalid rule with `400` and the reasons. The engine returns `unknown` for an invalid row inserted directly into the database.

### 4. A dependency failure surfaces as a failure

- **`GET /api/health` is readiness.** It checks that the database answers within `HEALTH_DB_TIMEOUT_MS`, that every migration shipped with the code has been applied, and that the external audit anchor store is writable. Otherwise it returns **503** and names the failed dependency. A check that couldn't run is reported as `not_checked`, never as `up`. The response contains no host names, credentials or driver error text.
  ```json
  { "status": "unavailable",
    "checks": { "database": { "status": "down", "reason": "unreachable" },
                "schema":   { "status": "not_checked", "reason": "database unavailable" } } }
  ```
- **`GET /api/health/live` is liveness only** (the process is running). It's deliberately separate.
- **When the database is unavailable, every endpoint returns `503 dependency_unavailable`.** It never returns an empty list, a 404 (absence wasn't verified), a 401 (credentials weren't checked) or a cached result.
- **A submission is one transaction.** The record, its results and its audit event commit together or not at all. If the connection is lost mid-transaction, the response is 503 and nothing is persisted (test `[F01]`).

---

## API

All endpoints are under `/api`. Everything except `health`, `health/live` and `auth/login` requires `Authorization: Bearer <token>`. Request bodies must be `application/json` (anything else gets 415) and no larger than `MAX_BODY_BYTES` (413).

| Method & path | Role | Notes |
|---|---|---|
| `POST /auth/login` | none | `{email, password}` → `{token, token_type, expires_in, user}`. A wrong password and an unknown email return the same 401. |
| `POST /records` | any | `{submission_id, payload}`. `201` for a new evaluation, with `replayed: false`. The same `submission_id` with the same payload (key order doesn't matter) returns `200`: a **replay** of the stored result. It isn't evaluated again, it's marked `replayed: true` with a `replay` block (`original_submitted_at`, `result_evaluated_at`, `record_version`, `note`) and the header `Idempotent-Replayed: true`, and nothing new is stored except a `record.replayed` audit event. The same id with a different payload returns `409 submission_id_conflict`. A payload with an unpaired UTF-16 surrogate returns `400 invalid_payload`. Write responses include `audit_anchored` (see Audit trail). |
| `GET /records?after=&limit=&verdict=` | any | Keyset pagination: `{items, next_cursor}`. |
| `GET /records/:id` | any | `404` if the record isn't yours or doesn't exist. |
| `PUT /records/:id` | any | Correction: `{payload, expected_version}`. Re-validates, bumps `version`, audits the previous verdict. `409` on a stale version. |
| `GET /rules?include_inactive=true` · `GET /rules/:id` | any | |
| `POST /rules` | admin | `{name, rule_type, field, config, message, active?}`. |
| `PATCH /rules/:id` | admin | `{expected_version, …changes}`. Deactivate with `{active:false}`. `rule_type` is immutable. |
| `GET /audit?after_seq=&limit=` | admin | Your organisation's events, in chain order. |
| `GET /audit/verify` | admin | `{verdict: intact \| tampered \| incomplete, chain:{…}, anchor:{…}, notes:[…]}`. See Audit trail. |
| `GET /health` · `GET /health/live` | none | See requirement 4 above. |

Errors are always JSON: `{ "error": "<code>", "message": "…", …details }`.

**A rule deactivated mid-run** (decision 2, confirmed). Evaluation uses the rule set as it was when evaluation started. Each result records the rule `version` it ran. Before committing, the service re-reads those rules. Any that changed or were deactivated in the meantime are listed in `summary.rules_changed_during_evaluation` and in the audit event. The next submission uses the new rule set.

---

## Audit trail

`audit_log` is append-only and hash-chained, with one chain per organisation:

- `hash = sha256(prev_hash + "\n" + canonical JSON of the row)`;
- `seq` is contiguous from 1;
- the first row links to 64 zeros;
- the newest row of each chain is **anchored outside the database**.

**What stops or exposes tampering:**

1. **Least privilege.** The runtime account (`DB_USER`) is granted only `SELECT, INSERT` on `audit_log` (`scripts/lib/migrator.js`).
2. **Triggers.** `BEFORE UPDATE` and `BEFORE DELETE` triggers reject changes from *any* account, admin included.
3. **Hash chain.** Detects an edited row, a forged hash (through the next link), and a row missing from the middle (a gap in `seq`). Tests alter every hashed column of a genuine row one at a time (`[T04]`), so a verifier that has stopped catching anything would fail its own tests.
4. **External anchor** (`src/anchor.js`). After each audited transaction commits, the chain's `{seq, head hash}` is written to one small file per organisation under `ANCHOR_DIR`, signed with HMAC-SHA256 using `ANCHOR_KEY`, a key the database never sees. The anchor catches what the chain alone can't: removal of the newest rows (the chain ends before the anchored `seq`) and a rewritten tail (a different hash at the anchored `seq`). An anchor that was edited, copied from another organisation or signed with another key fails its signature.

**Hash what is stored, not what was handed in.**

- The hash is always recomputed from a row's columns as the database returns them.
- Every append reads back the row it just wrote and refuses to commit if that stored row doesn't re-verify (`AuditWriteMismatch`).
- Sessions run in strict `sql_mode`, so an over-long value is an error rather than a silent truncation.
- Values MariaDB can't store as given, such as JSON with an unpaired UTF-16 surrogate, are rejected before writing.

The result is that no committed row can fail verification just because the database stored it differently from how it was passed in (`[T03]`).

**Verification** (`GET /api/audit/verify`, `npm run audit:verify`) returns a three-state verdict, following the same rule as record validation:

| `verdict` | Meaning | CLI exit |
|---|---|---|
| `intact` | The chain verifies, and the anchor covers its head. | 0 |
| `tampered` | An altered, missing or rewritten row, or an altered anchor. | 1 |
| `incomplete` | Nothing wrong was found, but the trail wasn't fully checked: there's no anchor, the anchor is unreadable, or some rows are newer than the anchor. **Never reported as intact.** | 2 |

**If the anchor can't be written:**

- the committed change stands;
- the response carries `audit_anchored: false`;
- readiness reports `audit_anchor: down`;
- verification reports the uncovered rows as `incomplete`;
- the next successful write re-anchors the latest head (`[H05]`).

**Scope of the anchor.** It protects against tampering *through the database*: a DBA or SQL access truncating or rewriting rows. It is written by the same host that runs the service, so it doesn't protect against an attacker who controls both that host and `ANCHOR_KEY`. For production, the anchor would go to storage the service can append to but not overwrite (a separate service or WORM storage). The interface is one class, so that is a swap, not a redesign. `migrate --fresh` and `seed --reset` clear the anchors of the database they drop.

Writers serialise on their organisation's row. Every audited transaction takes that lock before any other write (`withOrgTransaction`), which keeps the chain contiguous under concurrency.

---

## Tests, verifier, evidence

```bash
npm test                   # node:test, the built-in runner (no test framework dependency). Needs the database.
npm run verify             # the verifier. Exit 0 only if every check is PASS.
node scripts/evidence.js   # stands the service up from this checkout and regenerates EVIDENCE.md (recreates DB_NAME)
```

- **The tests run against real MariaDB.** Each test file gets its own database (`${TEST_DB_NAME}_<file>`), so files can't interfere with each other. The test IDs in brackets (`[F01]`…) map to the checks in `scripts/lib/checks.js`.
- **Failure paths are tested for real:**
  - the database becoming unreachable is produced by cutting a TCP proxy between the service and MariaDB;
  - a connection lost mid-transaction is produced by destroying the live connection just before the audit insert;
  - "mid-run" is made deterministic by holding a table lock while the evaluation is provably waiting on it.
- **The verifier** first checks the runtime (Node 20.x, MariaDB 11.4.x, exact dependency versions). It then runs the suite and a smoke test of the real server on the seeded database, and prints one line per check.
  - A check whose test never reported, or was skipped, is **NOT RUN**, never PASS.
  - If the database is unreachable, every dependent check is NOT RUN and the exit code is 1.
- **`EVIDENCE.md`** is generated by `scripts/evidence.js`. It records the exact command, exit code, relevant output and verdict of every step, the versions (`node -v`, `SELECT VERSION()`, OS), and the result of each requirement. Hand-written notes (anything unverified and known limits) come from `scripts/evidence-notes.md` and are labelled as hand-written.

To run one check: `node --test --test-concurrency=1 --test-name-pattern="^\[F10\]" test/*.test.js`

---

## Configuration

Every variable is required. See `.env.example` for defaults and comments. Real environment variables override `.env`.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | MariaDB location and database |
| `DB_USER`, `DB_PASSWORD`, `DB_APP_HOST` | Least-privilege runtime account (created and granted by `npm run migrate`) |
| `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD` | Admin account: migrate, seed and tests only, never the running service |
| `DB_POOL_LIMIT`, `DB_ACQUIRE_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS` | Pool sizing and how quickly an unreachable database is reported |
| `TEST_DB_NAME` | Prefix for the per-file test databases |
| `JWT_SECRET` (at least 32 characters), `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_TTL_SECONDS` | Tokens |
| `BCRYPT_COST` | Password hashing cost |
| `RULE_TIMEOUT_MS`, `REGEX_TIMEOUT_MS` | Per-rule time budgets. Exceeding one gives `unknown`. |
| `LOOKUP_ALLOWLIST` | `table.column` pairs lookup rules may reference |
| `MAX_BODY_BYTES`, `PAGE_SIZE_DEFAULT`, `PAGE_SIZE_MAX` | API limits |
| `HEALTH_DB_TIMEOUT_MS` | Readiness probe budget |
| `ANCHOR_DIR`, `ANCHOR_KEY` (at least 32 characters) | Where the external audit anchor is written, and the HMAC key that signs it. Keep both out of the database's reach. |
| `SEED_USER_PASSWORD` | Password given to the synthetic seed users |

---

## Layout

```
migrations/            001…005 ordered SQL: exactly the five specified tables
seeds/                 synthetic.json (organisations, users, rules, reference rows) and
                       reference_tables.sql (lookup fixture tables, created by the seed)
src/
  config.js            environment → validated config (fails fast)
  db.js                pool / admin connections (UTC sessions, exact DATETIME strings)
  app.js, server.js    Express app factory and entry point
  auth.js              login, JWT verification, role checks
  audit.js             hash chain append (verify-on-write) / verify / list
  anchor.js            external, HMAC-signed chain-head anchor
  health.js            readiness (database + schema)
  engine/              dispatcher, aggregation, one file per rule type, regex worker
  repo/                organisation-scoped SQL
  services/            record submission/correction, rule administration
  routes/, views/      JSON API and server-rendered pages
public/                plain JavaScript + CSS for the pages
scripts/               migrate, seed, verify, evidence, audit-verify, db-version
test/                  node:test suites + helpers (per-file DB, TCP proxy)
```

## Dependencies

`express@4.22.3`, `helmet@8.3.0`, `jsonwebtoken@9.0.3`, `bcrypt@6.0.0`, `mariadb@3.5.4`, all pinned exactly with a committed lockfile. There are no dev dependencies. `dotenv` was approved but isn't used, because Node 20.12+ reads `.env` natively. The external anchor uses only Node built-ins (`fs`, `crypto`).
