'use strict';

(function () {
  // ---- session -----------------------------------------------------------
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    clear() { try { sessionStorage.clear(); } catch { /* storage unavailable */ } },
  };
  const page = document.body.dataset.page;
  const session = store.get('ivs.session');
  if (page !== 'login' && !session) { location.href = '/ui/login'; return; }

  // ---- helpers -----------------------------------------------------------
  const $ = s => document.querySelector(s);
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
    return e;
  }
  const badge = s => el('span', { class: `badge ${s}` }, s);
  function flash(msg, kind = 'error') { $('#flash').replaceChildren(el('div', { class: kind }, msg)); }

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && page !== 'login') { store.clear(); location.href = '/ui/login'; }
    if (!res.ok) {
      const detail = data.errors ? `: ${data.errors.join('; ')}` : '';
      throw new Error(`${res.status} ${data.error || ''} ${data.message || ''}${detail}`.trim());
    }
    return data;
  }
  function parseJsonField(text, name) {
    try { return JSON.parse(text); } catch { throw new Error(`${name} is not valid JSON`); }
  }
  const VERDICT_TEXT = {
    clean: 'Checked and clean: every applicable rule was evaluated and passed.',
    failed: 'Failed: at least one rule failed.',
    incomplete: 'Could not fully check: nothing failed, but at least one rule could not be evaluated. This record is NOT confirmed clean.',
  };

  if (session) {
    $('#whoami') && ($('#whoami').textContent = `${session.user.email} · ${session.user.organisation.name} · ${session.user.role}`);
    if (session.user.role === 'admin') document.body.classList.add('is-admin');
    $('#logout') && $('#logout').addEventListener('click', () => { store.clear(); location.href = '/ui/login'; });
  }

  function resultsTable(results) {
    return el('table', null,
      el('thead', null, el('tr', null, ['Rule', 'Type', 'Field', 'Version', 'Result', 'Code', 'Message / detail'].map(h => el('th', null, h)))),
      el('tbody', null, results.map(r => el('tr', null,
        el('td', null, `${r.rule_name} (#${r.rule_id})`), el('td', null, r.rule_type), el('td', null, el('code', null, r.field)),
        el('td', null, r.rule_version), el('td', null, badge(r.status)), el('td', null, r.code || ''),
        el('td', null, [r.message, r.detail].filter(Boolean).join(' — '))))));
  }
  function recordView(rec) {
    return el('div', null,
      el('div', { class: `banner ${rec.verdict}` }, badge(rec.verdict), ' ', VERDICT_TEXT[rec.verdict],
        el('div', { class: 'muted' }, `fully_evaluated: ${rec.fully_evaluated} · pass ${rec.summary.pass} · fail ${rec.summary.fail} · unknown ${rec.summary.unknown} · skipped ${rec.summary.skipped}`),
        rec.summary.notes.length ? el('ul', null, rec.summary.notes.map(n => el('li', null, n))) : null,
        rec.replayed ? el('div', null, el('strong', null, 'Replay: '), `${rec.replay.note} Evaluated ${new Date(rec.replay.result_evaluated_at).toLocaleString()}.`) : null,
        rec.audit_anchored === false ? el('div', null, 'Warning: the audit anchor could not be updated for this change.') : null),
      resultsTable(rec.results));
  }

  // ---- pages -------------------------------------------------------------
  const pages = {
    login() {
      $('#login-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          const data = await api('POST', '/auth/login', { email: f.get('email'), password: f.get('password') });
          store.set('ivs.session', data);
          location.href = '/ui/records';
        } catch (err) { flash(err.message); }
      });
    },

    records() {
      let cursor = 0;
      const load = async (reset) => {
        if (reset) { cursor = 0; $('#records-body').replaceChildren(); }
        const v = $('#verdict-filter').value;
        const data = await api('GET', `/records?after=${cursor}${v ? `&verdict=${v}` : ''}`);
        for (const r of data.items) {
          $('#records-body').append(el('tr', null,
            el('td', null, el('a', { href: `/ui/records/${r.id}` }, r.id)), el('td', null, r.submission_id),
            el('td', null, badge(r.verdict)), el('td', null, String(r.fully_evaluated)), el('td', null, r.version),
            el('td', null, new Date(r.updated_at).toLocaleString())));
        }
        cursor = data.next_cursor;
        $('#more').hidden = cursor === null;
      };
      $('#more').addEventListener('click', () => load(false).catch(err => flash(err.message)));
      $('#verdict-filter').addEventListener('change', () => load(true).catch(err => flash(err.message)));
      $('#submit-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          const rec = await api('POST', '/records', { submission_id: f.get('submission_id'), payload: parseJsonField(f.get('payload'), 'Payload') });
          $('#submit-result').replaceChildren(el('p', null, el('a', { href: `/ui/records/${rec.id}` }, `Record ${rec.id}`)), recordView(rec));
          await load(true);
        } catch (err) { flash(err.message); }
      });
      load(true).catch(err => flash(err.message));
    },

    record() {
      const id = $('#record').dataset.id;
      const show = rec => {
        $('#record').replaceChildren(
          el('section', { class: 'card' }, el('p', { class: 'muted' }, `Submission ${rec.submission_id} · version ${rec.version} · updated ${new Date(rec.updated_at).toLocaleString()}`), recordView(rec)),
          el('section', { class: 'card' }, el('h2', null, 'Payload'), el('pre', null, JSON.stringify(rec.payload, null, 2))));
        const f = $('#correct-form');
        f.payload.value = JSON.stringify(rec.payload, null, 2);
        f.expected_version.value = rec.version;
      };
      $('#correct-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        try {
          show(await api('PUT', `/records/${id}`, { payload: parseJsonField(f.payload.value, 'Payload'), expected_version: Number(f.expected_version.value) }));
          flash('Correction saved and re-validated.', 'ok');
        } catch (err) { flash(err.message); }
      });
      api('GET', `/records/${id}`).then(show).catch(err => flash(err.message));
    },

    rules() {
      const isAdmin = session.user.role === 'admin';
      const load = async () => {
        const data = await api('GET', '/rules?include_inactive=true&limit=100');
        $('#rules-body').replaceChildren(...data.items.map(r => el('tr', null,
          el('td', null, r.id), el('td', null, r.name), el('td', null, r.rule_type), el('td', null, el('code', null, r.field)),
          el('td', null, el('pre', null, JSON.stringify(r.config))), el('td', null, r.message), el('td', null, r.version),
          el('td', null, r.active ? 'yes' : 'no'),
          el('td', null, isAdmin ? el('button', { type: 'button', class: 'secondary', onclick: () => toggle(r) }, r.active ? 'Deactivate' : 'Activate') : ''))));
      };
      const toggle = async r => {
        try { await api('PATCH', `/rules/${r.id}`, { expected_version: r.version, active: !r.active }); await load(); } catch (err) { flash(err.message); }
      };
      $('#rule-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await api('POST', '/rules', { name: f.get('name'), rule_type: f.get('rule_type'), field: f.get('field'), config: parseJsonField(f.get('config'), 'Config'), message: f.get('message') });
          e.target.reset();
          flash('Rule added. It applies to the next submission.', 'ok');
          await load();
        } catch (err) { flash(err.message); }
      });
      load().catch(err => flash(err.message));
    },

    audit() {
      let cursor = 0;
      const load = async () => {
        const data = await api('GET', `/audit?after_seq=${cursor}`);
        for (const a of data.items) {
          $('#audit-body').append(el('tr', null, el('td', null, a.seq), el('td', null, new Date(a.created_at).toLocaleString()),
            el('td', null, a.action), el('td', null, `${a.entity_type} ${a.entity_id ?? ''}`), el('td', null, a.actor_user_id ?? ''),
            el('td', null, el('pre', null, JSON.stringify(a.data))), el('td', { class: 'hash' }, a.hash.slice(0, 16))));
        }
        cursor = data.next_cursor;
        $('#more').hidden = cursor === null;
      };
      $('#more').addEventListener('click', () => load().catch(err => flash(err.message)));
      $('#verify').addEventListener('click', async () => {
        try {
          const v = await api('GET', '/audit/verify');
          const cls = { intact: 'pass', tampered: 'fail', incomplete: 'unknown' }[v.verdict];
          const text = {
            intact: `Intact: ${v.chain.rows_checked} rows verified, and the external anchor covers the head (seq ${v.anchor.anchored_seq}).`,
            tampered: 'TAMPERED: the audit trail has been altered.',
            incomplete: 'Not fully verified: no tampering found, but the trail could not be checked completely.',
          }[v.verdict];
          $('#verify-result').replaceChildren(el('div', { class: `banner ${v.verdict === 'intact' ? 'clean' : v.verdict === 'tampered' ? 'failed' : 'incomplete'}` },
            el('span', { class: `badge ${cls}` }, v.verdict), ` ${text}`,
            v.chain.head ? el('div', { class: 'muted' }, 'Head hash ', el('code', null, v.chain.head.hash)) : null,
            v.notes.length ? el('ul', null, v.notes.map(n => el('li', null, n))) : null));
        } catch (err) { flash(err.message); }
      });
      if (session.user.role !== 'admin') { flash('The audit trail is available to administrators only.'); return; }
      load().catch(err => flash(err.message));
    },
  };

  pages[page] && pages[page]();
})();
