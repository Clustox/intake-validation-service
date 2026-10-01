'use strict';

const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Tagged template: interpolated values are escaped unless wrapped in raw().
class Raw { constructor(v) { this.v = v; } }
const raw = v => new Raw(v);
function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const text = v instanceof Raw ? v.v : Array.isArray(v) ? v.map(x => (x instanceof Raw ? x.v : escapeHtml(x))).join('') : escapeHtml(v ?? '');
    return out + text + s;
  }, ''));
}

function layout({ title, page, body, nav = true }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Intake Validation Service</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body data-page="${page}">
  <header class="top">
    <strong>Intake Validation Service</strong>
    ${nav ? html`<nav>
      <a href="/ui/records">Records</a>
      <a href="/ui/rules">Rules</a>
      <a href="/ui/audit">Audit</a>
      <span id="whoami" class="muted"></span>
      <button type="button" id="logout" class="link">Sign out</button>
    </nav>` : ''}
  </header>
  <main>
    <h1>${title}</h1>
    <div id="flash" role="status" aria-live="polite"></div>
    ${body}
  </main>
  <script src="/static/app.js"></script>
</body>
</html>`.v;
}

module.exports = { layout, html, raw, escapeHtml };
