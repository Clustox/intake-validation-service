'use strict';

const records = require('../repo/records');
const rules = require('../repo/rules');
const audit = require('../audit');
const { evaluate } = require('../engine');
const { withOrgTransaction } = require('../lib/tx');
const { canonicalJson, sha256, isoTimestamp } = require('../lib/canonical');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { requireObject, isPlainObject, isWellFormedJson, positiveInt } = require('../lib/input');
const { parseJson } = require('../db');

const SUBMISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ER_DUP_ENTRY = 1062;

function engineCtx(deps, orgId) {
  return { db: deps.pool, orgId, ...deps.config.engine };
}

// Evaluates against the active rules as they were when evaluation started,
// then reports any of those rules that changed or were deactivated while it ran.
async function evaluateSnapshot(deps, orgId, payload) {
  const snapshot = await rules.activeSnapshot(deps.pool, orgId);
  const evaluation = await evaluate(payload, snapshot, engineCtx(deps, orgId));
  return { snapshot, evaluation };
}

async function changedDuringRun(conn, orgId, snapshot) {
  const now = await rules.currentVersions(conn, orgId, snapshot.map(r => r.id));
  return snapshot
    .filter(r => !now.has(r.id) || !now.get(r.id).active || now.get(r.id).version !== r.version)
    .map(r => r.id);
}

function withChangeNote(evaluation, changedIds) {
  const summary = { ...evaluation.summary, notes: [...evaluation.summary.notes] };
  if (changedIds.length) {
    summary.notes.push(`rule(s) ${changedIds.join(', ')} changed or were deactivated during evaluation; results reflect the versions listed`);
  }
  return { ...evaluation, summary: { ...summary, rules_changed_during_evaluation: changedIds } };
}

function auditData(rec, evaluation) {
  return {
    submission_id: rec.submission_id,
    payload_hash: rec.payload_hash,
    verdict: evaluation.verdict,
    fully_evaluated: evaluation.fully_evaluated,
    counts: { pass: evaluation.summary.pass, fail: evaluation.summary.fail, unknown: evaluation.summary.unknown, skipped: evaluation.summary.skipped },
    rules_applied: evaluation.results.map(r => ({ id: r.rule_id, version: r.rule_version, status: r.status })),
    rules_changed_during_evaluation: evaluation.summary.rules_changed_during_evaluation,
  };
}

function present(row, extra = {}) {
  return {
    id: row.id,
    submission_id: row.submission_id,
    version: row.version,
    verdict: row.verdict,
    fully_evaluated: row.fully_evaluated === 1 || row.fully_evaluated === true,
    summary: parseJson(row.summary),
    results: parseJson(row.results),
    payload: parseJson(row.payload),
    submitted_by: row.submitted_by,
    updated_by: row.updated_by,
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at),
    // Every write re-evaluates, so the last write is when this verdict was produced.
    evaluated_at: isoTimestamp(row.updated_at),
    ...extra,
  };
}

function parseSubmission(body) {
  requireObject(body, ['submission_id', 'payload']);
  const missing = ['submission_id', 'payload'].filter(k => body[k] === undefined);
  if (missing.length) throw badRequest('missing_fields', `missing required field(s): ${missing.join(', ')}`, { fields: missing });
  if (typeof body.submission_id !== 'string' || !SUBMISSION_ID.test(body.submission_id)) {
    throw badRequest('invalid_submission_id', 'submission_id must be 1-100 characters: letters, digits, . _ : -');
  }
  if (!isPlainObject(body.payload)) throw badRequest('invalid_payload', 'payload must be a JSON object');
  if (!isWellFormedJson(body.payload)) throw badRequest('invalid_payload', 'payload contains invalid Unicode (an unpaired surrogate)');
  return { submission_id: body.submission_id, payload: body.payload, payload_hash: sha256(canonicalJson(body.payload)) };
}

async function handleDuplicate(deps, auth, rec, existing) {
  if (existing.payload_hash !== rec.payload_hash) {
    throw conflict('submission_id_conflict',
      'submission_id was already used for a different payload', { existing_record_id: existing.id });
  }
  const meta = {};
  await withOrgTransaction(deps, auth.orgId, conn => audit.append(conn, {
    orgId: auth.orgId, actorUserId: auth.userId, action: 'record.replayed',
    entityType: 'record', entityId: existing.id,
    data: { submission_id: rec.submission_id, payload_hash: rec.payload_hash, replayed_version: existing.version, replayed_verdict: existing.verdict },
  }), meta);
  // A replay must never pass for a fresh evaluation: it is flagged in the body
  // and in a header, and says when the result it carries was produced.
  return {
    status: 200,
    headers: { 'Idempotent-Replayed': 'true' },
    body: present(existing, {
      replayed: true,
      replay: {
        original_submitted_at: isoTimestamp(existing.created_at),
        result_evaluated_at: isoTimestamp(existing.updated_at),
        record_version: existing.version,
        note: 'This submission_id was already received. This is the stored result of that earlier evaluation; the payload was not evaluated again.',
      },
      audit_anchored: meta.anchored,
    }),
  };
}

