'use strict';

const express = require('express');
const records = require('../services/records');
const rules = require('../services/rules');
const audit = require('../audit');
const { login, requireAuth, requireRole } = require('../auth');
const { readiness } = require('../health');
const { badRequest, notFound } = require('../lib/errors');
const { routeId, pagination, page } = require('../lib/input');

const VERDICTS = ['clean', 'failed', 'incomplete'];
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// Scope is derived from the token. A client that tries to name an organisation
// is told so explicitly rather than having the parameter silently ignored.
function rejectClientScope(req, res, next) {
  const inQuery = ['org_id', 'orgId', 'organisation_id'].filter(k => k in req.query);
  const inBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? ['org_id', 'orgId', 'organisation_id'].filter(k => k in req.body) : [];
  if (inQuery.length || inBody.length) {
    return next(badRequest('org_scope_not_accepted', 'organisation scope is taken from your token and cannot be supplied'));
  }
  next();
}

function idParam(req) {
  const id = routeId(req.params.id);
  if (id === null) throw notFound();
  return id;
}

function apiRouter(deps) {
  const r = express.Router();

  r.get('/health/live', (req, res) => res.json({ status: 'alive' }));
  r.get('/health', wrap(async (req, res) => {
    const { httpStatus, body } = await readiness(deps);
    res.status(httpStatus).json(body);
  }));

  r.post('/auth/login', wrap(async (req, res) => res.json(await login(deps, req.body))));

  const authed = express.Router();
  authed.use(requireAuth(deps), rejectClientScope);

  authed.post('/records', wrap(async (req, res) => {
    const { status, body, headers } = await records.submit(deps, req.auth, req.body);
    if (headers) res.set(headers);
    res.status(status).json(body);
  }));
  authed.get('/records', wrap(async (req, res) => {
    const { verdict } = req.query;
    if (verdict !== undefined && !VERDICTS.includes(verdict)) throw badRequest('invalid_parameter', `verdict must be one of ${VERDICTS.join(', ')}`);
    const p = pagination(req.query, deps.config.api);
    res.json(page(await records.list(deps, req.auth, { ...p, verdict }), p.limit, x => x.id));
  }));
  authed.get('/records/:id', wrap(async (req, res) => res.json(await records.get(deps, req.auth, idParam(req)))));
  authed.put('/records/:id', wrap(async (req, res) => {
    const { status, body } = await records.correct(deps, req.auth, idParam(req), req.body);
    res.status(status).json(body);
  }));

  authed.get('/rules', wrap(async (req, res) => {
    const p = pagination(req.query, deps.config.api);
    const includeInactive = req.query.include_inactive === 'true';
    res.json(page(await rules.list(deps, req.auth, { ...p, includeInactive }), p.limit, x => x.id));
  }));
  authed.get('/rules/:id', wrap(async (req, res) => res.json(await rules.get(deps, req.auth, idParam(req)))));
  authed.post('/rules', requireRole('admin'), wrap(async (req, res) => res.status(201).json(await rules.create(deps, req.auth, req.body))));
  authed.patch('/rules/:id', requireRole('admin'), wrap(async (req, res) => res.json(await rules.update(deps, req.auth, idParam(req), req.body))));

  authed.get('/audit', requireRole('admin'), wrap(async (req, res) => {
    const q = { ...req.query, after: req.query.after_seq ?? req.query.after };
    delete q.after_seq;
    const p = pagination(q, deps.config.api);
    res.json(page(await audit.listEvents(deps.pool, req.auth.orgId, p), p.limit, x => x.seq));
  }));
  authed.get('/audit/verify', requireRole('admin'), wrap(async (req, res) => {
    res.json(await audit.verifyChain(deps.pool, req.auth.orgId, { anchorStore: deps.anchor }));
  }));

  r.use(authed);
  return r;
}

module.exports = { apiRouter };
