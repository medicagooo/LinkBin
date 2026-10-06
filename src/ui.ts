/**
 * The web UI, served from the same Worker as the API.
 *
 * Deliberately a single self-contained document with no build step and no external requests: the
 * whole point of hosting it here is that there is no second deployment target and no CORS surface.
 *
 * Scope is capped on purpose (see .scratch/vps-file-hub/STATE.md, D16): configure hosts and their
 * directories, test a connection, read receipts and errors. There is no user system, no roles, and
 * no audit log, and the code should not grow them without a real requirement.
 *
 * Security posture of this page: it never receives a credential. The API returns a short fingerprint
 * instead, which is enough to show "a password is stored" without being reversible.
 */

const STYLES = `
:root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#272c36; --fg:#e6e8ec; --muted:#98a0ad; --accent:#6ea8fe; --ok:#4ec9a0; --err:#f2766d; --warn:#e2b34a; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--fg); }
header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
h1 { font-size:17px; margin:0; letter-spacing:.2px; }
h2 { font-size:14px; margin:0 0 10px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.6px; }
main { padding:24px; display:grid; gap:20px; max-width:1180px; }
section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; }
label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
input,select,textarea,button { font:inherit; color:var(--fg); background:#0d0f13; border:1px solid var(--line); border-radius:7px; padding:8px 10px; width:100%; }
textarea { min-height:64px; font-family:ui-monospace,Consolas,monospace; font-size:12px; }
button { background:#20242d; cursor:pointer; width:auto; padding:8px 14px; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); color:#0b0d11; border-color:var(--accent); font-weight:600; }
button.danger:hover { border-color:var(--err); color:var(--err); }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; }
.row > div { flex:1 1 170px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
@media (max-width:720px){ .grid2{grid-template-columns:1fr;} }
.muted { color:var(--muted); }
.tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); color:var(--muted); }
.tag.ok { color:var(--ok); border-color:color-mix(in srgb,var(--ok) 40%,transparent); }
.tag.err { color:var(--err); border-color:color-mix(in srgb,var(--err) 40%,transparent); }
.tag.warn { color:var(--warn); border-color:color-mix(in srgb,var(--warn) 40%,transparent); }
table { width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; }
pre { background:#0b0d11; border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; max-height:340px; font-size:12px; margin:12px 0 0; }
.hidden { display:none !important; }
.hint { font-size:12px; color:var(--muted); margin-top:6px; }
code { background:#0b0d11; border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:12px; }
.banner { border-radius:8px; padding:12px 14px; margin-bottom:14px; border:1px solid; font-size:13px; }
.banner.warn { border-color:color-mix(in srgb,var(--warn) 45%,transparent); background:color-mix(in srgb,var(--warn) 10%,transparent); }
.banner.err { border-color:color-mix(in srgb,var(--err) 45%,transparent); background:color-mix(in srgb,var(--err) 10%,transparent); }
`;

export function renderIndexPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LinkBin</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1>LinkBin</h1>
  <span class="muted" id="status">checking…</span>
</header>

<main>
  <div id="setup"></div>

  <section>
    <h2>Add or update a host</h2>
    <div class="row">
      <div><label for="label">Label</label><input id="label" placeholder="web-1"></div>
      <div><label for="address">Address</label><input id="address" placeholder="host or IP"></div>
      <div style="flex:0 1 110px"><label for="port">Port</label><input id="port" value="22"></div>
      <div><label for="username">Username</label><input id="username" placeholder="root"></div>
    </div>
    <div class="grid2">
      <div>
        <label for="password">Password — leave blank to keep the stored one</label>
        <input id="password" type="password" autocomplete="new-password">
      </div>
      <div>
        <label for="privateKey">Private key (PEM) — optional, leave blank to keep</label>
        <textarea id="privateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
        <label for="privateKeyPassphrase">Key passphrase — optional</label>
        <input id="privateKeyPassphrase" type="password" autocomplete="new-password">
      </div>
    </div>
    <div class="row" style="margin-top:14px">
      <div style="flex:0 0 auto"><button class="primary" id="saveHost">Save host</button></div>
      <div style="flex:0 0 auto"><button id="reloadHosts">Reload</button></div>
    </div>
    <p class="hint">Credentials are encrypted in the Worker with <code>SSH_MASTER_KEY</code> before they reach D1, and are never returned to this page. Editing a host without retyping its password keeps the stored one.</p>
  </section>

  <section>
    <h2>Hosts</h2>
    <div id="hosts"></div>
  </section>

  <section>
    <h2>Directories to collect</h2>
    <div class="row">
      <div>
        <label for="ruleScope">Applies to</label>
        <select id="ruleScope"><option value="">All hosts (global)</option></select>
      </div>
      <div style="flex:2 1 320px"><label for="rulePattern">Pattern — absolute path, <code>*</code> and <code>?</code> allowed in the file name</label><input id="rulePattern" placeholder="/var/log/*.log"></div>
      <div style="flex:0 1 130px">
        <label for="ruleExclude">Kind</label>
        <select id="ruleExclude"><option value="include">Include</option><option value="exclude">Exclude</option></select>
      </div>
      <div style="flex:0 0 auto"><button class="primary" id="saveRule">Add rule</button></div>
    </div>
    <p class="hint">A global rule applies to every host; a host rule applies to just that host. Exclusions are evaluated first, so "collect <code>/var/log/*.log</code>" globally plus "exclude <code>/var/log/noisy.log</code>" on one host behaves as you would expect.</p>
    <div id="rules"></div>
  </section>

  <section>
    <h2>Result</h2>
    <div id="result"><p class="muted">Nothing yet. Test a host to see its identity, disk, and how each rule resolves against the real filesystem.</p></div>
  </section>
