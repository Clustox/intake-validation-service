'use strict';

// Server-rendered pages. The server renders the page structure; data is
// fetched from the JSON API with the bearer token by /static/app.js, so the
// UI goes through exactly the same authentication and scoping as any client.

const express = require('express');
const { layout, html } = require('../views/layout');
const { RULE_TYPES } = require('../engine');

const pages = {
  login: () => layout({
    title: 'Sign in', page: 'login', nav: false, body: html`
    <form id="login-form" class="card narrow">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>`,
  }),

  records: () => layout({
    title: 'Records', page: 'records', body: html`
    <section class="card">
      <h2>Submit a record</h2>
      <form id="submit-form">
        <label>Submission ID <input name="submission_id" required maxlength="100" placeholder="INV-2026-0001"></label>
        <label>Payload (JSON object) <textarea name="payload" rows="8" required>{}</textarea></label>
        <button type="submit">Submit and validate</button>
      </form>
      <div id="submit-result"></div>
    </section>
    <section class="card">
      <h2>Submitted records</h2>
      <label class="inline">Verdict
        <select id="verdict-filter"><option value="">all</option><option>clean</option><option>failed</option><option>incomplete</option></select>
      </label>
      <table><thead><tr><th>ID</th><th>Submission</th><th>Verdict</th><th>Fully evaluated</th><th>Version</th><th>Updated</th></tr></thead>
      <tbody id="records-body"></tbody></table>
      <button type="button" id="more" hidden>Load more</button>
    </section>`,
  }),

  record: id => layout({
    title: `Record ${id}`, page: 'record', body: html`
    <div id="record" data-id="${id}"></div>
    <section class="card">
      <h2>Correct this record</h2>
      <form id="correct-form">
        <label>Payload (JSON object) <textarea name="payload" rows="8" required></textarea></label>
        <input type="hidden" name="expected_version">
        <button type="submit">Save correction and re-validate</button>
      </form>
    </section>`,
  }),

  rules: () => layout({
    title: 'Validation rules', page: 'rules', body: html`
    <section class="card">
      <h2>Rules</h2>
      <table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Field</th><th>Config</th><th>Message</th><th>Version</th><th>Active</th><th></th></tr></thead>
      <tbody id="rules-body"></tbody></table>
    </section>
    <section class="card admin-only">
      <h2>Add a rule</h2>
      <form id="rule-form">
        <label>Name <input name="name" required maxlength="120"></label>
        <label>Type <select name="rule_type">${RULE_TYPES.map(t => html`<option>${t}</option>`)}</select></label>
        <label>Field <input name="field" required placeholder="amount or supplier.code"></label>
        <label>Config (JSON object) <textarea name="config" rows="4">{}</textarea></label>
        <label>Failure message <input name="message" required maxlength="500"></label>
        <button type="submit">Add rule</button>
      </form>
    </section>`,
  }),

  audit: () => layout({
    title: 'Audit trail', page: 'audit', body: html`
    <section class="card">
      <button type="button" id="verify">Verify chain integrity</button>
      <div id="verify-result"></div>
    </section>
    <section class="card">
      <table><thead><tr><th>Seq</th><th>When</th><th>Action</th><th>Entity</th><th>Actor</th><th>Data</th><th>Hash</th></tr></thead>
      <tbody id="audit-body"></tbody></table>
      <button type="button" id="more" hidden>Load more</button>
    </section>`,
  }),
};

function uiRouter() {
  const r = express.Router();
  const send = (res, htmlText) => res.type('html').send(htmlText);
  r.get('/', (req, res) => res.redirect('/ui/records'));
  r.get('/ui/login', (req, res) => send(res, pages.login()));
  r.get('/ui/records', (req, res) => send(res, pages.records()));
  r.get('/ui/records/:id(\\d+)', (req, res) => send(res, pages.record(req.params.id)));
  r.get('/ui/rules', (req, res) => send(res, pages.rules()));
  r.get('/ui/audit', (req, res) => send(res, pages.audit()));
  return r;
}

module.exports = { uiRouter };
