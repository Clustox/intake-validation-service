## Notes (hand-written, not generated)

### Runtime caveat on this evidence

The evidence above was produced with Node.js running on the host OS shown in the runtime table, and MariaDB 11.4 running in the official `mariadb:11.4` Docker image (a Linux container). The Node.js major version and the database version match the acceptance runtime. The host OS may not match yours. The run that counts is yours on a clean host. Nothing here stands in for it.

### Linux rehearsal with a system-installed MariaDB (run by hand, not part of the generated evidence above)

To check the path a server install takes, the source was stood up once in a clean `node:20-bookworm` container, with MariaDB installed from MariaDB's own apt repository instead of the Docker image. That run was on source fingerprint `eeb2524fe734da341f27688d5db8f86fdf1e2fce`. The only changes since then are documentation that came out of the rehearsal: the README section on using an existing MariaDB server, two comments in `.env.example`, and these notes. No code, migration, seed or test file has changed, and the rehearsal has not been repeated on the current fingerprint.

| Item | Value |
|---|---|
| OS | Debian GNU/Linux 12 (bookworm), aarch64 |
| Node.js | v20.20.2 |
| Database | `11.4.13-MariaDB-deb12`, port 3306, `skip_name_resolve=OFF` |
| Steps | `git clone` of `main`, `cp .env.example .env` (port and secrets set), `npm ci`, `npm run migrate`, `npm run seed`, `npm run verify`, `node scripts/evidence.js` |
| `npm run verify` | exit 0: `49 passed, 0 failed, 0 not run` |
| `node scripts/evidence.js` | exit 0: `12/12 commands behaved as expected`, VERIFIED |

Two things came out of it, and both are now in the README:

- With `DB_ADMIN_USER=root`, `npm run migrate` exited 1 with `Access denied for user 'root'@'localhost'` (error 1698). On a packaged install root authenticates through the local socket. A separate admin account with a password is needed.
- `DB_APP_HOST=%` (the default) worked unchanged with the service on the same host.

Not covered by this rehearsal: x86-64 (the container was ARM64), and distributions other than Debian 12.

### Observed during development, not re-run by scripts/evidence.js

These were run by hand. They are recorded with the exact command and outcome, and they are **not** part of the generated evidence above.

| What | Command | Exit | Outcome |
|---|---|---|---|
| Verifier on the wrong Node.js major | `~/.nvm/versions/node/v22.23.2/bin/node scripts/verify.js` | 1 | `FAIL [ENV-NODE] running v22.23.2; the acceptance runtime is Node.js 20.x`. Every other check still reported its own result, and the overall verdict was `NOT VERIFIED`. |
| Verifier with the database container stopped | `docker compose stop mariadb && node scripts/verify.js` | 1 | `FAIL [ENV-DB] … ECONNREFUSED`, `NOT RUN` for every database-dependent check, `2 passed, 1 failed, 38 not run` (41 checks existed at the time), `NOT VERIFIED`. (The generated step "Verifier with the database unreachable…" above reproduces this without stopping Docker.) |
| The column-tampering test can fail | replaced the stored-hash comparison in `walkChain` (`src/audit.js`) with `false`, i.e. a verifier that no longer checks row content, and ran `node --test --test-name-pattern="T04" test/audit.test.js` | 1 | `[T04]` failed with `altering actor_user_id must be detected`. The code was restored and the test passes. A verifier that has quietly stopped catching tampering cannot pass this suite. |
| Audit-append regression test is meaningful | temporarily removed `FOR UPDATE` from the chain-head read in `src/audit.js` and ran `node --test test/audit.test.js` | 1 | The test "an append from a transaction holding an old snapshot…" failed with `Duplicate entry '1-30' for key 'uq_audit_org_seq'`. The fix was restored and the test passes. |
| Server-rendered UI | `node src/server.js`, then opened `/ui/records`, `/ui/records/:id`, `/ui/rules` and `/ui/audit` in a browser as the seeded Northwind admin | n/a | Pages rendered live data. The record-detail banner for an `incomplete` record reads "This record is NOT confirmed clean". "Verify chain integrity" reported `intact` with "the external anchor covers the head" and the head hash (re-checked after the anchor was added). No console errors. The submit and correct *forms* were not driven through the browser; the API they call is covered by the tests. |

### Defects found and fixed while building

1. **Deadlock under concurrent submissions.** Inserting a record takes a shared lock on the organisation row through its foreign key. The audit append then asked for an exclusive lock on the same row, so concurrent writers deadlocked. They failed correctly, with 503s and not false successes, but they failed. Fix: every audited transaction takes the organisation lock *first* (`withOrgTransaction` in `src/lib/tx.js`). Covered by `[F12] concurrent writers keep one contiguous, valid chain` and `[F09] concurrent duplicate submissions`.
2. **Stale chain head under REPEATABLE READ.** A transaction that had already made a consistent read could see an out-of-date chain head, collide on `(org_id, seq)`, and the error was then mistaken for a duplicate submission (HTTP 500). Fix: the head is read with a locking read, and duplicate-key handling only applies to the submission-id index. Covered by `[F12] an append from a transaction holding an old snapshot…`.

3. **Unpaired UTF-16 surrogates returned 500.** JSON text can carry `"\ud800"`, which isn't valid Unicode. MariaDB's JSON columns reject it, so a payload containing one failed at the database with an internal error instead of a clean 400. We found this while writing the hash-what-you-store tests Glenn asked for. Fix: payloads, rule definitions and audit events are checked for well-formed Unicode before anything is written. `[F03] a payload with invalid Unicode…` returned 500 with the check removed and returns 400 with it (run by hand, as for defect 2).

### Not verified / known limits

- **Your clean host.** Unverified until you run it. The closest we came is the Linux rehearsal above, on ARM64 Debian 12.
- **The external anchor sits on the service's own host.** It detects truncation and tail rewrites made through the database (`[T01]`, `[T02]`). It does not protect against an attacker who controls both the application host and `ANCHOR_KEY`. Production would need append-only storage that the service can't overwrite. Also, a verification that runs in the moment between a commit and its anchor write reports `incomplete` (rows newer than the anchor). That's conservative, and it's never reported as intact.
- **Performance and load** were not measured. Each regex rule evaluation starts a worker thread (a few ms). That is a deliberate trade for isolating event-loop-blocking patterns, and it would be pooled before production use.
- **Login timing uniformity** is designed in (bcrypt compare against a dummy hash for unknown emails) but not measured. Only the identical response body is tested.
- **Rate limiting / brute-force protection** is not implemented, because no dependency was approved for it.
- **Browser UI** is not covered by automated tests. See the manual observation above.