</main>

<script>
'use strict';
const $ = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options));
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
}

function show(title, payload) {
  $('result').innerHTML = '<h3 style="margin:0 0 4px;font-size:14px">' + title + '</h3><pre></pre>';
  $('result').querySelector('pre').textContent = JSON.stringify(payload, null, 2);
}

function tag(text, kind) { return '<span class="tag ' + (kind || '') + '">' + text + '</span>'; }

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadStatus() {
  const { body } = await api('/api/status');
  const bits = [];
  bits.push(body.masterKeySet ? tag('master key set', 'ok') : tag('master key MISSING', 'err'));
  bits.push(body.r2Bound ? tag('R2 bound', 'ok') : tag('R2 not bound', 'err'));
  bits.push(body.schema && body.schema.ready ? tag('schema ready', 'ok') : tag('schema missing', 'warn'));
  $('status').innerHTML = bits.join(' ');

  const needsSetup = !body.masterKeySet || !(body.schema && body.schema.ready);
  if (!needsSetup) { $('setup').innerHTML = ''; return; }

  const parts = [];
  if (!body.masterKeySet) {
    parts.push('<b>1. Set the master key.</b> Generate one below, then add it as a <b>Secret</b> named <code>SSH_MASTER_KEY</code> in this Worker\\'s Settings &rarr; Variables and Secrets. A key that is set but malformed is also caught here.'
      + '<div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button id="genKey">Generate a key</button></div></div><div id="keyOut"></div>');
  }
  if (!(body.schema && body.schema.ready)) {
    const missing = body.schema && body.schema.missing ? body.schema.missing.join(', ') : 'unknown';
    parts.push('<b>' + (body.masterKeySet ? '1' : '2') + '. Create the tables.</b> Missing: <code>' + escapeHtml(missing) + '</code>.'
      + '<div class="row" style="margin-top:10px"><div style="flex:0 0 auto"><button class="primary" id="applySchema">Apply schema</button></div></div>');
  }
  $('setup').innerHTML = '<section><h2>Setup</h2><div class="banner warn">This deployment is not ready yet.</div>' + parts.join('<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">') + '</section>';

  const genKey = $('genKey');
  if (genKey) genKey.onclick = async () => {
    const { body } = await api('/api/master-key');
    $('keyOut').innerHTML = '<label>Master key — copy it into the secret now, it is not stored anywhere</label><input readonly value="' + escapeHtml(body.generated) + '">'
      + '<p class="hint">Current status: <b>' + escapeHtml(body.currentKeyStatus) + '</b>. ' + escapeHtml(body.warning) + '</p>';
  };
  const applySchema = $('applySchema');
  if (applySchema) applySchema.onclick = async () => {
    applySchema.disabled = true;
    const { body } = await api('/api/admin/apply-schema', { method: 'POST' });
    show('Apply schema', body);
    applySchema.disabled = false;
    loadStatus();
  };
}