async function submit(deps, auth, body) {
  const rec = parseSubmission(body);
  const prior = await records.findBySubmissionId(deps.pool, auth.orgId, rec.submission_id);
  if (prior) return handleDuplicate(deps, auth, rec, prior);

  const { snapshot, evaluation: raw } = await evaluateSnapshot(deps, auth.orgId, rec.payload);
  const meta = {};
  try {
    const id = await withOrgTransaction(deps, auth.orgId, async conn => {
      const evaluation = withChangeNote(raw, await changedDuringRun(conn, auth.orgId, snapshot));
      const newId = await records.insert(conn, auth.orgId, auth.userId, { ...rec, ...evaluation });
      await audit.append(conn, {
        orgId: auth.orgId, actorUserId: auth.userId, action: 'record.submitted',
        entityType: 'record', entityId: newId, data: auditData(rec, evaluation),
      });
      return newId;
    }, meta);
    return { status: 201, body: present(await records.findById(deps.pool, auth.orgId, id), { replayed: false, audit_anchored: meta.anchored }) };
  } catch (err) {
    // A concurrent request with the same submission_id won the insert race.
    if (err.errno === ER_DUP_ENTRY && /uq_records_org_submission/.test(err.message)) {
      const existing = await records.findBySubmissionId(deps.pool, auth.orgId, rec.submission_id);
      if (existing) return handleDuplicate(deps, auth, rec, existing);
    }
    throw err;
  }
}

async function correct(deps, auth, id, body) {
  requireObject(body, ['payload', 'expected_version']);
  if (body.expected_version === undefined || body.payload === undefined) {
    throw badRequest('missing_fields', 'payload and expected_version are required');
  }
  const expectedVersion = positiveInt(body.expected_version, 'expected_version');
  if (!isPlainObject(body.payload)) throw badRequest('invalid_payload', 'payload must be a JSON object');
  if (!isWellFormedJson(body.payload)) throw badRequest('invalid_payload', 'payload contains invalid Unicode (an unpaired surrogate)');

  const current = await records.findById(deps.pool, auth.orgId, id);
  if (!current) throw notFound();
  if (current.version !== expectedVersion) {
    throw conflict('version_conflict', `record is at version ${current.version}`, { current_version: current.version });
  }
  const rec = { payload: body.payload, payload_hash: sha256(canonicalJson(body.payload)) };
  const { snapshot, evaluation: raw } = await evaluateSnapshot(deps, auth.orgId, rec.payload);

  const meta = {};
  await withOrgTransaction(deps, auth.orgId, async conn => {
    const evaluation = withChangeNote(raw, await changedDuringRun(conn, auth.orgId, snapshot));
    const ok = await records.update(conn, auth.orgId, id, expectedVersion, auth.userId, { ...rec, ...evaluation });
    if (!ok) throw conflict('version_conflict', 'record was modified concurrently');
    await audit.append(conn, {
      orgId: auth.orgId, actorUserId: auth.userId, action: 'record.corrected', entityType: 'record', entityId: id,
      data: {
        ...auditData({ ...rec, submission_id: current.submission_id }, evaluation),
        previous: { version: current.version, verdict: current.verdict, payload_hash: current.payload_hash },
        version: current.version + 1,
      },
    });
  }, meta);
  return { status: 200, body: present(await records.findById(deps.pool, auth.orgId, id), { replayed: false, audit_anchored: meta.anchored }) };
}

async function get(deps, auth, id) {
  const row = await records.findById(deps.pool, auth.orgId, id);
  if (!row) throw notFound();
  return present(row);
}

async function list(deps, auth, { afterId, limit, verdict }) {
  const rows = await records.list(deps.pool, auth.orgId, { afterId, limit, verdict });
  return rows.map(r => ({
    id: r.id, submission_id: r.submission_id, verdict: r.verdict, fully_evaluated: r.fully_evaluated === 1,
    version: r.version, created_at: isoTimestamp(r.created_at), updated_at: isoTimestamp(r.updated_at),
  }));
}

module.exports = { submit, correct, get, list };