async function loadHosts() {
  const { body } = await api('/api/hosts');
  const hosts = body.hosts || [];
  if (!hosts.length) {
    $('hosts').innerHTML = '<p class="muted">No hosts yet. Add one above.</p>';
  } else {
    let html = '<table><thead><tr><th>Id</th><th>Label</th><th>Target</th><th>Credential</th><th>State</th><th></th></tr></thead><tbody>';
    for (const h of hosts) {
      const cred = [];
      if (h.hasPassword) cred.push('password ' + tag(h.passwordFingerprint, 'ok'));
      if (h.hasPrivateKey) cred.push('key ' + tag(h.privateKeyFingerprint, 'ok'));
      if (h.hasPrivateKeyPassphrase) cred.push('key passphrase');
      html += '<tr>'
        + '<td><code>' + escapeHtml(h.id) + '</code></td>'
        + '<td>' + escapeHtml(h.label) + '</td>'
        + '<td>' + escapeHtml(h.username) + '@' + escapeHtml(h.address) + ':' + escapeHtml(h.port) + '</td>'
        + '<td>' + (cred.length ? cred.join('<br>') : tag('none', 'err')) + '</td>'
        + '<td>' + (h.enabled ? tag('enabled', 'ok') : tag('disabled', 'warn')) + '</td>'
        + '<td style="white-space:nowrap">'
        + '<button data-test="' + escapeHtml(h.id) + '">Test</button> '
        + '<button class="danger" data-del="' + escapeHtml(h.id) + '">Delete</button>'
        + '</td></tr>';
    }
    $('hosts').innerHTML = html + '</tbody></table>';
  }

  // Keep the rule-scope dropdown in step with the host list.
  const scope = $('ruleScope');
  const chosen = scope.value;
  scope.innerHTML = '<option value="">All hosts (global)</option>' + hosts.map((h) => '<option value="' + escapeHtml(h.id) + '">' + escapeHtml(h.label) + ' (' + escapeHtml(h.id) + ')</option>').join('');
  scope.value = chosen;

  document.querySelectorAll('[data-test]').forEach((btn) => btn.onclick = async () => {
    const id = btn.getAttribute('data-test');
    btn.disabled = true; btn.textContent = 'Testing…';
    const { status, body } = await api('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id }) });
    btn.disabled = false; btn.textContent = 'Test';
    show('Connection test — ' + id + ' (HTTP ' + status + ')', body);
  });
  document.querySelectorAll('[data-del]').forEach((btn) => btn.onclick = async () => {
    const id = btn.getAttribute('data-del');
    if (!confirm('Delete host ' + id + '? Its rules are removed with it. Stored files are not deleted.')) return;
    const { body } = await api('/api/hosts/delete', { method: 'POST', body: JSON.stringify({ id }) });
    show('Delete host ' + id, body);
    loadHosts(); loadRules();
  });
}

async function loadRules() {
  const { body } = await api('/api/rules');
  const rules = body.rules || [];
  if (!rules.length) { $('rules').innerHTML = '<p class="muted">No rules yet. Without at least one include rule, nothing is collected.</p>'; return; }
  let html = '<table><thead><tr><th>Pattern</th><th>Applies to</th><th>Kind</th><th></th></tr></thead><tbody>';
  for (const r of rules) {
    html += '<tr>'
      + '<td><code>' + escapeHtml(r.pattern) + '</code></td>'
      + '<td>' + (r.scope === 'global' ? tag('all hosts') : escapeHtml(r.hostId)) + '</td>'
      + '<td>' + (r.isExclude ? tag('exclude', 'warn') : tag('include', 'ok')) + '</td>'
      + '<td><button class="danger" data-delrule="' + r.id + '">Delete</button></td>'
      + '</tr>';
  }
  $('rules').innerHTML = html + '</tbody></table>';
  document.querySelectorAll('[data-delrule]').forEach((btn) => btn.onclick = async () => {
    const id = Number(btn.getAttribute('data-delrule'));
    const { body } = await api('/api/rules/delete', { method: 'POST', body: JSON.stringify({ id }) });
    show('Delete rule ' + id, body);
    loadRules();
  });
}

$('saveHost').onclick = async () => {
  const payload = {
    label: $('label').value, address: $('address').value, port: Number($('port').value || 22), username: $('username').value,
    password: $('password').value, privateKey: $('privateKey').value, privateKeyPassphrase: $('privateKeyPassphrase').value,
  };
  const { status, body } = await api('/api/hosts', { method: 'POST', body: JSON.stringify(payload) });
  show('Save host (HTTP ' + status + ')', body);
  if (body && body.ok) {
    // Clear credential inputs immediately: nothing sensitive should linger in the DOM.
    $('password').value = ''; $('privateKey').value = ''; $('privateKeyPassphrase').value = '';
    loadHosts(); loadRules();
  }
};
$('reloadHosts').onclick = () => { loadHosts(); loadRules(); };
$('saveRule').onclick = async () => {
  const payload = { pattern: $('rulePattern').value, hostId: $('ruleScope').value || null, isExclude: $('ruleExclude').value === 'exclude' };
  const { status, body } = await api('/api/rules', { method: 'POST', body: JSON.stringify(payload) });
  show('Add rule (HTTP ' + status + ')', body);
  if (body && body.ok) { $('rulePattern').value = ''; loadRules(); }
};

loadStatus();
loadHosts();
loadRules();
</script>
</body>
</html>`;
}
