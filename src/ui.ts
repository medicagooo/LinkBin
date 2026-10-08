/**
 * The web UI: one self-contained document, served by the same Worker as the API.
 *
 * Constraints that shaped it (all deliberate, see .scratch/vps-file-hub/STATE.md D16):
 *   - No build step, no external requests, no second deployment target. The page is a string.
 *   - No webfont. A font file would be a deployment artifact and a render dependency; the type is
 *     carried by one system stack that covers Latin, Simplified Chinese, Traditional Chinese and
 *     Japanese, with weight and optical tracking doing the work a second family would do.
 *   - No credential ever reaches this page. The API returns a short fingerprint instead, which is
 *     enough to show "a password is stored" and to notice when it changes.
 *   - Scope stays capped: configure hosts and their directories, test a connection, read receipts.
 *     No user system, no roles, no audit log.
 *
 * Three things the page does that a generic panel would not:
 *   1. The **transfer spine** renders the measured stages of a connection as one proportional
 *      hairline. The subject of this product is a measurement — how long each step of reaching a
 *      machine took — so the measurement is the hero rather than a status word.
 *   2. Language switching is instant and client-side (four locales, no reload, no route).
 *   3. Light and dark both get a real design rather than an inverted one: glass needs something
 *      behind it to refract, so each theme has its own bloom field.
 */

import { WORKFLOW_SCRIPT, WORKFLOW_STYLES, WORKFLOW_COPY } from './ui-workflows.ts';

export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja';

export const LOCALES: readonly Locale[] = ['zh-CN', 'zh-TW', 'ja', 'en'] as const;

/** Each locale names itself in its own script, which is the only label a reader always recognises. */
const LOCALE_LABELS: Record<Locale, string> = {
	'en': 'English',
	'zh-CN': '简体中文',
	'zh-TW': '繁體中文',
	'ja': '日本語',
};

/**
 * Picks a locale from an `Accept-Language` header.
 *
 * Traditional and Simplified Chinese are distinct targets, not a fallback chain: `zh-TW`, `zh-HK`,
 * `zh-MO` and `zh-Hant` resolve to Traditional, everything else starting with `zh` to Simplified.
 */
export function pickLocale(acceptLanguage: string | null): Locale {
	if (!acceptLanguage) return 'en';
	const tags = acceptLanguage
		.split(',')
		.map((part) => {
			const [tag, q] = part.trim().split(';q=');
			return { tag: tag.trim().toLowerCase(), q: q ? Number(q) : 1 };
		})
		.filter((entry) => entry.tag)
		.sort((a, b) => b.q - a.q);

	for (const { tag } of tags) {
		if (/^zh-(tw|hk|mo|hant)/.test(tag)) return 'zh-TW';
		if (/^zh/.test(tag)) return 'zh-CN';
		if (/^ja/.test(tag)) return 'ja';
		if (/^en/.test(tag)) return 'en';
	}
	return 'en';
}

export function renderIndexPage(locale: Locale = 'en'): string {
	return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>LinkBin</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1B3AC4"/><stop offset="1" stop-color="#FF7AB8"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M9 21V11h3.2v7.4H23V21z" fill="#fff" opacity=".95"/></svg>`,
	)}">
<style>${STYLES}</style>
</head>
<body>
<a class="skiplink" href="#app" data-i18n="skip">Skip to content</a>

<div class="field" aria-hidden="true">
  <span class="bloom b1"></span><span class="bloom b2"></span><span class="bloom b3"></span>
</div>

<div class="shell">
  <header class="bar">
    <div class="mark">
      <span class="glyph" aria-hidden="true"></span>
      <span class="wordmark">LinkBin</span>
    </div>
    <div class="meters" id="meters" role="status" aria-live="polite"></div>
    <div class="controls">
      <div class="seg" role="group" aria-label="Language" id="langs"></div>
      <div class="seg" role="group" aria-label="Appearance" id="themes"></div>
    </div>
  </header>

  <div id="setup"></div>

  <!--
    The gate. Nothing behind it is fetched until authentication succeeds, so an unauthenticated
    visitor sees a sign-in form rather than a broken-looking empty interface — and, more to the point,
    the management calls are never even attempted without a session.
  -->
  <section class="glass gate" id="gate" hidden aria-labelledby="gate-h">
    <h2 id="gate-h"></h2>
    <p class="lede" id="gate-lede"></p>
    <form id="gate-form" autocomplete="on">
      <label class="f" id="gate-current-wrap" hidden>
        <span data-i18n="auth.current"></span>
        <input id="gate-current" type="password" autocomplete="current-password">
      </label>
      <label class="f">
        <span id="gate-password-label" data-i18n="auth.password"></span>
        <input id="gate-password" type="password" autocomplete="current-password" required>
      </label>
      <div class="actions">
        <button class="primary" type="submit" id="gate-submit"></button>
      </div>
    </form>
    <p class="hint" id="gate-hint"></p>
  </section>

  <div class="workspace" id="workspace" hidden>
    <nav class="glass workspace-nav" aria-label="LinkBin">
      <button type="button" class="ghost" data-view-button="files" data-i18n="ui.nav.files" aria-controls="files-panel">Files</button>
      <button type="button" class="ghost" data-view-button="links" data-i18n="ui.nav.links" aria-controls="links-panel">Download links</button>
      <button type="button" class="ghost" data-view-button="merges" data-i18n="ui.nav.merges" aria-controls="merges-panel">Combined files</button>
      <button type="button" class="ghost" data-view-button="runs" data-i18n="ui.nav.runs" aria-controls="runs-panel">Collection</button>
      <button type="button" class="ghost" data-view-button="hosts" data-i18n="ui.nav.hosts" aria-controls="hosts-panel">Hosts and rules</button>
    </nav>
    <div class="workspace-main">
      <div class="workspace-summary"><p class="hint" id="usageSummary" role="status"></p><button type="button" class="ghost small" id="refreshData" data-i18n="ui.refresh">Refresh</button></div>
  <main class="grid" id="app" hidden tabindex="-1">
    <section class="glass rail" id="hosts-panel" data-panel="hosts" aria-labelledby="hosts-h">
      <h2 id="hosts-h" data-i18n="hosts.title">Hosts</h2>
      <p class="lede" data-i18n="hosts.lede"></p>
      <div id="hostlist"></div>
      <button class="ghost wide" id="addToggle" data-i18n="hosts.add">Add a host</button>
    </section>

    <div class="stack">
      <section class="glass form" id="hostform" hidden aria-labelledby="form-h">
        <h2 id="form-h" data-i18n="form.title">Add or update a host</h2>
        <div class="fields">
          <label class="f"><span data-i18n="form.label">Label</span><input id="f-label" autocomplete="off" placeholder="web-1"></label>
          <label class="f"><span data-i18n="form.address">Address</span><input id="f-address" autocomplete="off" placeholder="host or IP"></label>
          <label class="f narrow"><span data-i18n="form.port">Port</span><input id="f-port" value="22" inputmode="numeric"></label>
          <label class="f"><span data-i18n="form.username">Username</span><input id="f-username" autocomplete="off" placeholder="root"></label>
        </div>
        <fieldset class="authmode">
          <legend data-i18n="form.authMode">Authentication</legend>
          <label class="mode"><input type="radio" name="authmode" value="password" id="m-password" checked><span data-i18n="form.modePassword">Username and password</span></label>
          <label class="mode"><input type="radio" name="authmode" value="key" id="m-key"><span data-i18n="form.modeKey">Username and private key</span></label>
        </fieldset>
        <div class="fields" id="mode-password">
          <label class="f"><span data-i18n="form.password">Password</span><input id="f-password" type="password" autocomplete="new-password"></label>
        </div>
        <div id="mode-key" hidden>
          <label class="f"><span data-i18n="form.privateKey">Private key</span><textarea id="f-key" rows="3" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
          <div class="fields">
            <label class="f"><span data-i18n="form.passphrase">Key passphrase (optional)</span><input id="f-passphrase" type="password" autocomplete="new-password"></label>
          </div>
        </div>
        <p class="hint" data-i18n="form.hint"></p>
        <div class="actions">
          <button class="primary" id="saveHost" data-i18n="form.save">Save host</button>
          <button class="ghost" id="cancelHost" data-i18n="form.cancel">Cancel</button>
        </div>
        <div class="formmsg" id="formmsg" hidden role="status" aria-live="polite"></div>
      </section>

      <section class="glass rules" data-panel="hosts" aria-labelledby="rules-h">
        <h2 id="rules-h" data-i18n="rules.title">Directories to collect</h2>
        <p class="lede" data-i18n="rules.lede"></p>
        <div class="fields">
          <label class="f"><span data-i18n="rules.scope">Applies to</span><select id="r-scope"></select></label>
          <label class="f wide2"><span data-i18n="rules.pattern">Pattern</span><input id="r-pattern" spellcheck="false" placeholder="/var/log/*.log"></label>
          <label class="f narrow"><span data-i18n="rules.kind">Kind</span><select id="r-kind"><option value="include" data-i18n="rules.include">Include</option><option value="exclude" data-i18n="rules.exclude">Exclude</option></select></label>
        </div>
        <div class="actions"><button class="quiet" id="saveRule" data-i18n="rules.add">Add rule</button></div>
        <div id="rulelist"></div>
      </section>

      <section class="glass browse" id="files-panel" data-panel="files" aria-labelledby="browse-h">
        <h2 id="browse-h" data-i18n="browse.title">Stored files</h2>
        <p class="lede" data-i18n="browse.lede"></p>
        <div class="fields">
          <label class="f"><span data-i18n="browse.search">Search</span><input id="b-search" type="search" spellcheck="false" autocomplete="off"></label>
          <label class="f narrow"><span data-i18n="browse.machine">Machine</span><select id="b-host"><option value="" data-i18n="browse.anyMachine">Any</option></select></label>
          <label class="f narrow"><span data-i18n="browse.sort">Sort</span><select id="b-sort">
            <option value="newest" data-i18n="browse.newest">Newest</option>
            <option value="oldest" data-i18n="browse.oldest">Oldest</option>
            <option value="largest" data-i18n="browse.largest">Largest</option>
            <option value="smallest" data-i18n="browse.smallest">Smallest</option>
            <option value="path" data-i18n="browse.byPath">By path</option>
          </select></label>
          <label class="f narrow toggle"><input id="b-history" type="checkbox"><span data-i18n="browse.history">Include replaced versions</span></label>
        </div>
        <div id="browseCount" class="browse-count"></div>
        <div class="upload-area">
          <div class="fields"><label class="f"><span data-i18n="files.upload">Upload files to R2</span><input id="f-upload" type="file" multiple></label></div>
          <div id="uploadQueue" role="status" aria-live="polite"></div>
          <div class="actions"><button class="quiet" id="uploadFiles" data-i18n="files.uploadAction" disabled>Upload selected files</button><button class="ghost" id="retryUploads" data-i18n="ui.retryUploads" disabled>Retry failed files</button></div>
          <div id="uploadResult" role="status"></div>
        </div>
        <div id="objectlist"></div>
      </section>
      <section class="glass direct" data-panel="links" aria-labelledby="direct-h">
        <h2 id="direct-h" data-i18n="files.directTitle">Direct download links</h2>
        <p class="hint" data-i18n="files.directHint">Anyone with a direct link can download the latest version. Revoke it here to stop access.</p>
        <div id="directLinks"></div>
      </section>

      <section class="glass storage" data-panel="files" aria-labelledby="storage-h">
        <h2 id="storage-h" data-i18n="storage.title">Storage</h2>
        <button type="button" class="ghost small" id="largestFiles" data-i18n="ui.largestFiles">View largest files</button>
        <!--
          The numbers are the point, not decoration. A budget that is only ENFORCED is one the operator discovers
          by having a file refused, and by then the useful moment for planning around it has passed.
        -->
        <div id="usage"></div>
        <details><summary data-i18n="ui.storagePolicy"></summary><p class="hint" data-i18n="storage.lede"></p></details>
      </section>

      <section class="glass shares" id="links-panel" data-panel="links" aria-labelledby="shares-h">
        <h2 id="shares-h" data-i18n="shares.title">Shared links</h2>
        <p class="lede" data-i18n="shares.lede"></p>
        <div class="fields">
          <label class="f"><span data-i18n="ui.findFile">Find a file by path</span><input id="s-search" type="search" autocomplete="off"></label>
          <label class="f share-picker"><span data-i18n="ui.selectFile">Choose a stored file</span><select id="s-object"></select></label>
          <label class="f narrow"><span data-i18n="shares.lifetime">Lasts</span><select id="s-seconds">
            <option value="900" data-i18n="shares.15m">15 minutes</option>
            <option value="3600" data-i18n="shares.1h">1 hour</option>
            <option value="7200" selected data-i18n="shares.2h">2 hours</option>
            <option value="43200" data-i18n="shares.12h">12 hours</option>
            <option value="86400" data-i18n="shares.24h">24 hours</option>
          </select></label>
          <label class="f"><span data-i18n="files.sharePassword">Sharing password (8–1024 characters)</span><input id="s-password" type="password" autocomplete="new-password" spellcheck="false" minlength="8" maxlength="1024"></label>
        </div>
        <div id="shareChoices" role="status"></div><p id="shareSelected" class="share-selection"></p>
        <div class="actions"><button class="quiet" id="makeShare" disabled data-i18n="shares.create">Create link</button></div>
        <div id="shareResult"></div>
        <div id="sharelist"></div>
      </section>

      <section class="glass merges" id="merges-panel" data-panel="merges" aria-labelledby="merges-h">
        <h2 id="merges-h" data-i18n="merges.title">Combined files</h2>
        <p class="lede" data-i18n="merges.lede"></p>
        <div class="fields">
          <label class="f output-name"><span data-i18n="merges.outputName">Call the result</span><input id="m-name" spellcheck="false" placeholder="merged.yaml"></label>
          <label class="f combination"><span data-i18n="merges.combination">How to combine</span><select id="m-combination">
            <option value="yaml-list-union" selected data-i18n="merges.union">Merge their lists into one document</option>
            <option value="concat" data-i18n="merges.concat">Join them end to end</option>
            <option value="proxy-profile" data-i18n="files.profile">merged-all.yaml profile (8 providers)</option>
          </select></label>
        </div>
        <div class="fields">
          <label class="f"><span data-i18n="merges.patterns">Which stored files (one pattern per line)</span><textarea id="m-patterns" rows="3" spellcheck="false" placeholder="/etc/app/*.yaml"></textarea></label>
        </div>
        <div class="actions">
          <button class="ghost" id="previewMerge" data-i18n="merges.preview">Preview</button>
          <button class="quiet" id="saveMerge" data-i18n="merges.save">Save rule</button>
          <button class="ghost" id="profilePreset" data-i18n="files.profilePreset">Use merged-all preset</button>
        </div>
        <!-- Preview output sits above the list so the thing just asked for is visible without scrolling. -->
        <div id="presetStatus" role="status"></div>
        <p class="hint" data-i18n="ui.previewRequired"></p>
        <div id="mergePreview" role="status"></div>
        <div id="mergelist"></div>
      </section>

      <section class="glass runs" id="runs-panel" data-panel="runs" aria-labelledby="runs-h">
        <h2 id="runs-h" data-i18n="runs.title">Collection history</h2>
        <p class="lede" data-i18n="runs.lede"></p>
        <!--
          Freshness sits above the history because it answers the question the history only implies: is the
          schedule keeping up? The history says what each run did; this says how far behind the worst machine is,
          which is the figure an operator acts on.
        -->
        <div id="freshness"></div>
        <div id="runlist"></div>
        <!--
          On demand, beside the history it produces: the two are read together, and a control that starts a run
          belongs where its results appear.
        -->
        <div class="actions"><button class="quiet" id="collectNow" data-i18n="runs.collectNow">Collect now</button></div>
        <p class="hint" id="collectHint"></p>
        <div id="collectResult" role="status" aria-live="polite"></div>
      </section>

      <section class="glass panel" id="panel" data-panel="hosts" aria-labelledby="result-h">
        <h2 id="result-h" data-i18n="result.title">Connection test</h2>
        <div id="result"><p class="lede" data-i18n="result.empty"></p></div>
      </section>
    </div>
  </main>
    </div>
  </div>
</div>

<script>
(function () {
  'use strict';

  var BOOT = { locale: ${JSON.stringify(locale)}, locales: ${JSON.stringify(LOCALES)}, labels: ${JSON.stringify(LOCALE_LABELS)} };

  var T = ${translationsLiteral()};

  /* --- helpers that MUST come first ----------------------------------------------------------

     The dollar helper was defined further down the file, in the helpers section, and that was a real
     defect rather than a matter of tidiness: it is assigned with var, so it is hoisted as undefined
     and the FIRST statement to call it throws "$ is not a function". Two places called it first —
     the gate's own code and the submit listener — so the page died before it could show anything,
     which is how it presented: an interface that rendered but with no password prompt and no
     working controls.

     It was invisible for as long as a separate syntax error stopped the script from running at all.
     Fixing that error is what exposed this one, and the lesson is worth keeping: a script that never
     runs hides every fault behind its first.

     A var helper has to be declared before its first USE, in execution order and not merely in the
     file. Function declarations hoist fully and could sit anywhere; this one is a var, so it cannot. */
  var $ = function (id) { return document.getElementById(id); };

  // --- the gate ------------------------------------------------------------------------------
  /**
   * Decides what the visitor sees before anything else runs.
   *
   * Three states, and the difference between the first two matters: a deployment with no password
   * offers to create one, and a deployment with a password asks for it. The third is the normal case,
   * where the interface simply loads.
   */
  var authMode = 'loading';

  function showGate(mode, message) {
    authMode = mode;
    var gate = $('gate');
    var app = $('app');
    gate.hidden = false;
    app.hidden = true;
    $('workspace').hidden = true;

    var isSetup = mode === 'setup';
    $('gate-h').textContent = t(isSetup ? 'auth.setupTitle' : 'auth.signInTitle');
    $('gate-lede').textContent = t(isSetup ? 'auth.setupLede' : 'auth.signInLede');
    $('gate-submit').textContent = t(isSetup ? 'auth.setupAction' : 'auth.signInAction');
    $('gate-password').setAttribute('autocomplete', isSetup ? 'new-password' : 'current-password');
    $('gate-hint').textContent = message ? message : t(isSetup ? 'auth.setupHint' : '');
    $('gate-hint').className = message ? 'hint error' : 'hint';
    $('gate-password').value = '';
    $('gate-password').focus();
  }

  function hideGate() {
    authMode = 'in';
    $('gate').hidden = true;
    $('app').hidden = false;
    $('workspace').hidden = false;
    $('setup').hidden = false;
  }

  function authState() {
    return api('/api/auth/state').then(function (r) {
      if (!r.ok) { showGate('signin', r.body.error || t('auth.failed')); return; }
      if (r.body.configured && r.body.signedIn) {
        hideGate();
        refreshAll();
      } else if (r.body.configured) {
        // Authenticated pages exist but this visitor has no session yet.
        $('setup').hidden = true;
        showGate('signin');
      } else {
        $('setup').hidden = true;
        showGate('setup');
      }
    });
  }

  $('gate-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var password = $('gate-password').value;
    var button = $('gate-submit');
    button.disabled = true;

    var request =
      authMode === 'setup'
        ? api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password: password }) })
        : api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: password }) });

    request.then(function (r) {
      button.disabled = false;
      if (r.ok && r.body.ok) {
        // After setting a password the operator is not signed in yet, so sign in straight away rather
        // than making them type it twice.
        if (authMode === 'setup') {
          api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: password }) }).then(function (login) {
            $('gate-password').value = '';
            if (!login.ok || !login.body.ok) { showGate('signin', login.body.error || t('auth.failed')); return; }
            hideGate();
            refreshAll();
          });
        } else {
          $('gate-password').value = '';
          hideGate();
          refreshAll();
        }
        return;
      }
      showGate(authMode, r.body.error || t('auth.failed'));
    });
  });

  // --- locale ------------------------------------------------------------------------------
  // Precedence is URL, then the reader's stored choice, then the device, then whatever the server
  // negotiated from Accept-Language. The URL must come FIRST and must match the server's rule, or
  // the two disagree: the server would render ?lang=zh-CN correctly and this script then replaced it
  // with the device language on boot, which made the link silently useless.
  function resolveLocale() {
    var fromUrl = null;
    try { fromUrl = new URLSearchParams(location.search).get('lang'); } catch (e) {}
    if (fromUrl && T[fromUrl]) return fromUrl;

    try {
      var stored = localStorage.getItem('linkbin.locale');
      if (stored && T[stored]) return stored;
    } catch (e) {}
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    var lower = String(nav).toLowerCase();
    if (/^zh\\-(tw|hk|mo|hant)/.test(lower)) return 'zh-TW';
    if (/^zh/.test(lower)) return 'zh-CN';
    if (/^ja/.test(lower)) return 'ja';
    if (/^en/.test(lower)) return 'en';
    return BOOT.locale;
  }

  var locale = resolveLocale();

  function t(key, params) {
    var table = T[locale] || T.en;
    var value = table[key];
    if (value === undefined) value = T.en[key];
    if (value === undefined) return key;
    if (params) {
      value = String(value).replace(/\\{(\\w+)\\}/g, function (m, k) {
        return params[k] === undefined ? m : String(params[k]);
      });
    }
    return value;
  }

  // --- appearance --------------------------------------------------------------------------
  // "auto" is the default and follows the device. An explicit choice is remembered.
  function resolveTheme() {
    var stored = null;
    try { stored = localStorage.getItem('linkbin.theme'); } catch (e) {}
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(pref) {
    var effective = pref === 'auto'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.setAttribute('data-theme', effective);
    document.documentElement.setAttribute('data-theme-pref', pref);
  }

  var themePref = 'auto';
  try { themePref = localStorage.getItem('linkbin.theme') || 'auto'; } catch (e) {}
  // ?theme=dark wins over the stored preference so a specific appearance can be linked to. It is
  // also what makes the theme testable from a screenshot run, where a stored preference cannot be set.
  try {
    var fromUrl = new URLSearchParams(location.search).get('theme');
    if (fromUrl === 'light' || fromUrl === 'dark' || fromUrl === 'auto') themePref = fromUrl;
  } catch (e) {}
  applyTheme(themePref);

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (themePref === 'auto') applyTheme('auto'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // --- helpers -----------------------------------------------------------------------------
  // The dollar helper is declared at the TOP of this script, not here, and the comment there says why: it is a
  // var, so a use before its declaration runs against undefined. Everything below it in this section is a
  // function declaration, which hoists fully and may therefore sit anywhere.

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // Every request is bounded. Without this a hung call leaves the page waiting forever - and a
  // disabled button is the same class of dead end as a silent failure. The server's own SSH connect
  // timeout is 20s, so 30s leaves room for that plus the round trip.
  var REQUEST_TIMEOUT_MS = 30000;

  function api(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (controller) {
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, path.indexOf('/api/files/upload') === 0 ? 120000 : path === '/api/collect' ? 360000 : REQUEST_TIMEOUT_MS);
    }
    function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        stopTimer();
        return { status: res.status, ok: res.ok, body: body };
      });
    }).catch(function (err) {
      stopTimer();
      // A rejected fetch never reached an answer: the connection dropped, the Worker was mid-deploy,
      // the browser is offline, or the timeout above fired. Every caller on this page is a bare
      // .then() with no .catch() of its own, so without this the promise rejects into nothing and the
      // click appears to do absolutely nothing - which is exactly how a failed save was reported, and
      // it cost a diagnosis session: the fault was invisible rather than merely unexplained.
      // Normalising it into the same shape as an HTTP failure gives one handling path everywhere.
      // NOTE: never write a backtick in this file, not even inside a comment. Everything from the
      // doctype to the closing script tag is one template literal, so a backtick here - including one
      // in prose - ends the literal early and the remainder is parsed as code. That happened once and
      // produced a TypeError naming a nonsense identifier instead of a syntax error.
      var aborted = !!(err && err.name === 'AbortError');
      return {
        status: 0,
        ok: false,
        body: {
          ok: false,
          error: aborted
            ? t('form.requestTimeout', { seconds: Math.round(REQUEST_TIMEOUT_MS / 1000) })
            : t('form.requestFailed', { detail: String((err && err.message) || err) }),
        },
      };
    });
  }

  function node(tag, cls, text) { return el(tag, cls, text); }

  function clear(target) { while (target.firstChild) target.removeChild(target.firstChild); }

  function chip(text, kind) {
    var span = node('span', 'chip' + (kind ? ' ' + kind : ''), text);
    return span;
  }

  // --- chrome: meters, language, theme -----------------------------------------------------
  function renderMeters(status) {
    var host = $('meters');
    clear(host);
    var bits = [
      { on: !!status.masterKeySet, key: 'status.key' },
      { on: !!(status.schema && status.schema.ready), key: 'status.schema' },
      { on: !!status.r2Bound, key: 'status.storage' }
    ];
    bits.forEach(function (bit) {
      var item = node('span', 'meter' + (bit.on ? ' on' : ' off'));
      item.appendChild(node('i', 'dot'));
      item.appendChild(node('span', null, t(bit.key)));
      host.appendChild(item);
    });
  }

  function renderLangSwitch() {
    var host = $('langs');
    clear(host);
    BOOT.locales.forEach(function (code, index) {
      var b = node('button', 'segbtn' + (code === locale ? ' active' : ''), BOOT.labels[code]);
      b.type = 'button';
      b.setAttribute('lang', code);
      b.setAttribute('aria-pressed', String(code === locale));
      b.addEventListener('click', function () {
        locale = code;
        try { localStorage.setItem('linkbin.locale', code); } catch (e) {}
        document.documentElement.setAttribute('lang', code);
        renderLangSwitch();
        applyStaticText();
        refreshAll();
      });
      if (index === 0) b.classList.add('first');
      host.appendChild(b);
    });
  }

  function renderThemeSwitch() {
    var host = $('themes');
    clear(host);
    [['auto', 'theme.auto', '◐'], ['light', 'theme.light', '☀'], ['dark', 'theme.dark', '☾']].forEach(function (spec) {
      var b = node('button', 'segbtn icon', spec[2]);
      b.type = 'button';
      b.title = t(spec[1]);
      b.setAttribute('aria-label', t(spec[1]));
      b.setAttribute('aria-pressed', String(themePref === spec[0]));
      if (themePref === spec[0]) b.classList.add('active');
      b.addEventListener('click', function () {
        themePref = spec[0];
        try { localStorage.setItem('linkbin.theme', themePref); } catch (e) {}
        applyTheme(themePref);
        renderThemeSwitch();
      });
      host.appendChild(b);
    });
  }

  /** Fills every element carrying a data-i18n key, so a language change needs no reload. */
  function applyStaticText() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      nodes[i].textContent = t(key);
    }
    var ph = document.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < ph.length; j++) ph[j].setAttribute('placeholder', t(ph[j].getAttribute('data-i18n-ph')));
  }

  // --- the transfer spine ------------------------------------------------------------------
  /**
   * Renders measured stages as one proportional hairline plus a labelled list.
   *
   * This is the hero of the page and it is earned rather than decorative: the numbers are the real
   * per-stage durations the Worker measured. Width carries the proportion, the longest stage takes
   * the bloom colour, and every value stays readable as text so the graphic is an aid, not the only
   * source.
   */
  function spine(stages) {
    var list = (stages || []).filter(function (s) { return typeof s.ms === 'number'; });
    if (!list.length) return null;

    var total = list.reduce(function (sum, s) { return sum + s.ms; }, 0) || 1;
    var max = Math.max.apply(null, list.map(function (s) { return s.ms; }));

    var wrap = node('div', 'spine');
    var track = node('div', 'spine-track');
    list.forEach(function (s) {
      var seg = node('span', 'seg' + (s.ms === max ? ' peak' : ''));
      seg.style.flexGrow = String(Math.max(s.ms, 1));
      track.appendChild(seg);
    });
    wrap.appendChild(track);

    var legend = node('ul', 'spine-legend');
    list.forEach(function (s) {
      var li = node('li', 'stage');
      li.appendChild(node('span', 'stage-name', s.stage));
      var value = node('span', 'stage-ms');
      value.appendChild(node('b', null, String(s.ms)));
      value.appendChild(node('span', 'unit', 'ms'));
      li.appendChild(value);
      var pct = node('span', 'stage-pct', Math.round((s.ms / total) * 100) + '%');
      li.appendChild(pct);
      legend.appendChild(li);
    });
    wrap.appendChild(legend);

    var totalRow = node('div', 'spine-total');
    totalRow.appendChild(node('span', null, t('result.total')));
    var strong = node('strong', null, String(total));
    totalRow.appendChild(strong);
    totalRow.appendChild(node('span', 'unit', 'ms'));
    wrap.appendChild(totalRow);
    return wrap;
  }

  // --- setup ---------------------------------------------------------------------------------
  function renderSetup(status) {
    var host = $('setup');
    clear(host);
    var needsKey = !status.masterKeySet;
    var needsSchema = !(status.schema && status.schema.ready);
    if (!needsKey && !needsSchema) return;

    var box = node('section', 'glass setup');
    box.appendChild(node('h2', null, t('setup.title')));
    var steps = node('ol', 'steps');

    if (needsKey) {
      var li = node('li', null);
      li.appendChild(node('p', null, t('setup.key')));
      var actions = node('div', 'actions');
      var gen = node('button', 'primary', t('setup.generate'));
      gen.type = 'button';
      actions.appendChild(gen);
      li.appendChild(actions);
      var out = node('div', 'keyout');
      li.appendChild(out);
      gen.addEventListener('click', function () {
        api('/api/master-key').then(function (r) {
          clear(out);
          var label = node('label', 'f');
          label.appendChild(node('span', null, t('setup.keyValue')));
          var input = node('input');
          input.readOnly = true;
          input.value = r.body.generated || '';
          label.appendChild(input);
          out.appendChild(label);
          out.appendChild(node('p', 'hint', t('setup.keyWarning')));
          out.appendChild(node('p', 'hint', t('setup.keyStatus', { status: r.body.currentKeyStatus })));
          input.focus();
          input.select();
        });
      });
      steps.appendChild(li);
    }

    if (needsSchema) {
      var li2 = node('li', null);
      var missing = (status.schema && status.schema.missing) ? status.schema.missing.join(', ') : '';
      li2.appendChild(node('p', null, t('setup.schema', { missing: missing })));
      var actions2 = node('div', 'actions');
      var apply = node('button', 'quiet', t('setup.apply'));
      apply.type = 'button';
      actions2.appendChild(apply);
      li2.appendChild(actions2);
      apply.addEventListener('click', function () {
        apply.disabled = true;
        api('/api/admin/apply-schema', { method: 'POST' }).then(function (r) {
          apply.disabled = false;
          loadStatus();
          showRaw(t('setup.applied'), r.body);
        });
      });
      steps.appendChild(li2);
    }

    box.appendChild(steps);
    host.appendChild(box);
  }

  // --- hosts ---------------------------------------------------------------------------------
  var hostCache = [];

  function renderHosts(hosts) {
    hostCache = hosts || [];
    var host = $('hostlist');
    clear(host);

    if (!hostCache.length) {
      var empty = node('div', 'empty');
      empty.appendChild(node('p', 'empty-line', t('hosts.empty')));
      empty.appendChild(node('p', 'hint', t('hosts.emptyHint')));
      host.appendChild(empty);
    } else {
      hostCache.forEach(function (h) {
        var card = node('article', 'host');

        var head = node('div', 'host-head');
        head.appendChild(node('span', 'host-label', h.label));
        head.appendChild(chip(h.enabled ? t('hosts.enabled') : t('hosts.disabled'), h.enabled ? 'ok' : 'warn'));
        card.appendChild(head);

        var target = node('p', 'host-target');
        target.appendChild(node('span', 'user', h.username));
        target.appendChild(node('span', 'at', '@'));
        target.appendChild(node('span', 'addr', h.address));
        target.appendChild(node('span', 'port', ':' + h.port));
        card.appendChild(target);

        var creds = node('div', 'creds');
        if (h.hasPassword) {
          var c = chip(t('hosts.password'), 'ok');
          c.title = t('hosts.fingerprint') + ' ' + (h.passwordFingerprint || '');
          creds.appendChild(c);
        }
        if (h.hasPrivateKey) {
          var c2 = chip(t('hosts.key'), 'ok');
          c2.title = t('hosts.fingerprint') + ' ' + (h.privateKeyFingerprint || '');
          creds.appendChild(c2);
        }
        if (!h.hasPassword && !h.hasPrivateKey) creds.appendChild(chip(t('hosts.noCredential'), 'err'));
        card.appendChild(creds);

        var acts = node('div', 'host-actions');
        var test = node('button', 'primary small', t('hosts.test'));
        test.type = 'button';
        test.addEventListener('click', function () {
          test.disabled = true;
          test.textContent = t('hosts.testing');
          api('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: h.id }) }).then(function (r) {
            test.disabled = false;
            test.textContent = t('hosts.test');
            renderTest(h, r);
          });
        });
        acts.appendChild(test);
        var del = node('button', 'ghost small danger', t('hosts.delete'));
        del.type = 'button';
        del.addEventListener('click', function () {
          if (!window.confirm(t('hosts.confirmDelete', { id: h.id }))) return;
          api('/api/hosts/delete', { method: 'POST', body: JSON.stringify({ id: h.id }) }).then(function () {
            refreshAll();
          });
        });
        acts.appendChild(del);
        card.appendChild(acts);

        host.appendChild(card);
      });
    }

    // keep the rule scope selector in step with the host list
    var scope = $('r-scope');
    var chosen = scope.value;
    clear(scope);
    var all = node('option', null, t('rules.allHosts'));
    all.value = '';
    scope.appendChild(all);
    hostCache.forEach(function (h) {
      var opt = node('option', null, h.label + ' (' + h.id + ')');
      opt.value = h.id;
      scope.appendChild(opt);
    });
    scope.value = chosen;
  }

  // --- result panel --------------------------------------------------------------------------
  function showRaw(title, payload) {
    var host = $('result');
    clear(host);
    host.appendChild(node('h3', 'result-title', title));
    var pre = node('pre', 'raw');
    pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    host.appendChild(pre);
  }

  /**
   * The payoff view: identity, then the transfer spine, then how each rule resolves against the
   * machine's real filesystem. Raw JSON stays available but is no longer the interface.
   */
  function renderTest(host, response) {
    var host_ = $('result');
    clear(host_);

    var body = response.body || {};

    if (!response.ok || body.ok === false) {
      var fail = node('div', 'failed');
      fail.appendChild(node('h3', 'result-title', t('result.failed')));
      fail.appendChild(node('p', 'fail-msg', body.error || t('result.unknownError')));
      if (body.hint) fail.appendChild(node('p', 'hint', body.hint));
      var stagesWrap = spine(body.stages);
      if (stagesWrap) fail.appendChild(stagesWrap);
      var det = node('details', 'reveal');
      det.appendChild(node('summary', null, t('result.raw')));
      var pre = node('pre', 'raw');
      pre.textContent = JSON.stringify(body, null, 2);
      det.appendChild(pre);
      fail.appendChild(det);
      host_.appendChild(fail);
      return;
    }

    var ok = node('div', 'succeeded');
    var titleRow = node('div', 'result-head');
    titleRow.appendChild(node('h3', 'result-title', host.label));
    titleRow.appendChild(chip(t('result.ok'), 'ok'));
    ok.appendChild(titleRow);

    if (body.facts) {
      var facts = node('dl', 'facts');
      [['fact.hostname', body.facts.hostname], ['fact.user', body.facts.whoami], ['fact.system', body.facts.uname]].forEach(function (pair) {
        if (!pair[1]) return;
        facts.appendChild(node('dt', null, t(pair[0])));
        facts.appendChild(node('dd', null, pair[1]));
      });
      if (body.facts.disk && body.facts.disk.length) {
        var d = body.facts.disk[0];
        facts.appendChild(node('dt', null, t('fact.disk')));
        facts.appendChild(node('dd', null, t('fact.diskValue', { free: Math.round((d.availKb || 0) / 1024), size: Math.round((d.sizeKb || 0) / 1024) })));
      }
      ok.appendChild(facts);
    }

    var sp = spine(body.stages);
    if (sp) ok.appendChild(sp);

    var evals = body.evaluations || [];
    if (evals.length) {
      ok.appendChild(node('h4', 'sub', t('result.rules')));
      var list = node('ul', 'evals');
      evals.forEach(function (ev) {
        var li = node('li', 'eval');
        var top = node('div', 'eval-top');
        top.appendChild(node('code', 'pattern', ev.pattern));
        top.appendChild(chip(ev.scope === 'global' ? t('rules.allHosts') : ev.scope, 'quiet'));
        top.appendChild(chip(ev.isExclude ? t('rules.exclude') : t('rules.include'), ev.isExclude ? 'warn' : 'quiet'));
        li.appendChild(top);

        if (ev.status === 'ok') {
          li.appendChild(node('p', 'eval-detail', t('result.matches', { count: ev.matchCount || 0 })));
          if (ev.matches && ev.matches.length) {
            var files = node('div', 'files');
            ev.matches.slice(0, 12).forEach(function (name) { files.appendChild(node('span', 'file', name)); });
            if (ev.matchCount > 12) files.appendChild(node('span', 'file more', '+' + (ev.matchCount - 12)));
            li.appendChild(files);
          }
        } else if (ev.status === 'needs_collection_step') {
          li.appendChild(node('p', 'eval-detail warn', t('result.needsCollection')));
        } else {
          li.appendChild(node('p', 'eval-detail bad', ev.detail || ''));
        }
        list.appendChild(li);
      });
      ok.appendChild(list);
    } else {
      ok.appendChild(node('p', 'hint', t('result.noRules')));
    }

    var det2 = node('details', 'reveal');
    det2.appendChild(node('summary', null, t('result.raw')));
    var pre2 = node('pre', 'raw');
    pre2.textContent = JSON.stringify(body, null, 2);
    det2.appendChild(pre2);
    ok.appendChild(det2);

    host_.appendChild(ok);
  }

  // --- rules ---------------------------------------------------------------------------------
  function renderRules(rules) {
    var host = $('rulelist');
    clear(host);
    if (!rules.length) {
      var empty = node('div', 'empty');
      empty.appendChild(node('p', 'empty-line', t('rules.empty')));
      empty.appendChild(node('p', 'hint', t('rules.emptyHint')));
      host.appendChild(empty);
      return;
    }
    var list = node('ul', 'rules-list');
    rules.forEach(function (r) {
      var li = node('li', 'rule');
      li.appendChild(node('code', 'pattern', r.pattern));
      li.appendChild(chip(r.scope === 'global' ? t('rules.allHosts') : r.hostId, 'quiet'));
      li.appendChild(chip(r.isExclude ? t('rules.exclude') : t('rules.include'), r.isExclude ? 'warn' : 'ok'));
      var del = node('button', 'ghost small', t('rules.delete'));
      del.type = 'button';
      del.addEventListener('click', function () {
        mutate(del, '/api/rules/delete', { id: r.id }, loadRules, li);
      });
      var tail = node('div', 'rule-tail');
      tail.appendChild(del);
      li.appendChild(tail);
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  // --- stored files --------------------------------------------------------------------------
  /**
   * The current browse request.
   *
   * Kept in state rather than read from the inputs on each render, so a response arriving after the operator
   * has typed something else cannot repaint the list with results for a query that is no longer on screen.
   */
  var browseState = { search: '', host: '', sort: 'newest', history: false, limit: 50, skipped: 0 };

  /**
   * The stored-file list.
   *
   * "Append" is set when this is a load-more request: the rows already on screen are kept and the new page is
   * added below them. Re-rendering the whole list from an offset instead would be simpler here and wrong in
   * practice — it would throw away the reader's scroll position and make "show me more" behave like "refresh".
   */
  function renderObjects(objects, total, limit, append) {
    var host = $('objectlist');
    if (!append) clear(host);

    var count = $('browseCount');
    if (!append) clear(count);
    var shown = (append ? host.querySelectorAll('li').length : 0) + objects.length;
    if (total !== undefined) {
      clear(count);
      // Says how many there are as well as how many are shown: a truncated list that looks like the whole
      // answer is worse than one that says it is truncated.
      count.appendChild(
        node('span', 'hint', total > shown
          ? t('browse.showing').replace('{n}', shown).replace('{total}', total)
          : t('browse.count').replace('{n}', total))
      );
    }

    if (!objects.length) {
      // On a "load more" that returned nothing there is already a list on screen, so replacing it with an empty
      // state would erase the results the reader was looking at.
      if (append) return;
      var empty = node('div', 'empty');
      // Two different nothings, and they mean opposite things: nothing collected yet, or nothing matching
      // what was asked for. Showing the wrong one sends the operator looking in the wrong place.
      var searching = browseState.search || browseState.host;
      empty.appendChild(node('p', 'empty-line', searching ? t('browse.noMatch') : t('browse.empty')));
      empty.appendChild(node('p', 'hint', searching ? t('browse.noMatchHint') : t('browse.emptyHint')));
      if (!searching) {
        var actions = node('div', 'actions empty-actions');
        var upload = node('button', 'quiet', t('files.upload')); upload.type = 'button';
        upload.addEventListener('click', function () { $('f-upload').focus(); $('f-upload').scrollIntoView({ block: 'center' }); });
        var configure = node('button', 'ghost', t('ui.nav.hosts')); configure.type = 'button';
        configure.addEventListener('click', function () { selectView('hosts'); });
        actions.appendChild(upload); actions.appendChild(configure); empty.appendChild(actions);
      }
      host.appendChild(empty);
      return;
    }

    var list = host.querySelector('ul.rules-list');
    if (!list) {
      list = node('ul', 'rules-list');
      host.appendChild(list);
    }

    objects.forEach(function (o) {
      var li = node('li', 'rule');

      var target = node('div', 'share-target');
      target.appendChild(node('code', 'pattern', o.path));
      target.appendChild(node('span', 'share-size', bytes(o.sizeBytes)));
      li.appendChild(target);

      li.appendChild(chip(o.hostId, 'quiet'));
      if (o.important) li.appendChild(chip(t('browse.protected'), 'ok'));
      if (!o.live) li.appendChild(chip(t('browse.replaced'), 'warn'));
      // Only when the server actually looked. An absent value means "not checked", and rendering that as gone
      // would claim a present file had been reclaimed.
      if (o.bytesPresent === false) li.appendChild(chip(t('browse.gone'), 'warn'));

      // WHEN it was stored, and WHEN the machine last saw it. Two different facts, and the second is the one that
      // answers "is this stale": a file stored a month ago and unchanged since is current, while one stored an
      // hour ago from a machine that has since had the file rewritten is not.
      //
      // Both are omitted rather than guessed when absent. A stored time the store did not record, or a
      // modification time the machine did not report, must say nothing — "1970" and "just now" are both
      // inventions, and the second is the more dangerous because it looks current.
      var stored = agoIso(o.createdAt);
      if (stored) li.appendChild(chip(t('browse.storedAgo').replace('{v}', stored), 'quiet'));
      var seen = agoMachineSeconds(o.mtime);
      if (seen) li.appendChild(chip(t('browse.seenAgo').replace('{v}', seen), 'quiet'));

      var tail = node('div', 'rule-tail');

      // The path is long, machine-specific and easy to mistype, which is exactly the kind of value worth a
      // button. Offered for every row, including one whose bytes are gone: the record of where a file lived
      // outlives the file.
      var copyPath = node('button', 'ghost small', t('browse.copyPath'));
      copyPath.type = 'button';
      copyPath.addEventListener('click', function () {
        copyText(o.path, copyPath, t('browse.copyPath'), t('browse.copied'));
      });
      tail.appendChild(copyPath);

      // The id is what the share panel and the merge sources are configured by, so copying it beats reading it
      // off the screen and retyping it.
      var copyId = node('button', 'ghost small', t('browse.copyId'));
      copyId.type = 'button';
      copyId.addEventListener('click', function () {
        copyText(String(o.id), copyId, t('browse.copyId'), t('browse.copied'));
      });
      tail.appendChild(copyId);

      // Only a live file can be shared: a replaced version may already have had its bytes reclaimed, so
      // offering a link to it would promise a download that cannot happen. And a file whose bytes the server
      // has confirmed are gone is not shareable either, for the same reason.
      if (o.live && o.bytesPresent !== false) {
        var download = node('a', 'ghost small', t('files.download'));
        download.href = '/api/files/download?id=' + o.id;
        tail.appendChild(download);
        var direct = node('button', 'ghost small', t('files.direct'));
        direct.type = 'button';
        direct.addEventListener('click', function () {
          direct.disabled = true;
          api('/api/file-links', { method: 'POST', body: JSON.stringify({ objectId: o.id }) }).then(function (r) {
            direct.disabled = false;
            if (!r.ok) { alert(r.body.error || t('shares.failed')); return; }
            var link = node('input', 'share-link');
            link.readOnly = true;
            link.value = r.body.link.url;
            link.setAttribute('aria-label', t('files.direct'));
            li.appendChild(link);
            copyText(r.body.link.url, direct, t('files.direct'), t('browse.copied'));
            loadDirectLinks();
          });
        });
        tail.appendChild(direct);
        var remove = node('button', 'ghost small', t('files.delete'));
        remove.type = 'button';
        remove.addEventListener('click', function () {
          if (!confirm(t('files.deleteConfirm').replace('{path}', o.path))) return;
          remove.disabled = true;
          api('/api/files/delete', { method: 'POST', body: JSON.stringify({ id: o.id }) }).then(function (r) {
            remove.disabled = false;
            if (!r.ok) { alert(r.body.error || t('shares.failed')); return; }
            loadObjects(); loadUsage(); loadDirectLinks(); loadShares();
          });
        });
        tail.appendChild(remove);
        var share = node('button', 'ghost small', t('browse.share'));
        share.type = 'button';
        share.addEventListener('click', function () {
          selectView('links');
          $('s-search').value = '';
          loadShareFiles(o).then(function () { $('s-password').focus(); });
        });
        tail.appendChild(share);

        var imp = node('button', 'ghost small', o.important ? t('browse.unprotect') : t('browse.protect'));
        imp.type = 'button';
        imp.addEventListener('click', function () {
          mutate(imp, '/api/objects/importance', { id: o.id, important: !o.important }, function () { loadObjects(); loadUsage(); }, li);
        });
        tail.appendChild(imp);
      }

      li.appendChild(tail);
      list.appendChild(li);
    });

    // Offered only when there is more, so a control that does nothing is never on screen. The count of rows
    // actually rendered is what makes this correct after a page that came back short.
    var existing = $('objectlist').parentNode.querySelector('#browseMore');
    if (existing) existing.remove();
    if (total !== undefined && shown < total) {
      var more = node('div', 'actions');
      more.id = 'browseMore';
      var moreBtn = node('button', 'quiet', t('browse.loadMore'));
      moreBtn.type = 'button';
      moreBtn.addEventListener('click', function () {
        moreBtn.disabled = true;
        // The offset is the number of rows already loaded, not the page number: the two differ as soon as a page
        // comes back short, and using the page number would then skip rows.
        browseState.skipped = shown;
        loadObjects(true);
      });
      more.appendChild(moreBtn);
      host.parentNode.insertBefore(more, host.nextSibling);
    }
  }

  /** Copies text, falling back to a hidden selection where the clipboard API is unavailable. */
  function copyText(value, button, label, done) {
    button.disabled = true;
    function legacyCopy() {
      var scratch = node('textarea'); scratch.value = value; document.body.appendChild(scratch); scratch.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (error) {}
      scratch.remove(); return copied;
    }
    var attempt = navigator.clipboard ? navigator.clipboard.writeText(value).then(function () { return true; }, legacyCopy) : Promise.resolve(legacyCopy());
    return attempt.then(function (copied) {
      button.disabled = false;
      if (copied) {
        button.textContent = done;
        setTimeout(function () { button.textContent = label; }, 1200);
      } else {
        var existing = button.parentNode.querySelector('.manual-copy');
        if (!existing) { existing = node('input', 'manual-copy'); existing.readOnly = true; button.parentNode.appendChild(existing); }
        existing.value = value; existing.setAttribute('aria-label', t('ui.copyManual')); existing.focus(); existing.select();
        button.textContent = label; button.title = t('ui.copyManual');
      }
      return copied;
    });
  }
  function loadObjects(append) {
    var query = [];
    if (browseState.search) query.push('q=' + encodeURIComponent(browseState.search));
    if (browseState.host) query.push('host=' + encodeURIComponent(browseState.host));
    query.push('sort=' + encodeURIComponent(browseState.sort));
    if (browseState.history) query.push('history=1');
    query.push('verify=1', 'limit=' + browseState.limit);
    if (append && browseState.skipped) query.push('offset=' + browseState.skipped);
    return loadSection('objectlist', '/api/objects?' + query.join('&'), function (body) {
      renderObjects(body.objects || [], body.total, body.limit, append === true);
    }, function () { loadObjects(append); }, append === true);
  }
  /** Fills the machine filter from the machines that exist, so it cannot offer one that does not. */
  function fillHostFilter(hosts) {
    hosts = hosts.concat([{ id: '@uploads', label: t('files.uploaded') }, { id: '@derived', label: t('merges.title') }]);
    var select = $('b-host');
    var current = select.value;
    clear(select);

    var any = node('option', null, t('browse.anyMachine'));
    any.value = '';
    select.appendChild(any);

    hosts.forEach(function (h) {
      var option = node('option', null, h.label || h.id);
      option.value = h.id;
      select.appendChild(option);
    });

    // Restored after rebuilding, or a refresh would silently reset the filter to "any" and the list would
    // appear to ignore what was selected.
    select.value = hosts.some(function (h) { return h.id === current; }) ? current : '';
    browseState.host = select.value;
  }

  // --- shared links --------------------------------------------------------------------------
  /** Formats a byte count for a human. Powers of 1024, because that is what storage is sold in. */
  function bytes(n) {
    if (!n) return '0 B';
    var units = ['B', 'KiB', 'MiB', 'GiB'];
    var i = 0;
    var value = n;
    while (value >= 1024 && i < units.length - 1) { value = value / 1024; i++; }
    return (i === 0 ? value : value.toFixed(value < 10 ? 2 : 1)) + ' ' + units[i];
  }

  /** "in 2 hours" / "3 minutes ago", so a lifetime is readable without arithmetic. */
  function until(iso) {
    var ms = Date.parse(iso) - Date.now();
    var past = ms < 0;
    var secs = Math.abs(ms) / 1000;
    var text;
    if (secs < 90) text = Math.round(secs) + 's';
    else if (secs < 5400) text = Math.round(secs / 60) + 'm';
    else if (secs < 172800) text = Math.round(secs / 3600) + 'h';
    else text = Math.round(secs / 86400) + 'd';
    return past ? t('shares.ago').replace('{v}', text) : t('shares.in').replace('{v}', text);
  }

  /**
   * How long ago a moment was, from an ISO string. Always in the past, so no direction is needed.
   *
   * Returns null rather than a guess when the value is missing or unparseable. A file whose modification time
   * the machine did not report must say nothing about it, which is different from saying "1970" or "just now" —
   * both would be inventions, and the second is the more dangerous because it looks current.
   */
  function agoIso(iso) {
    if (!iso) return null;
    var at = Date.parse(iso);
    if (!isFinite(at)) return null;
    return ago((Date.now() - at) / 1000);
  }

  /**
   * The machine's own modification time, in seconds, as an age.
   *
   * A SEPARATE function from the one above because the units differ and mixing them is exactly the defect this
   * project's spec names: the machine reports whole SECONDS, while every timestamp the store writes is ISO
   * milliseconds. Passing one where the other is expected is off by a factor of a thousand, which reads as a
   * date in 1970 rather than as an error — so the conversion lives here, in one place, with the unit in its name.
   */
  function agoMachineSeconds(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return null;
    return ago(Date.now() / 1000 - seconds);
  }

  /**
   * Shows the link the moment it is created.
   *
   * The password is shown alongside it only here, and only because the operator just typed it: it cannot
   * be read back from the server, which is the point. Saying that plainly is better than a bare link that
   * looks like it will still be recoverable later.
   */
  function renderShareResult(share, password) {
    var host = $('shareResult');
    clear(host);
    if (!share) return;

    var box = node('div', 'share-made');
    box.appendChild(node('p', 'share-made-title', t('shares.made')));

    var link = node('input', 'share-link');
    link.readOnly = true;
    link.value = share.url;
    link.setAttribute('aria-label', t('shares.linkLabel'));
    box.appendChild(link);

    var copy = node('button', 'ghost small', t('shares.copy'));
    copy.type = 'button';
    copy.addEventListener('click', function () {
      link.select();
      // The clipboard API is unavailable on plain HTTP, which a self-hosted deployment may well be, so
      // the selection above is the fallback rather than an error the operator has to interpret.
      copyText(share.url, copy, t('shares.copy'), t('shares.copied'));
    });

    var row = node('div', 'share-made-row');
    row.appendChild(copy);
    row.appendChild(chip(until(share.expiresAt), 'quiet'));
    if (share.hasPassword) row.appendChild(chip(t('shares.protected'), 'ok'));
    box.appendChild(row);

    if (password) {
      var note = node('p', 'hint');
      note.textContent = t('shares.passwordOnce').replace('{v}', password);
      box.appendChild(note);
    }
    host.appendChild(box);
  }

  function renderShares(shares) {
    var host = $('sharelist');
    clear(host);
    if (!shares.length) {
      var empty = node('div', 'empty');
      empty.appendChild(node('p', 'empty-line', t('shares.empty')));
      empty.appendChild(node('p', 'hint', t('shares.emptyHint')));
      host.appendChild(empty);
      return;
    }

    var list = node('ul', 'rules-list');
    shares.forEach(function (s) {
      var li = node('li', 'rule');

      var label = node('div', 'share-target');
      label.appendChild(node('code', 'pattern', s.path));
      label.appendChild(node('span', 'share-size', bytes(s.sizeBytes)));
      li.appendChild(label);

      li.appendChild(chip(s.active ? until(s.expiresAt) : (s.revokedAt ? t('shares.revoked') : t('shares.expired')), s.active ? 'quiet' : 'warn'));
      if (s.hasPassword) li.appendChild(chip(t('shares.protected'), 'ok'));
      if (s.useCount) li.appendChild(chip(t('shares.downloads').replace('{n}', s.useCount), 'quiet'));

      var tail = node('div', 'rule-tail');
      if (s.active) {
        var copyBtn = node('button', 'ghost small', t('shares.copy'));
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', function () {
          var url = location.origin + '/s/' + s.token;
          copyText(url, copyBtn, t('shares.copy'), t('shares.copied'));
        });
        tail.appendChild(copyBtn);

        var revoke = node('button', 'ghost small', t('shares.revoke'));
        revoke.type = 'button';
        revoke.addEventListener('click', function () {
          mutate(revoke, '/api/shares/revoke', { token: s.token }, loadShares, li);
        });
        tail.appendChild(revoke);
      }

      li.appendChild(tail);
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  function loadShares() {
    return loadSection('sharelist', '/api/shares', function (body) { renderShares(body.shares || []); }, loadShares);
  }
  function loadDirectLinks() {
    return loadSection('directLinks', '/api/file-links', function (body) {
      var host = $('directLinks'); clear(host);
      if (!(body.links || []).length) host.appendChild(node('p', 'hint', t('ui.linksEmpty')));
      (body.links || []).forEach(function (link) {
        var row = node('div', 'share-made');
        row.appendChild(node('code', 'pattern', link.host_id + ':' + link.path));
        if (link.revoked_at) { row.appendChild(chip(t('shares.revoked'), 'warn')); }
        else {
          var input = node('input', 'share-link'); input.readOnly = true; input.value = link.url;
          input.setAttribute('aria-label', t('files.direct'));
          row.appendChild(input);
          var copy = node('button', 'ghost small', t('shares.copy')); copy.type = 'button';
          copy.addEventListener('click', function () { copyText(link.url, copy, t('shares.copy'), t('browse.copied')); });
          row.appendChild(copy);
          var revoke = node('button', 'ghost small', t('shares.revoke')); revoke.type = 'button';
          revoke.addEventListener('click', function () {
            revoke.disabled = true;
            api('/api/file-links/revoke', { method: 'POST', body: JSON.stringify({ token: link.token }) }).then(function (result) {
              if (!result.ok) { revoke.disabled = false; alert(result.body.error || t('shares.failed')); return; }
              loadDirectLinks();
            });
          });
          row.appendChild(revoke);
        }
        host.appendChild(row);
      });
    }, loadDirectLinks);
  }

  // --- collection history --------------------------------------------------------------------
  /**
   * The outcome of a run, as a word rather than as its counts.
   *
   * Unfinished is deliberately not called a failure: it means the run stopped part way, which is a
   * different thing from one that ran and had problems, and only one of them is expected to fix itself.
   */
  function outcomeChip(outcome) {
    if (outcome === 'success') return chip(t('runs.ok'), 'ok');
    if (outcome === 'problems') return chip(t('runs.problems'), 'warn');
    return chip(t('runs.unfinished'), 'warn');
  }

  /** A duration as something readable, or nothing at all when the run never finished. */
  function duration(seconds) {
    if (seconds === null || seconds === undefined) return t('runs.noDuration');
    if (seconds < 90) return seconds + 's';
    if (seconds < 5400) return Math.round(seconds / 60) + 'm';
    return Math.round(seconds / 3600) + 'h';
  }

  function renderRuns(runs) {
    var host = $('runlist');
    clear(host);

    if (!runs.length) {
      var empty = node('div', 'empty');
      empty.appendChild(node('p', 'empty-line', t('runs.empty')));
      empty.appendChild(node('p', 'hint', t('runs.emptyHint')));
      host.appendChild(empty);
      return;
    }

    var list = node('ul', 'rules-list');
    runs.forEach(function (r) {
      var li = node('li', 'rule');

      var head = node('div', 'share-target');
      head.appendChild(node('code', 'pattern', r.hostId));
      head.appendChild(node('span', 'share-size', duration(r.seconds)));
      li.appendChild(head);

      li.appendChild(outcomeChip(r.outcome));

      // The counts are always shown, including zeros. A run that stored nothing and found nothing is a real
      // answer, and hiding the zeros would make it indistinguishable from a run with no receipt.
      var counts = node('span', 'run-counts');
      counts.textContent = t('runs.counts')
        .replace('{stored}', r.stored)
        .replace('{skipped}', r.skipped)
        .replace('{failed}', r.failed);
      li.appendChild(counts);

      if (r.issueCount) {
        var issueChip = chip(t('runs.issues').replace('{n}', r.issueCount), 'warn');
        li.appendChild(issueChip);
      }

      var tail = node('div', 'rule-tail');
      // Only offered when there is something to open: a control that reveals an empty panel reads as broken.
      if (r.issueCount) {
        var open = node('button', 'ghost small', t('runs.showIssues'));
        open.type = 'button';
        open.addEventListener('click', function () { showRunDetail(r.id); });
        tail.appendChild(open);
      }
      li.appendChild(tail);

      list.appendChild(li);
    });
    host.appendChild(list);
  }

  function showRunDetail(runId) {
    var host = $('runlist');
    api('/api/runs/detail?id=' + runId).then(function (r) {
      if (!r.ok) return;
      var run = r.body.run;

      var box = node('div', 'run-detail');
      var title = node('p', 'share-made-title', t('runs.detailTitle').replace('{id}', run.id));
      box.appendChild(title);

      if (run.byKind && Object.keys(run.byKind).length) {
        var kinds = node('div', 'share-made-row');
        Object.keys(run.byKind).sort().forEach(function (kind) {
          // The kind is translated when a translation exists and shown raw when it does not: too_large is a
          // database value, and showing it untranslated beats hiding a kind nobody has written a word for.
          var key = 'runs.kind.' + kind;
          var label = t(key);
          kinds.appendChild(chip(label === key ? kind : label, 'quiet'));
          kinds.appendChild(chip(String(run.byKind[kind]), 'warn'));
        });
        box.appendChild(kinds);
      }

      var list = node('ul', 'rules-list');
      run.issues.forEach(function (issue) {
        var li = node('li', 'rule');
        var target = node('div', 'share-target');
        target.appendChild(node('code', 'pattern', issue.path || issue.hostId));
        li.appendChild(target);

        li.appendChild(chip(issue.deliberate ? t('runs.deliberate') : t('runs.fault'), issue.deliberate ? 'quiet' : 'warn'));
        if (issue.sizeBytes) li.appendChild(chip(bytes(issue.sizeBytes), 'quiet'));

        // The machine's own words, shown as it said them. The whole point of keeping them verbatim is that
        // this line is what someone diagnoses from.
        li.appendChild(node('p', 'hint', issue.reason));
        list.appendChild(li);
      });
      box.appendChild(list);

      var back = node('button', 'ghost small', t('runs.back'));
      back.type = 'button';
      back.addEventListener('click', function () { loadRuns(); });
      box.appendChild(back);

      // Shown under the list rather than replacing it, so the run being examined stays in view.
      clear(host);
      host.appendChild(box);
    });
  }

  function loadRuns() {
    return loadSection('runlist', '/api/runs', function (body) { renderRuns(body.runs || []); }, loadRuns);
  }
  // --- freshness -------------------------------------------------------------------------------
  /**
   * How far behind each machine is, and the worst case.
   *
   * The WORST figure is what is shown prominently, because it is the one that needs acting on: an average hides
   * the machine that is never collected, and that machine is the whole reason an operator looks at this.
   *
   * A machine that has never been collected successfully says so in words rather than showing a duration. Zero
   * would read as "just now", which is the opposite of the truth.
   */
  function renderFreshness(f) {
    var host = $('freshness');
    clear(host);
    if (!f) return;

    var box = node('div', 'freshness');
    if (f.neverCount > 0) {
      box.appendChild(
        node('p', 'hint error', t('fresh.never').replace('{n}', f.neverCount)),
      );
    } else if (f.worstSeconds === null) {
      box.appendChild(node('p', 'hint', t('fresh.noMachines')));
    } else {
      // Compared against the stated target rather than shown alone: "3000 seconds" is fine or alarming
      // depending on what was intended, and the target is the only thing that says which.
      var late = f.worstSeconds > f.targetSeconds;
      box.appendChild(
        node(
          'p',
          late ? 'hint error' : 'hint',
          t('fresh.worst')
            .replace('{behind}', ago(f.worstSeconds))
            .replace('{target}', ago(f.targetSeconds)),
        ),
      );
      if (late) box.appendChild(node('p', 'hint', t('fresh.behind')));
    }

    if (f.machines.length) {
      var list = node('ul', 'rules-list');
      f.machines.forEach(function (m) {
        var li = node('li', 'rule');
        li.appendChild(node('code', 'pattern', m.id));
        if (m.never) {
          li.appendChild(chip(t('fresh.neverOne'), 'warn'));
        } else {
          li.appendChild(chip(ago(m.secondsSinceSuccess), 'quiet'));
        }
        if (m.lastOutcome) {
          li.appendChild(chip(m.lastOutcome.state, m.lastOutcome.state === 'finished' ? 'quiet' : 'warn'));
        }
        list.appendChild(li);
      });
      box.appendChild(list);
    }

    host.appendChild(box);
  }

  /** A duration in seconds, as words rather than a number. Powers of 60, because that is how it is read. */
  function ago(seconds) {
    if (seconds === null || seconds === undefined) return t('fresh.neverOne');
    if (seconds < 90) return t('fresh.seconds').replace('{n}', Math.round(seconds));
    if (seconds < 5400) return t('fresh.minutes').replace('{n}', Math.round(seconds / 60));
    return t('fresh.hours').replace('{n}', (seconds / 3600).toFixed(1));
  }

  function loadFreshness() {
    return loadSection('freshness', '/api/freshness', function (body) { renderFreshness(body); }, loadFreshness);
  }
  // --- data ----------------------------------------------------------------------------------
  function loadStatus() {
    return api('/api/status').then(function (r) {
      renderMeters(r.body);
      renderSetup(r.body);
    });
  }

  // --- storage ---------------------------------------------------------------------------------
  /**
   * How full the store is, and what it will do about it.
   *
   * Three states rather than a percentage alone, because a number does not say what happens next:
   *
   *   - room left: nothing to do, and the figures are for planning.
   *   - full, but reclaimable: the next file will evict unprotected older files, and the operator should know
   *     that BEFORE it happens rather than discovering a file gone.
   *   - full and saturated: every remaining file is protected, so new files are being refused outright. This is
   *     the only case the operator can act on, and the only fix is to unmark something, so it says so.
   */
  function renderUsage(u) {
    var host = $('usage');
    clear(host);
    if (!u) return;
    usageCache = u;
    $('usageSummary').textContent = t('storage.used', { used: bytes(u.totalBytes), total: bytes(u.budgetBytes), percent: ((Number(u.usedFraction) || 0) * 100).toFixed(1) });
    renderUploadQueue();

    var fraction = Math.max(0, Math.min(1, Number(u.usedFraction) || 0));
    var bar = node('div', 'usage-bar');
    var fill = node('div', 'usage-fill' + (fraction >= 0.9 ? ' hot' : fraction >= 0.7 ? ' warm' : ''));
    fill.style.width = (fraction * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', t('storage.title')); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', (fraction * 100).toFixed(1));
    host.appendChild(bar);

    // "12.3 GB of 10 GB" — both figures, because the percentage alone does not tell the operator what a
    // remaining file budget looks like in the units files are measured in.
    host.appendChild(
      node(
        'p',
        'usage-line',
        t('storage.used')
          .replace('{used}', bytes(u.totalBytes))
          .replace('{total}', bytes(u.budgetBytes))
          .replace('{percent}', (fraction * 100).toFixed(1)),
      ),
    );
    host.appendChild(node('p', 'hint', t('storage.remaining').replace('{n}', bytes(u.remainingBytes))));

    // Retained bytes are broken out because they are the part people are surprised by: superseded and
    // soft-deleted files still occupy the bucket and are still charged.
    if (u.retainedBytes > 0) {
      host.appendChild(node('p', 'hint', t('storage.retained').replace('{n}', bytes(u.retainedBytes))));
    }
    if (u.importantBytes > 0) {
      host.appendChild(node('p', 'hint', t('storage.protected').replace('{n}', bytes(u.importantBytes))));
    }

    if (u.saturatedByImportant) {
      // The one state with an action available, so it is stated as an instruction rather than as a reading.
      host.appendChild(node('p', 'hint error', t('storage.saturated')));
    } else if (fraction >= 1) {
      host.appendChild(node('p', 'hint', t('storage.fullReclaimable')));
    }

    // The per-file limit is stated for the same reason as the budget: a limit discovered by having a file
    // refused has already cost the transfer.
    if (u.maxFileBytes) {
      host.appendChild(node('p', 'hint', t('storage.perFile').replace('{n}', bytes(u.maxFileBytes))));
    }
  }

  function loadUsage() {
    return loadSection('usage', '/api/usage', function (body) { renderUsage(body.usage); }, loadUsage);
  }
  function loadHosts() {
    hostsLoaded = false; updateActions();
    return loadSection('hostlist', '/api/hosts', function (body) {
      hostsLoaded = true; renderHosts(body.hosts || []); fillHostFilter(body.hosts || []); updateActions();
    }, loadHosts).then(function (body) { if (body === null) { hostCache = []; updateActions(); } });
  }
  function loadRules() {
    return loadSection('rulelist', '/api/rules', function (body) { renderRules(body.rules || []); }, loadRules);
  }
  // --- combined files --------------------------------------------------------------------------
  /**
   * The patterns, one per line.
   *
   * A textarea rather than a repeatable row of inputs, because the common case is two to five paths pasted from
   * wherever they were decided, and a control that requires a click per line makes that case the awkward one.
   * A "host:pattern" prefix narrows a line to one machine, which is how the same path on several machines is
   * distinguished — the case this feature exists for.
   *
   * No backticks anywhere in this file's script body: it is emitted verbatim inside an outer template literal, so
   * one would end that literal early. The guard that catches this has now fired four times in this project.
   */
  function mergePatterns() {
    /* \\n, NOT \n. This script body is emitted inside an outer template literal, so the WORKER evaluates the
       escape before the browser ever sees it: a single backslash-n arrives as a real line break inside a string
       literal, which is a syntax error — and because the whole client script is one block it stops EVERYTHING:
       no dialogs, no data, no styling applied by script. That is exactly how this line broke the live page.
       The guard's quote-tracking check missed it, which is why that check now also PARSES the emitted script. */
    return $('m-patterns').value.split('\\n').map(function (line) {
      return line.trim();
    }).filter(function (line) {
      return line.length > 0;
    }).map(function (line) {
      var colon = line.indexOf(':');
      // Only a leading "name:" is treated as a machine, and only when the rest still looks like a path: a
      // Windows-style drive path such as "C:/..." is not a machine selector, and neither is a line with no colon.
      if (colon > 0 && line.charAt(colon + 1) === '/') {
        return { hostId: line.slice(0, colon), pattern: line.slice(colon + 1) };
      }
      return { pattern: line };
    });
  }

  function mergeDefinition() {
    return {
      outputName: $('m-name').value.trim(),
      combination: $('m-combination').value,
      sources: mergePatterns()
    };
  }

  /**
   * Renders the preview.
   *
   * The per-pattern counts are the point of this panel rather than a detail: a structured merge that removed no
   * duplicates and one that did nothing at all produce the same file, and the pattern that matched zero stored
   * objects is the usual reason. Saying so here is what turns "it did nothing" into "this line is wrong".
   */
  function renderMergePreview(p) {
    var host = $('mergePreview');
    clear(host);
    if (!p) return;

    var box = node('div', p.ok ? 'merge-preview' : 'merge-preview bad');
    if (!p.ok) {
      box.appendChild(node('p', 'feedback bad', p.problem || t('merges.failed')));
    } else {
      var line = t('merges.willCombine')
        .replace('{n}', p.sourceCount)
        .replace('{bytes}', bytes(p.sourceBytes))
        .replace('{out}', p.bytes === undefined ? '?' : bytes(p.bytes));
      box.appendChild(node('p', 'hint', line));
    }

    (p.perPattern || []).forEach(function (entry) {
      var row = node('div', 'merge-pattern');
      row.appendChild(node('code', 'pattern', (entry.hostId ? entry.hostId + ':' : '') + entry.pattern));
      // A pattern matching nothing is called out rather than shown as a zero among counts, because it is the one
      // that explains a result the operator did not expect.
      row.appendChild(chip(entry.matched === 0 ? t('merges.matchedNothing') : t('merges.matched').replace('{n}', entry.matched), entry.matched === 0 ? 'warn' : 'quiet'));
      box.appendChild(row);
    });

    if (p.sources && p.sources.length) {
      var sources = node('ul', 'source-check');
      p.sources.forEach(function (source) { sources.appendChild(node('li', 'pattern', source)); });
      box.appendChild(sources);
    }
    if (p.notes && p.notes.length) {
      p.notes.forEach(function (note) { box.appendChild(node('p', 'hint', note)); });
    }

    host.appendChild(box);
  }

  function renderMerges(rules) {
    var host = $('mergelist');
    clear(host);
    if (!rules.length) {
      var empty = node('div', 'empty');
      empty.appendChild(node('p', 'empty-line', t('merges.empty')));
      empty.appendChild(node('p', 'hint', t('merges.emptyHint')));
      host.appendChild(empty);
      return;
    }

    var list = node('ul', 'rules-list');
    rules.forEach(function (m) {
      var li = node('li', 'rule');

      var head = node('div', 'merge-head');
      head.appendChild(node('code', 'pattern', m.outputName));
      li.appendChild(head);

      // Three states, and the distinction is the useful part: never built means "run it", stale means "run it
      // again", current means "leave it". Collapsing them would make the panel tell the operator to act when
      // there is nothing to do, or to relax when there is.
      if (m.current === null) {
        li.appendChild(chip(t('merges.notBuilt'), 'quiet'));
      } else if (m.current === true) {
        li.appendChild(chip(t('merges.current'), 'ok'));
      } else {
        li.appendChild(chip(t('merges.stale'), 'warn'));
      }

      if (m.builtAt) li.appendChild(chip(until(m.builtAt), 'quiet'));
      if (m.sourceCount !== undefined) li.appendChild(chip(t('merges.sources').replace('{n}', m.sourceCount), 'quiet'));
      if (m.sizeBytes) li.appendChild(chip(bytes(m.sizeBytes), 'quiet'));

      if (m.sources && m.sources.length) {
        // Shown as a hint rather than a list: the question "what is this built from" is asked occasionally, and
        // the question "is it current" every time.
        li.appendChild(node('p', 'hint', m.sources.map(function (s) { return s.hostId + ':' + s.path; }).join(', ')));
      }

      var tail = node('div', 'rule-tail');
      var run = node('button', 'ghost small', t('merges.run'));
      run.type = 'button';
      run.addEventListener('click', function () {
        run.disabled = true;
        api('/api/derived/run', { method: 'POST', body: JSON.stringify({ id: m.ruleId }) }).then(function (r) {
          run.disabled = false;
          if (!r.ok || !r.body.ok) {
            feedback('mergePreview', r.body.error || t('merges.failed'), true);
          } else {
            feedback('mergePreview', t('merges.built').replace('{bytes}', bytes(r.body.bytes)), false);
          }
          loadMerges(); loadObjects(); loadUsage(); loadShareFiles();
        });
      });
      tail.appendChild(run);
      if (m.objectId) {
        var download = node('a', 'ghost small', t('files.download'));
        download.href = '/api/files/download?id=' + m.objectId;
        tail.appendChild(download);
      }

      var del = node('button', 'ghost small', t('merges.forget'));
      del.type = 'button';
      del.addEventListener('click', function () {
        mutate(del, '/api/derived/delete', { id: m.ruleId }, loadMerges, li);
      });
      tail.appendChild(del);

      li.appendChild(tail);
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  function loadMerges() {
    return loadSection('mergelist', '/api/derived/status', function (body) { renderMerges(body.rules || []); }, loadMerges);
  }
  function refreshAll() {
    applyStaticText();
    renderLangSwitch();
    renderThemeSwitch();
    if (authMode !== 'in') return;
    loadStatus();
    loadUsage();
    loadHosts();
    loadRules();
    loadShares();
    loadDirectLinks();
    loadObjects();
    loadRuns();
    loadFreshness();
    loadMerges();
    loadShareFiles();
    renderUploadQueue();
    selectView(currentView);
  }

  ${WORKFLOW_SCRIPT}

  // --- events --------------------------------------------------------------------------------
  // Search is debounced: a keystroke-per-request would fire a query for every prefix of what is being typed,
  // and the responses can arrive out of order, so the list would briefly show results for a prefix.
  var searchTimer = null;
  // Every filter change goes back to the FIRST page. Leaving the offset where it was would page through the
  // previous query's rows, so narrowing a search would show results from before it was narrowed — and the
  // "load more" control would be paging a list that no longer exists.
  $('b-search').addEventListener('input', function () {
    var value = $('b-search').value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      browseState.search = value.trim();
      browseState.skipped = 0;
      loadObjects();
    }, 250);
  });

  $('b-host').addEventListener('change', function () {
    browseState.host = $('b-host').value;
    browseState.skipped = 0;
    loadObjects();
  });

  $('b-sort').addEventListener('change', function () {
    browseState.sort = $('b-sort').value;
    browseState.skipped = 0;
    loadObjects();
  });

  $('b-history').addEventListener('change', function () {
    browseState.history = $('b-history').checked;
    browseState.skipped = 0;
    loadObjects();
  });

  $('collectNow').addEventListener('click', function () {
    if (collectBusy || $('collectNow').disabled) return;
    collectBusy = true; updateActions(); feedback('collectResult', t('ui.collectWorking'), false);
    api('/api/collect', { method: 'POST' }).then(function (result) {
      collectBusy = false; updateActions(); showCollection(result);
    });
  });
  $('makeShare').addEventListener('click', function () {
    var button = $('makeShare');
    var objectId = Number($('s-object').value);
    var password = $('s-password').value;

    if (!password || password.length < 8 || password.length > 1024) {
      clear($('shareResult'));
      $('shareResult').appendChild(node('p', 'hint error', t('files.needPassword')));
      return;
    }

    if (!objectId) {
      renderShareResult(null);
      var hint = $('shareResult');
      clear(hint);
      hint.appendChild(node('p', 'hint error', t('shares.needId')));
      return;
    }

    if (shareBusy || !selectedShareFile || selectedShareFile.id !== objectId) return;
    shareBusy = true; updateActions();
    var payload = { objectId: objectId, seconds: Number($('s-seconds').value) };
    // Omitted entirely when blank, so "no password" and "empty password" stay different requests. An empty
    // one is refused by the server, which is right: a share that only looks protected is worse than an open
    // one, because the operator would believe otherwise.
    if (password) payload.password = password;

    api('/api/shares', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      shareBusy = false; updateActions();
      if (!r.ok) {
        clear($('shareResult'));
        $('shareResult').appendChild(node('p', 'hint error', r.body.error || t('shares.failed')));
        return;
      }
      $('s-password').value = ''; updateActions();
      renderShareResult(r.body.share, password);
      loadShares();
    });
  });

  $('uploadFiles').addEventListener('click', function () { uploadSelected(false); });
  $('profilePreset').addEventListener('click', function () {
    $('m-name').value = 'merged-all.yaml';
    $('m-combination').value = 'proxy-profile';
    $('m-patterns').value = ['bytevirt.yaml', 'dartnode.yaml', 'rabisu.yaml', '56idc.yaml', 'yinyun.yaml',
      'racknerd.23.254.219.147.yaml', 'racknerd.192.119.78.227.yaml', 'racknerd.107.172.99.23.yaml'].map(function (name) { return '/' + name; }).join('\\n');
    mergeEdited(); checkPresetSources(); $('m-patterns').focus();
  });

  $('previewMerge').addEventListener('click', function () {
    var button = $('previewMerge');
    var definition = mergeDefinition();

    // Checked here rather than only at the server so the common mistake — pressing Preview with nothing filled in
    // — is answered next to the button instead of after a round trip.
    if (!definition.sources.length) {
      clear($('mergePreview'));
      $('mergePreview').appendChild(node('p', 'hint error', t('merges.needPattern')));
      return;
    }

    if ($('mergePreview').getAttribute('aria-busy') === 'true') return;
    var snapshot = JSON.stringify(definition);
    $('mergePreview').setAttribute('aria-busy', 'true'); updateActions();
    // The UNSAVED definition is previewed, which is what makes this useful before committing to a rule.
    api('/api/derived/preview', { method: 'POST', body: JSON.stringify(definition) }).then(function (r) {
      $('mergePreview').setAttribute('aria-busy', 'false');
      if (snapshot !== JSON.stringify(mergeDefinition())) { updateActions(); return; }
      verifiedMerge = r.ok && r.body.preview && r.body.preview.ok ? snapshot : null;
      updateActions();
      if (!r.ok) {
        clear($('mergePreview'));
        $('mergePreview').appendChild(node('p', 'hint error', r.body.error || t('merges.failed')));
        return;
      }
      renderMergePreview(r.body.preview);
    });
  });

  $('saveMerge').addEventListener('click', function () {
    var button = $('saveMerge');
    var definition = mergeDefinition();
    if (verifiedMerge !== JSON.stringify(definition) || button.getAttribute('aria-busy') === 'true') return;

    if (!definition.outputName) {
      clear($('mergePreview'));
      $('mergePreview').appendChild(node('p', 'hint error', t('merges.needName')));
      return;
    }
    if (!definition.sources.length) {
      clear($('mergePreview'));
      $('mergePreview').appendChild(node('p', 'hint error', t('merges.needPattern')));
      return;
    }

    button.setAttribute('aria-busy', 'true'); updateActions();
    api('/api/derived', { method: 'POST', body: JSON.stringify(definition) }).then(function (r) {
      button.setAttribute('aria-busy', 'false'); updateActions();
      if (!r.ok) {
        clear($('mergePreview'));
        // A refused rule says why, and the cycle refusal is the one worth reading closely: it names the rules
        // involved, which is more useful than "invalid".
        $('mergePreview').appendChild(node('p', 'hint error', r.body.error || t('merges.failed')));
        return;
      }
      feedback('mergePreview', t('ui.mergeSaved'), false);
      loadMerges();
    });
  });

  $('addToggle').addEventListener('click', function () {
    var form = $('hostform');
    hostFormOpen = !hostFormOpen; selectView('hosts');
    if (!form.hidden) $('f-label').focus();
  });

  $('cancelHost').addEventListener('click', function () { hostFormOpen = false; $('hostform').hidden = true; });

  /** Which credential the form is currently offering. */
  function credentialMode() { return $('m-key').checked ? 'key' : 'password'; }

  function setAuthMode(mode) {
    var isKey = mode === 'key';
    $('mode-password').hidden = isKey;
    $('mode-key').hidden = !isKey;
    // Leaving the password field populated while it is hidden would submit a credential under a mode
    // the operator is not looking at, so it is cleared on the way out. The key fields are left alone
    // on purpose: toggling to check something and back would otherwise lose a pasted key.
    if (isKey) $('f-password').value = '';
  }

  /** Inline feedback beside the button that was pressed, rather than only in the result panel. */
  function formMessage(kind, text) {
    var box = $('formmsg');
    box.hidden = false;
    box.className = 'formmsg ' + kind;
    box.textContent = text;
  }

  function clearFormMessage() { var box = $('formmsg'); box.hidden = true; box.textContent = ''; box.className = 'formmsg'; }

  $('m-password').addEventListener('change', function () { setAuthMode('password'); clearFormMessage(); });
  $('m-key').addEventListener('change', function () { setAuthMode('key'); clearFormMessage(); });

  $('saveHost').addEventListener('click', function () {
    clearFormMessage();

    var address = $('f-address').value.trim();
    var username = $('f-username').value.trim();
    var mode = credentialMode();

    // Checked here so the answer lands directly under the button. The server validates the same
    // things, but its message goes to the result panel further down the page, which is what made a
    // rejected save read as "the button does nothing".
    if (!address) return formMessage('err', t('form.needAddress'));
    if (!username) return formMessage('err', t('form.needUsername'));
    if (mode === 'password' && !$('f-password').value) return formMessage('err', t('form.needPassword'));
    if (mode === 'key' && !$('f-key').value.trim()) return formMessage('err', t('form.needKey'));

    // Only the chosen method is sent: storing an unused second credential against the host would be
    // a liability with no purpose, and an empty string means "keep the stored value" server-side.
    var payload = {
      label: $('f-label').value,
      address: address,
      port: Number($('f-port').value || 22),
      username: username,
      password: mode === 'password' ? $('f-password').value : '',
      privateKey: mode === 'key' ? $('f-key').value : '',
      privateKeyPassphrase: mode === 'key' ? $('f-passphrase').value : ''
    };

    var button = $('saveHost');
    button.disabled = true;
    formMessage('busy', t('form.saving'));

    api('/api/hosts', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      button.disabled = false;
      var ok = !!(r.ok && r.body && r.body.ok);
      showRaw(ok ? t('form.saved') : t('result.failed'), r.body);
      if (!ok) {
        var detail = (r.body && (r.body.error || r.body.raw)) || t('result.unknownError');
        return formMessage('err', t('form.saveFailed', { detail: detail }));
      }
      // Nothing sensitive should linger in the DOM after a save.
      $('f-password').value = '';
      $('f-key').value = '';
      $('f-passphrase').value = '';
      // The form stays open with the message visible. Hiding it, as this used to, would hide the very
      // confirmation that was just added - and adding a second host is the common next action.
      formMessage('ok', t('form.saved'));
      refreshAll();
    });
  });

  $('saveRule').addEventListener('click', function () {
    var payload = {
      pattern: $('r-pattern').value,
      hostId: $('r-scope').value || null,
      isExclude: $('r-kind').value === 'exclude'
    };
    api('/api/rules', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      if (r.ok && r.body.ok) { $('r-pattern').value = ''; loadRules(); }
      else showRaw(t('result.failed'), r.body);
    });
  });

  // Boot order matters: the chrome is filled in first so the language and appearance controls work
  // even on the gate, then authentication decides whether the management panels load at all.
  applyStaticText();
  renderLangSwitch();
  renderThemeSwitch();
  authState();

  // --- layout diagnostic ---------------------------------------------------------------------
  // ?debug=layout lists every element wider than the viewport. A horizontal overflow at a narrow
  // width is otherwise very hard to attribute: the visible symptom is text clipped at the right
  // edge, and the cause is whatever single box refused to shrink. This names that box, including
  // its client and scroll widths, so the fix targets a measurement rather than a guess.
  try {
    if (new URLSearchParams(location.search).get('debug') === 'layout') {
      setTimeout(function () {
        var vw = document.documentElement.clientWidth;
        var rows = [];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var n = all[i];
          var w = n.getBoundingClientRect().width;
          if (w > vw + 1) {
            rows.push({
              tag: n.tagName.toLowerCase(),
              cls: n.className ? String(n.className).slice(0, 40) : '',
              width: Math.round(w),
              scroll: n.scrollWidth,
              client: n.clientWidth
            });
          }
        }
        rows.sort(function (a, b) { return b.width - a.width; });
        var pre = document.createElement('pre');
        pre.id = 'layout-debug';
        /* Doubled for the same reason as mergePatterns: one layer of escaping is consumed by the outer template
           literal. Written with a single backslash it reaches the browser as a literal backslash and an n, so the
           debug panel would print the escape instead of breaking the line — wrong, but only cosmetically, which is
           why it survived until the mechanism was understood. */
        pre.textContent = 'viewport ' + vw + '\\n' + rows.slice(0, 25).map(function (r) {
          return r.tag + '.' + r.cls + '  rect=' + r.width + ' scroll=' + r.scroll + ' client=' + r.client;
        }).join('\\n');
        pre.style.cssText = 'position:fixed;left:0;top:0;z-index:999;background:#000;color:#0f0;font:11px monospace;padding:8px;max-width:100%;overflow:auto';
        document.body.appendChild(pre);
        document.title = 'OVERFLOW ' + (rows.length ? rows[0].tag + '.' + rows[0].cls + ' ' + rows[0].width + 'px' : 'none') + ' / vw ' + vw;
      }, 120);
    }
  } catch (e) {}
})();
</script>
</body>
</html>`;
}

/**
 * The four interface languages.
 *
 * Flat keys, one table per locale, and every locale carries every key — a missing string would
 * otherwise fall back to English mid-sentence, which is worse than a slightly awkward translation.
 * `{name}` placeholders are filled by the client-side `t()`.
 */
function translationsLiteral(): string {
	const table: Record<Locale, Record<string, string>> = {
		en: {
			'files.upload': 'Upload files to R2',
			'files.uploadAction': 'Upload selected files',
			'files.uploadDone': 'Uploaded',
			'files.uploaded': 'Uploaded files',
			'files.download': 'Download',
			'files.direct': 'Get direct link',
			'files.directTitle': 'Direct download links',
			'files.directHint': 'Anyone with a direct link can download the latest version. Revoke it here to stop access.',
			'files.delete': 'Delete file',
			'files.deleteConfirm': 'Delete {path} from R2? Its downloads and shares will stop working.',
			'files.sharePassword': 'Sharing password (8–1024 characters)',
			'files.needPassword': 'Enter a sharing password of 8–1024 characters.',
			'files.profile': 'merged-all.yaml profile (8 providers)',
			'files.profilePreset': 'Use merged-all preset',
			'skip': 'Skip to content',
			'status.key': 'signing key',
			'status.schema': 'tables',
			'status.storage': 'storage',
			'setup.title': 'Before this works',
			'setup.key': 'Set a signing key. It is the only secret this deployment needs; host credentials are encrypted with it before they reach the database.',
			'setup.generate': 'Generate a key',
			'setup.keyValue': 'Signing key',
			'setup.keyWarning': 'This is shown once and stored nowhere. Replacing an existing key does not re-encrypt anything, so every stored credential becomes unreadable.',
			'setup.keyStatus': 'Current state: {status}',
			'setup.schema': 'Create the tables. Missing: {missing}',
			'setup.apply': 'Create tables',
			'setup.applied': 'Tables created',
			'hosts.title': 'Hosts',
			'hosts.lede': 'Machines this Worker reaches over SSH. Nothing is installed on them.',
			'hosts.add': 'Add a host',
			'hosts.empty': 'No machines yet.',
			'hosts.emptyHint': 'Add one to collect files from it.',
			'hosts.enabled': 'active',
			'hosts.disabled': 'paused',
			'hosts.password': 'password',
			'hosts.key': 'key',
			'hosts.noCredential': 'no credential',
			'hosts.fingerprint': 'Fingerprint',
			'hosts.test': 'Test',
			'hosts.testing': 'Reaching…',
			'hosts.delete': 'Delete',
			'hosts.confirmDelete': 'Delete {id}? Its collection rules go with it. Files already stored are kept.',
			'form.title': 'Add or update a host',
			'form.label': 'Label',
			'form.address': 'Address',
			'form.port': 'Port',
			'form.username': 'Username',
			'form.authMode': 'Authentication method',
			'form.modePassword': 'Username and password',
			'form.modeKey': 'Username and private key',
			'form.password': 'Password',
			'form.passphrase': 'Key passphrase (optional)',
			'form.privateKey': 'Private key',
			'form.hint': 'Credentials are encrypted in the Worker before they reach the database and are never sent back to this page. Leaving a field empty keeps whatever is already stored.',
			'form.save': 'Save host',
			'form.cancel': 'Cancel',
			'form.saved': 'Host saved',
			'form.saving': 'Saving…',
			'form.needAddress': 'Enter an address before saving.',
			'form.needUsername': 'Enter a username before saving.',
			'form.needPassword': 'Enter a password, or switch to the private key method.',
			'form.needKey': 'Paste a private key, or switch to the password method.',
			'form.saveFailed': 'Not saved: {detail}',
			'form.requestFailed': 'The request never reached the Worker ({detail}). Nothing was changed.',
			'form.requestTimeout': 'The Worker did not answer within {seconds} seconds. Nothing was changed; try again.',
			'rules.title': 'Directories to collect',
			'rules.lede': 'A rule on all machines applies everywhere; a rule on one machine applies only there. Exclusions are checked first.',
			'rules.scope': 'Applies to',
			'rules.allHosts': 'All machines',
			'rules.pattern': 'Pattern',
			'rules.kind': 'Kind',
			'rules.include': 'collect',
			'rules.exclude': 'skip',
			'rules.add': 'Add rule',
			'rules.delete': 'Delete',
			'rules.empty': 'No directories configured.',
			'rules.emptyHint': 'Without at least one rule, nothing is collected.',
			'result.title': 'Connection test',
			'result.empty': 'Test a machine to see what it is, how long each step took, and how your rules land against its real filesystem.',
			'result.ok': 'reached',
			'result.failed': 'Could not reach it',
			'result.unknownError': 'The Worker returned no error message.',
			'result.total': 'Total',
			'result.raw': 'Raw response',
			'result.rules': 'How the rules resolved',
			'result.matches': '{count} file(s) matched',
			'result.needsCollection': 'The directory part contains a wildcard, so this is resolved during collection rather than now.',
			'result.noRules': 'No rules apply to this machine yet.',
			'fact.hostname': 'Hostname',
			'fact.user': 'Signed in as',
			'fact.system': 'System',
			'fact.disk': 'Disk',
			'fact.diskValue': '{free} GB free of {size} GB',
			'theme.auto': 'Follow the device',
			'theme.light': 'Light',
			'auth.setupTitle': 'Choose a password',
			'auth.setupLede': 'This deployment has no password yet. Whoever sets it first controls the interface, so set it now.',
			'auth.setupAction': 'Set password and continue',
			'auth.setupHint': 'At least 12 characters. A phrase you can remember beats a short jumble of symbols.',
			'auth.signInTitle': 'Sign in',
			'auth.signInLede': 'This interface manages stored machine credentials, so it is not open.',
			'auth.signInAction': 'Sign in',
			'auth.password': 'Password',
			'auth.current': 'Current password',
			'auth.failed': 'That did not work.',
			'runs.collectNow': 'Collect now',
			'runs.collectFailed': 'The collection could not be started.',
			'runs.nothingToDo': 'There is no machine to collect. Add one first.',
			'runs.outOfTime': 'There is not enough time left in this run to collect anything.',
			'runs.planOnly': 'Next machine: {host}. Collection itself is not built yet, so nothing has been collected.',
			'runs.resumeFrom': 'It would resume from: {from}',
			'runs.title': 'Collection history',
			'runs.lede': 'What each run did, and anything it could not handle.',
			'runs.ok': 'ok',
			'runs.problems': 'had problems',
			'runs.unfinished': 'stopped early',
			'runs.noDuration': 'no duration',
			'runs.counts': '{stored} stored · {skipped} skipped · {failed} failed',
			'runs.issues': '{n} issue(s)',
			'runs.showIssues': 'Show issues',
			'runs.detailTitle': 'Run {id}: what it could not handle',
			'runs.deliberate': 'skipped on purpose',
			'runs.fault': 'error',
			'runs.back': 'Back to the list',
			'runs.empty': 'Nothing has been collected yet.',
			'runs.emptyHint': 'Runs appear here once a machine has been collected, with anything that went wrong.',
			'runs.kind.too_large': 'too large',
			'runs.kind.capacity': 'no room',
			'runs.kind.error': 'error',
			'runs.kind.excluded': 'excluded',
			'runs.kind.unchanged': 'unchanged',
			'browse.title': 'Stored files',
			'browse.lede': 'Everything collected so far. Search by any part of a path.',
			'browse.search': 'Search',
			'browse.machine': 'Machine',
			'browse.anyMachine': 'Any',
			'browse.sort': 'Sort',
			'browse.newest': 'Newest',
			'browse.oldest': 'Oldest',
			'browse.largest': 'Largest',
			'browse.smallest': 'Smallest',
			'browse.byPath': 'By path',
			'browse.history': 'Include replaced versions',
			'browse.count': '{n} files',
			'browse.showing': 'showing {n} of {total}',
			'browse.empty': 'Nothing collected yet.',
			'browse.emptyHint': 'Add a machine and a directory to collect, then run a collection.',
			'browse.noMatch': 'Nothing matches that.',
			'browse.noMatchHint': 'Try part of a directory name, or clear the filters.',
			'browse.protected': 'important',
			'browse.protect': 'Mark important',
			'browse.unprotect': 'Unmark',
			'browse.replaced': 'replaced',
			'browse.share': 'Share',
			'browse.loadMore': 'Show more',
			'browse.copyPath': 'Copy path',
			'browse.copyId': 'Copy id',
			'browse.copied': 'Copied',
			'browse.gone': 'no longer stored',			'browse.storedAgo': 'stored {v}',
			'browse.seenAgo': 'machine last changed it {v}',

			'storage.title': 'Storage',
			'storage.lede': 'What the store is holding and what it will do when it fills. Protections are honoured before space: a file marked important is never evicted, and if only protected files remain the store refuses new ones rather than deleting one of them.',
			'storage.used': '{used} of {total} used ({percent}%)',
			'storage.remaining': '{n} still free.',
			'storage.retained': '{n} of that is retained: replaced or deleted files whose bytes are still stored, and still counted against the budget.',
			'storage.protected': '{n} is protected from eviction.',
			'storage.saturated': 'The store is full and every remaining file is protected, so new files are being refused. Unmark something, or raise the budget.',
			'storage.fullReclaimable': 'The store is full. The next file will evict the oldest unprotected files to make room.',
			'storage.perFile': 'Any one file may be up to {n}.',
			'fresh.worst': 'The machine collected longest ago was {behind} ago, against a target of {target}.',
			'fresh.behind': 'That is behind the target. A machine is either unreachable or slow enough to be crowding out the others; the history below says which.',
			'fresh.never': '{n} machine(s) have never been collected successfully. Nothing is being kept up to date for them.',
			'fresh.neverOne': 'never collected',
			'fresh.noMachines': 'No machines yet, so there is nothing to keep fresh.',
			'fresh.seconds': '{n}s ago',
			'fresh.minutes': '{n}m ago',
			'fresh.hours': '{n}h ago',



			'shares.title': 'Shared links',
			'shares.lede': 'Hand out a link to one stored file. It stops working on its own, and you can cancel it sooner.',
			'shares.objectId': 'Stored file id',
			'shares.lifetime': 'Lasts',
			'shares.15m': '15 minutes',
			'shares.1h': '1 hour',
			'shares.2h': '2 hours',
			'shares.12h': '12 hours',
			'shares.24h': '24 hours',
			'shares.password': 'Password (optional)',
			'shares.create': 'Create link',
			'shares.needId': 'Enter the id of a stored file first.',
			'shares.failed': 'The link could not be created.',
			'shares.made': 'Link created',
			'shares.copy': 'Copy',
			'shares.copied': 'Copied',
			'shares.linkLabel': 'Share link',
			'shares.protected': 'password',
			'shares.revoke': 'Cancel link',
			'shares.revoked': 'cancelled',
			'shares.expired': 'expired',
			'shares.empty': 'No links yet.',
			'shares.emptyHint': 'A link works for one stored file, for as long as you choose.',
			// This key was missing from English while the other three locales had it, so an operator reading the
			// interface in English saw the literal text `shares.passwordOnce` where this sentence belongs. Found
			// by the translation-completeness check, which exists because a missing key renders as itself: no
			// error, no failing test, and invisible to anyone not reading that language.
			'shares.passwordOnce': 'Password: {v} — shown only now. It cannot be read back from the server, so give it to the recipient along with the link.',
			'shares.downloads': '{n} download(s)',
			'shares.in': 'in {v}',
			'shares.ago': '{v} ago',
			'merges.title': 'Combined files',
			'merges.lede': 'Build one file from several stored ones. A merge is a rule, not a one-off: the result is recorded with what it came from, so you can tell whether it is still current.',
			'merges.outputName': 'Call the result',
			'merges.combination': 'How to combine',
			'merges.union': 'Merge their lists into one document',
			'merges.concat': 'Join them end to end',
			'merges.patterns': 'Which stored files (one pattern per line)',
			'merges.preview': 'Preview',
			'merges.save': 'Save rule',
			'merges.run': 'Build now',
			'merges.forget': 'Forget rule',
			'merges.empty': 'No combined files yet.',
			'merges.emptyHint': 'A rule names stored files by pattern and how to combine them. Preview it first: the preview says how many files each pattern matched, which is the usual reason a merge looks like it did nothing.',
			'merges.current': 'current',
			'merges.stale': 'out of date',
			'merges.notBuilt': 'not built yet',
			'merges.sources': '{n} source(s)',
			'merges.willCombine': 'Would combine {n} file(s), {bytes} in, about {out} out.',
			'merges.matched': '{n} matched',
			'merges.matchedNothing': 'matched nothing',
			'merges.needName': 'Give the result a name first.',
			'merges.needPattern': 'Name at least one stored file, or a pattern that matches some.',
			'merges.failed': 'That did not work.',
			'merges.built': 'Built {bytes}. The result is a stored file like any other, so it can be browsed and shared.',
			'theme.dark': 'Dark',
		},
		'zh-CN': {
			'files.upload': '上传文件到 R2',
			'files.uploadAction': '上传所选文件',
			'files.uploadDone': '已上传',
			'files.uploaded': '上传文件',
			'files.download': '下载',
			'files.direct': '获取直链',
			'files.directTitle': '文件下载直链',
			'files.directHint': '持有直链即可下载文件的最新版本；取消链接后停止访问。',
			'files.delete': '删除文件',
			'files.deleteConfirm': '从 R2 删除 {path}？该文件的下载和分享将失效。',
			'files.sharePassword': '分享密码（8–1024 位）',
			'files.needPassword': '请输入 8–1024 位的分享密码。',
			'files.profile': 'merged-all.yaml 配置（8 个来源）',
			'files.profilePreset': '使用 merged-all 预设',
			'skip': '跳到主要内容',
			'status.key': '签名密钥',
			'status.schema': '数据表',
			'status.storage': '存储',
			'setup.title': '还差几步',
			'setup.key': '设置签名密钥。它是本次部署唯一需要的密钥；主机凭据都会先用它加密再写入数据库。',
			'setup.generate': '生成密钥',
			'setup.keyValue': '签名密钥',
			'setup.keyWarning': '只显示这一次，不会保存在任何地方。替换已有密钥不会重新加密任何数据，因此所有已存凭据都会变得无法读取。',
			'setup.keyStatus': '当前状态：{status}',
			'setup.schema': '创建数据表。缺少：{missing}',
			'setup.apply': '创建数据表',
			'setup.applied': '数据表已创建',
			'hosts.title': '主机',
			'hosts.lede': '这个 Worker 通过 SSH 访问的机器。它们上面不安装任何东西。',
			'hosts.add': '添加主机',
			'hosts.empty': '还没有机器。',
			'hosts.emptyHint': '添加一台即可从它采集文件。',
			'hosts.enabled': '启用',
			'hosts.disabled': '已暂停',
			'hosts.password': '密码',
			'hosts.key': '密钥',
			'hosts.noCredential': '无凭据',
			'hosts.fingerprint': '指纹',
			'hosts.test': '测试',
			'hosts.testing': '连接中…',
			'hosts.delete': '删除',
			'hosts.confirmDelete': '删除 {id}？它的采集规则会一并删除，已存储的文件会保留。',
			'form.title': '添加或更新主机',
			'form.label': '名称',
			'form.address': '地址',
			'form.port': '端口',
			'form.username': '用户名',
			'form.authMode': '认证方式',
			'form.modePassword': '用户名 + 密码',
			'form.modeKey': '用户名 + 私钥',
			'form.password': '密码',
			'form.passphrase': '私钥口令（可留空）',
			'form.privateKey': '私钥',
			'form.hint': '凭据在 Worker 内加密后才写入数据库，并且永远不会回传到本页面。留空表示保留已存储的值。',
			'form.save': '保存主机',
			'form.cancel': '取消',
			'form.saved': '主机已保存',
			'form.saving': '正在保存…',
			'form.needAddress': '请先填写地址。',
			'form.needUsername': '请先填写用户名。',
			'form.needPassword': '请填写密码，或切换到私钥方式。',
			'form.needKey': '请粘贴私钥，或切换到密码方式。',
			'form.saveFailed': '未保存：{detail}',
			'form.requestFailed': '请求没有到达 Worker（{detail}），未做任何改动。',
			'form.requestTimeout': 'Worker 在 {seconds} 秒内没有响应，未做任何改动，请重试。',
			'rules.title': '要采集的目录',
			'rules.lede': '对所有机器生效的规则处处适用；指定机器的规则只在那台生效。排除规则优先判断。',
			'rules.scope': '适用范围',
			'rules.allHosts': '所有机器',
			'rules.pattern': '模式',
			'rules.kind': '类型',
			'rules.include': '采集',
			'rules.exclude': '排除',
			'rules.add': '添加规则',
			'rules.delete': '删除',
			'rules.empty': '还没有配置目录。',
			'rules.emptyHint': '至少需要一条规则，否则不会采集任何文件。',
			'result.title': '连接测试',
			'result.empty': '测试一台机器，可以看到它是什么、每一步耗时多久，以及规则在它真实文件系统上的命中情况。',
			'result.ok': '已连接',
			'result.failed': '无法连接',
			'result.unknownError': 'Worker 没有返回错误信息。',
			'result.total': '合计',
			'result.raw': '原始响应',
			'result.rules': '规则命中情况',
			'result.matches': '命中 {count} 个文件',
			'result.needsCollection': '目录部分含通配符，将在采集阶段解析，而不是现在。',
			'result.noRules': '目前没有规则适用于这台机器。',
			'fact.hostname': '主机名',
			'fact.user': '登录身份',
			'fact.system': '系统',
			'fact.disk': '磁盘',
			'fact.diskValue': '共 {size} GB，可用 {free} GB',
			'theme.auto': '跟随设备',
			'theme.light': '浅色',
			'auth.setupTitle': '设置密码',
			'auth.setupLede': '这个部署还没有密码。谁先设置，谁就掌管这个界面，所以现在就设。',
			'auth.setupAction': '设置密码并继续',
			'auth.setupHint': '至少 12 个字符。一句你能记住的话，比一串短乱的符号更可靠。',
			'auth.signInTitle': '登录',
			'auth.signInLede': '这个界面管理着已存储的主机凭据，因此不对外开放。',
			'auth.signInAction': '登录',
			'auth.password': '密码',
			'auth.current': '当前密码',
			'auth.failed': '没有成功。',
			'runs.collectNow': '立即采集',
			'runs.collectFailed': '无法启动采集。',
			'runs.nothingToDo': '没有可采集的主机，请先添加一台。',
			'runs.outOfTime': '本次运行剩余时间不足以采集任何内容。',
			'runs.planOnly': '下一台主机：{host}。采集本身尚未实现，因此没有采集任何内容。',
			'runs.resumeFrom': '将从这里续跑：{from}',
			'runs.title': '采集历史',
			'runs.lede': '每一次采集做了什么，以及有哪些没能处理。',
			'runs.ok': '正常',
			'runs.problems': '有问题',
			'runs.unfinished': '提前停止',
			'runs.noDuration': '无时长',
			'runs.counts': '存入 {stored} · 跳过 {skipped} · 失败 {failed}',
			'runs.issues': '{n} 个问题',
			'runs.showIssues': '查看问题',
			'runs.detailTitle': '第 {id} 次采集：没能处理的内容',
			'runs.deliberate': '有意跳过',
			'runs.fault': '出错',
			'runs.back': '返回列表',
			'runs.empty': '还没有采集过。',
			'runs.emptyHint': '采集过一台主机后，这里会显示每次采集的结果和出问题的地方。',
			'runs.kind.too_large': '文件过大',
			'runs.kind.capacity': '空间不足',
			'runs.kind.error': '出错',
			'runs.kind.excluded': '已排除',
			'runs.kind.unchanged': '未变化',
			'browse.title': '已存文件',
			'browse.lede': '目前采集到的全部文件。可搜索路径的任意片段。',
			'browse.search': '搜索',
			'browse.machine': '主机',
			'browse.anyMachine': '全部',
			'browse.sort': '排序',
			'browse.newest': '最新',
			'browse.oldest': '最早',
			'browse.largest': '最大',
			'browse.smallest': '最小',
			'browse.byPath': '按路径',
			'browse.history': '包含已被取代的版本',
			'browse.count': '{n} 个文件',
			'browse.showing': '显示 {n} / {total}',
			'browse.empty': '还没有采集到任何文件。',
			'browse.emptyHint': '添加一台主机和要采集的目录，然后运行一次采集。',
			'browse.noMatch': '没有匹配的文件。',
			'browse.noMatchHint': '试试目录名的一部分，或清空筛选条件。',
			'browse.protected': '重要',
			'browse.protect': '标记为重要',
			'browse.unprotect': '取消标记',
			'browse.replaced': '已被取代',
			'browse.share': '分享',
			'browse.loadMore': '显示更多',
			'browse.copyPath': '复制路径',
			'browse.copyId': '复制编号',
			'browse.copied': '已复制',
			'browse.gone': '已不再存储',			'browse.storedAgo': '{v}存入',
			'browse.seenAgo': '机器上最后改动于{v}',

			'storage.title': '存储',
			'storage.lede': '存储的占用情况，以及存满之后会怎么做。保护优先于空间：标记为重要的文件永远不会被淘汰；如果只剩下受保护的文件，系统会拒绝新文件而不是删掉它们中的一个。',
			'storage.used': '已用 {used} / {total}（{percent}%）',
			'storage.remaining': '还剩 {n}。',
			'storage.retained': '其中 {n} 是保留占用：已被替换或已删除、但字节仍在存储中、仍计入预算的文件。',
			'storage.protected': '有 {n} 受保护，不会被淘汰。',
			'storage.saturated': '存储已满，且剩余文件全部受保护，因此正在拒绝新文件。请取消某个文件的保护，或提高预算。',
			'storage.fullReclaimable': '存储已满。下一个文件会淘汰最旧的未受保护文件来腾出空间。',
			'storage.perFile': '单个文件最大 {n}。',
			'fresh.worst': '最久未采集的机器是 {behind} 前，目标是 {target} 以内。',
			'fresh.behind': '已经落后于目标。要么某台机器连不上，要么它慢到挤占了其它机器；下面的历史记录会说明是哪一种。',
			'fresh.never': '有 {n} 台机器从未成功采集过。它们的文件都没有在更新。',
			'fresh.neverOne': '从未采集',
			'fresh.noMachines': '还没有机器，因此没有需要保持新鲜度的对象。',
			'fresh.seconds': '{n} 秒前',
			'fresh.minutes': '{n} 分钟前',
			'fresh.hours': '{n} 小时前',



			'shares.title': '分享链接',
			'shares.lede': '为某个已存文件发一条链接。它会自行失效，你也可以提前取消。',
			'shares.objectId': '已存文件 id',
			'shares.lifetime': '有效期',
			'shares.15m': '15 分钟',
			'shares.1h': '1 小时',
			'shares.2h': '2 小时',
			'shares.12h': '12 小时',
			'shares.24h': '24 小时',
			'shares.password': '密码（可选）',
			'shares.create': '创建链接',
			'shares.needId': '请先填写已存文件的 id。',
			'shares.failed': '链接创建失败。',
			'shares.made': '链接已创建',
			'shares.copy': '复制',
			'shares.copied': '已复制',
			'shares.linkLabel': '分享链接',
			'shares.protected': '有密码',
			'shares.revoke': '取消链接',
			'shares.revoked': '已取消',
			'shares.expired': '已过期',
			'shares.empty': '还没有链接。',
			'shares.emptyHint': '一条链接对应一个已存文件，有效期由你决定。',
			'shares.downloads': '已下载 {n} 次',
			'shares.in': '{v}后',
			'shares.ago': '{v}前',
			'shares.passwordOnce': '密码：{v} —— 只在此刻显示。服务器无法读回它，请连同链接一起交给接收方。',
			'merges.title': '合并文件',
			'merges.lede': '把多个已存文件合成一个。合并是一条规则而非一次性操作：结果会连同它的来源一起记录下来，因此可以判断它是否仍然是最新的。',
			'merges.outputName': '结果叫什么',
			'merges.combination': '如何合并',
			'merges.union': '把各自的列表合并成一份文档',
			'merges.concat': '首尾相接拼在一起',
			'merges.patterns': '取哪些已存文件（每行一个匹配式）',
			'merges.preview': '预览',
			'merges.save': '保存规则',
			'merges.run': '立即生成',
			'merges.forget': '删除规则',
			'merges.empty': '还没有合并文件。',
			'merges.emptyHint': '规则用匹配式指明取哪些已存文件、以及如何合并。建议先预览：预览会告诉你每条匹配式命中了几个文件，而这通常就是"看起来什么都没做"的原因。',
			'merges.current': '最新',
			'merges.stale': '已过期',
			'merges.notBuilt': '尚未生成',
			'merges.sources': '{n} 个来源',
			'merges.willCombine': '将合并 {n} 个文件，读入 {bytes}，输出约 {out}。',
			'merges.matched': '命中 {n} 个',
			'merges.matchedNothing': '没有命中任何文件',
			'merges.needName': '请先给结果起个名字。',
			'merges.needPattern': '请至少指定一个已存文件，或一条能命中文件的匹配式。',
			'merges.failed': '操作未成功。',
			'merges.built': '已生成 {bytes}。结果与其它文件一样被存储，可以浏览和分享。',
			'theme.dark': '深色',
		},
		'zh-TW': {
			'files.upload': '上傳檔案到 R2',
			'files.uploadAction': '上傳所選檔案',
			'files.uploadDone': '已上傳',
			'files.uploaded': '上傳檔案',
			'files.download': '下載',
			'files.direct': '取得直連',
			'files.directTitle': '檔案下載直連',
			'files.directHint': '持有直連即可下載最新版本；取消連結後停止存取。',
			'files.delete': '刪除檔案',
			'files.deleteConfirm': '從 R2 刪除 {path}？下載及分享將失效。',
			'files.sharePassword': '分享密碼（8–1024 位）',
			'files.needPassword': '請輸入 8–1024 位的分享密碼。',
			'files.profile': 'merged-all.yaml 設定（8 個來源）',
			'files.profilePreset': '使用 merged-all 預設',
			'merges.title': '合併檔案',
			'merges.lede': '把多個已存檔案合成一個。合併是一條規則而非一次性操作：結果會連同它的來源一起記錄下來，因此可以判斷它是否仍然是最新的。',
			'merges.outputName': '結果叫什麼',
			'merges.combination': '如何合併',
			'merges.union': '把各自的列表合併成一份文件',
			'merges.concat': '首尾相接接在一起',
			'merges.patterns': '取哪些已存檔案（每行一個匹配式）',
			'merges.preview': '預覽',
			'merges.save': '儲存規則',
			'merges.run': '立即產生',
			'merges.forget': '刪除規則',
			'merges.empty': '還沒有合併檔案。',
			'merges.emptyHint': '規則用匹配式指明取哪些已存檔案、以及如何合併。建議先預覽：預覽會告訴你每條匹配式命中了幾個檔案，而這通常就是「看起來什麼都沒做」的原因。',
			'merges.current': '最新',
			'merges.stale': '已過期',
			'merges.notBuilt': '尚未產生',
			'merges.sources': '{n} 個來源',
			'merges.willCombine': '將合併 {n} 個檔案，讀入 {bytes}，輸出約 {out}。',
			'merges.matched': '命中 {n} 個',
			'merges.matchedNothing': '沒有命中任何檔案',
			'merges.needName': '請先給結果取個名字。',
			'merges.needPattern': '請至少指定一個已存檔案，或一條能命中檔案的匹配式。',
			'merges.failed': '操作未成功。',
			'merges.built': '已產生 {bytes}。結果與其它檔案一樣被儲存，可以瀏覽和分享。',
			'browse.loadMore': '顯示更多',
			'browse.copyPath': '複製路徑',
			'browse.copyId': '複製編號',
			'browse.copied': '已複製',
			'browse.gone': '已不再儲存',			'browse.storedAgo': '{v}存入',
			'browse.seenAgo': '機器上最後改動於{v}',

			'storage.title': '儲存',
			'storage.lede': '儲存的佔用情況，以及存滿之後會怎麼做。保護優先於空間：標記為重要的檔案永遠不會被淘汰；如果只剩下受保護的檔案，系統會拒絕新檔案而不是刪掉其中一個。',
			'storage.used': '已用 {used} / {total}（{percent}%）',
			'storage.remaining': '還剩 {n}。',
			'storage.retained': '其中 {n} 是保留佔用：已被取代或已刪除、但位元組仍在儲存中、仍計入預算的檔案。',
			'storage.protected': '有 {n} 受保護，不會被淘汰。',
			'storage.saturated': '儲存已滿，且剩餘檔案全部受保護，因此正在拒絕新檔案。請取消某個檔案的保護，或提高預算。',
			'storage.fullReclaimable': '儲存已滿。下一個檔案會淘汰最舊的未受保護檔案來騰出空間。',
			'storage.perFile': '單一檔案最大 {n}。',
			'fresh.worst': '最久未採集的機器是 {behind} 前，目標是 {target} 以內。',
			'fresh.behind': '已經落後於目標。要麼某台機器連不上，要麼它慢到擠佔了其它機器；下面的歷史記錄會說明是哪一種。',
			'fresh.never': '有 {n} 台機器從未成功採集過。它們的檔案都沒有在更新。',
			'fresh.neverOne': '從未採集',
			'fresh.noMachines': '還沒有機器，因此沒有需要保持新鮮度的對象。',
			'fresh.seconds': '{n} 秒前',
			'fresh.minutes': '{n} 分鐘前',
			'fresh.hours': '{n} 小時前',


			'skip': '跳到主要內容',
			'status.key': '簽章金鑰',
			'status.schema': '資料表',
			'status.storage': '儲存',
			'setup.title': '還差幾步',
			'setup.key': '設定簽章金鑰。它是這次部署唯一需要的金鑰；主機憑證都會先用它加密再寫入資料庫。',
			'setup.generate': '產生金鑰',
			'setup.keyValue': '簽章金鑰',
			'setup.keyWarning': '只顯示這一次，不會儲存在任何地方。取代現有金鑰不會重新加密任何資料，因此所有已儲存的憑證都會變得無法讀取。',
			'setup.keyStatus': '目前狀態：{status}',
			'setup.schema': '建立資料表。缺少：{missing}',
			'setup.apply': '建立資料表',
			'setup.applied': '資料表已建立',
			'hosts.title': '主機',
			'hosts.lede': '這個 Worker 透過 SSH 存取的機器。它們上面不安裝任何東西。',
			'hosts.add': '新增主機',
			'hosts.empty': '還沒有機器。',
			'hosts.emptyHint': '新增一台即可從它採集檔案。',
			'hosts.enabled': '啟用',
			'hosts.disabled': '已暫停',
			'hosts.password': '密碼',
			'hosts.key': '金鑰',
			'hosts.noCredential': '無憑證',
			'hosts.fingerprint': '指紋',
			'hosts.test': '測試',
			'hosts.testing': '連線中…',
			'hosts.delete': '刪除',
			'hosts.confirmDelete': '刪除 {id}？它的採集規則會一併刪除，已儲存的檔案會保留。',
			'form.title': '新增或更新主機',
			'form.label': '名稱',
			'form.address': '位址',
			'form.port': '連接埠',
			'form.username': '使用者名稱',
			'form.authMode': '認證方式',
			'form.modePassword': '使用者名稱 + 密碼',
			'form.modeKey': '使用者名稱 + 私鑰',
			'form.password': '密碼',
			'form.passphrase': '私鑰口令（可留空）',
			'form.privateKey': '私鑰',
			'form.hint': '憑證在 Worker 內加密後才寫入資料庫，而且永遠不會回傳到本頁面。留空表示保留已儲存的值。',
			'form.save': '儲存主機',
			'form.cancel': '取消',
			'form.saved': '主機已儲存',
			'form.saving': '正在儲存…',
			'form.needAddress': '請先填寫位址。',
			'form.needUsername': '請先填寫使用者名稱。',
			'form.needPassword': '請填寫密碼，或切換到私鑰方式。',
			'form.needKey': '請貼上私鑰，或切換到密碼方式。',
			'form.saveFailed': '未儲存：{detail}',
			'form.requestFailed': '請求沒有到達 Worker（{detail}），未做任何變更。',
			'form.requestTimeout': 'Worker 在 {seconds} 秒內沒有回應，未做任何變更，請重試。',
			'rules.title': '要採集的目錄',
			'rules.lede': '對所有機器生效的規則處處適用；指定機器的規則只在那台生效。排除規則優先判斷。',
			'rules.scope': '適用範圍',
			'rules.allHosts': '所有機器',
			'rules.pattern': '樣式',
			'rules.kind': '類型',
			'rules.include': '採集',
			'rules.exclude': '排除',
			'rules.add': '新增規則',
			'rules.delete': '刪除',
			'rules.empty': '還沒有設定目錄。',
			'rules.emptyHint': '至少需要一條規則，否則不會採集任何檔案。',
			'result.title': '連線測試',
			'result.empty': '測試一台機器，可以看到它是什麼、每一步耗時多久，以及規則在它真實檔案系統上的命中情況。',
			'result.ok': '已連線',
			'result.failed': '無法連線',
			'result.unknownError': 'Worker 沒有回傳錯誤訊息。',
			'result.total': '合計',
			'result.raw': '原始回應',
			'result.rules': '規則命中情況',
			'result.matches': '命中 {count} 個檔案',
			'result.needsCollection': '目錄部分含萬用字元，將在採集階段解析，而不是現在。',
			'result.noRules': '目前沒有規則適用於這台機器。',
			'fact.hostname': '主機名稱',
			'fact.user': '登入身分',
			'fact.system': '系統',
			'fact.disk': '磁碟',
			'fact.diskValue': '共 {size} GB，可用 {free} GB',
			'theme.auto': '跟隨裝置',
			'theme.light': '淺色',
			'auth.setupTitle': '設定密碼',
			'auth.setupLede': '這個部署還沒有密碼。誰先設定，誰就掌管這個介面，所以現在就設。',
			'auth.setupAction': '設定密碼並繼續',
			'auth.setupHint': '至少 12 個字元。一句你能記住的話，比一串短亂的符號更可靠。',
			'auth.signInTitle': '登入',
			'auth.signInLede': '這個介面管理著已儲存的主機憑證，因此不對外開放。',
			'auth.signInAction': '登入',
			'auth.password': '密碼',
			'auth.current': '目前密碼',
			'auth.failed': '沒有成功。',
			'runs.collectNow': '立即採集',
			'runs.collectFailed': '無法啟動採集。',
			'runs.nothingToDo': '沒有可採集的主機，請先新增一台。',
			'runs.outOfTime': '本次執行剩餘時間不足以採集任何內容。',
			'runs.planOnly': '下一台主機：{host}。採集本身尚未實作，因此沒有採集任何內容。',
			'runs.resumeFrom': '將從這裡續跑：{from}',
			'runs.title': '採集歷史',
			'runs.lede': '每一次採集做了什麼，以及有哪些沒能處理。',
			'runs.ok': '正常',
			'runs.problems': '有問題',
			'runs.unfinished': '提前停止',
			'runs.noDuration': '無時長',
			'runs.counts': '存入 {stored} · 跳過 {skipped} · 失敗 {failed}',
			'runs.issues': '{n} 個問題',
			'runs.showIssues': '查看問題',
			'runs.detailTitle': '第 {id} 次採集：沒能處理的內容',
			'runs.deliberate': '有意跳過',
			'runs.fault': '出錯',
			'runs.back': '返回列表',
			'runs.empty': '還沒有採集過。',
			'runs.emptyHint': '採集過一台主機後，這裡會顯示每次採集的結果和出問題的地方。',
			'runs.kind.too_large': '檔案過大',
			'runs.kind.capacity': '空間不足',
			'runs.kind.error': '出錯',
			'runs.kind.excluded': '已排除',
			'runs.kind.unchanged': '未變化',
			'browse.title': '已存檔案',
			'browse.lede': '目前採集到的全部檔案。可搜尋路徑的任意片段。',
			'browse.search': '搜尋',
			'browse.machine': '主機',
			'browse.anyMachine': '全部',
			'browse.sort': '排序',
			'browse.newest': '最新',
			'browse.oldest': '最早',
			'browse.largest': '最大',
			'browse.smallest': '最小',
			'browse.byPath': '依路徑',
			'browse.history': '包含已被取代的版本',
			'browse.count': '{n} 個檔案',
			'browse.showing': '顯示 {n} / {total}',
			'browse.empty': '還沒有採集到任何檔案。',
			'browse.emptyHint': '新增一台主機和要採集的目錄，然後執行一次採集。',
			'browse.noMatch': '沒有符合的檔案。',
			'browse.noMatchHint': '試試目錄名稱的一部分，或清空篩選條件。',
			'browse.protected': '重要',
			'browse.protect': '標記為重要',
			'browse.unprotect': '取消標記',
			'browse.replaced': '已被取代',
			'browse.share': '分享',
			'shares.title': '分享連結',
			'shares.lede': '為某個已存檔案發一條連結。它會自行失效，你也可以提前取消。',
			'shares.objectId': '已存檔案 id',
			'shares.lifetime': '有效期',
			'shares.15m': '15 分鐘',
			'shares.1h': '1 小時',
			'shares.2h': '2 小時',
			'shares.12h': '12 小時',
			'shares.24h': '24 小時',
			'shares.password': '密碼（可選）',
			'shares.create': '建立連結',
			'shares.needId': '請先填寫已存檔案的 id。',
			'shares.failed': '連結建立失敗。',
			'shares.made': '連結已建立',
			'shares.copy': '複製',
			'shares.copied': '已複製',
			'shares.linkLabel': '分享連結',
			'shares.protected': '有密碼',
			'shares.revoke': '取消連結',
			'shares.revoked': '已取消',
			'shares.expired': '已過期',
			'shares.empty': '還沒有連結。',
			'shares.emptyHint': '一條連結對應一個已存檔案，有效期由你決定。',
			'shares.downloads': '已下載 {n} 次',
			'shares.in': '{v}後',
			'shares.ago': '{v}前',
			'shares.passwordOnce': '密碼：{v} —— 只在此刻顯示。伺服器無法讀回它，請連同連結一起交給接收方。',
			'theme.dark': '深色',
		},
		ja: {
			'files.upload': 'R2 にファイルをアップロード',
			'files.uploadAction': '選択したファイルをアップロード',
			'files.uploadDone': 'アップロード済み',
			'files.uploaded': 'アップロードしたファイル',
			'files.download': 'ダウンロード',
			'files.direct': '直接リンクを取得',
			'files.directTitle': '直接ダウンロードリンク',
			'files.directHint': 'リンクを持つ人は最新のファイルをダウンロードできます。取り消すとアクセスできなくなります。',
			'files.delete': 'ファイルを削除',
			'files.deleteConfirm': 'R2 から {path} を削除しますか？ダウンロードと共有は無効になります。',
			'files.sharePassword': '共有パスワード（8–1024 文字）',
			'files.needPassword': '8–1024 文字の共有パスワードを入力してください。',
			'files.profile': 'merged-all.yaml 設定（8 ソース）',
			'files.profilePreset': 'merged-all プリセットを使用',
			'skip': '本文へ移動',
			'status.key': '署名鍵',
			'status.schema': 'テーブル',
			'status.storage': 'ストレージ',
			'setup.title': '使う前に',
			'setup.key': '署名鍵を設定します。この配備で必要な唯一の秘密情報で、ホストの認証情報はこれで暗号化してからデータベースに入ります。',
			'setup.generate': '鍵を生成',
			'setup.keyValue': '署名鍵',
			'setup.keyWarning': '表示は一度きりで、どこにも保存されません。既存の鍵を差し替えても再暗号化は行われないため、保存済みの認証情報はすべて読めなくなります。',
			'setup.keyStatus': '現在の状態：{status}',
			'setup.schema': 'テーブルを作成します。不足：{missing}',
			'setup.apply': 'テーブルを作成',
			'setup.applied': 'テーブルを作成しました',
			'hosts.title': 'ホスト',
			'hosts.lede': 'この Worker が SSH で接続するマシンです。マシン側には何もインストールしません。',
			'hosts.add': 'ホストを追加',
			'hosts.empty': 'まだマシンがありません。',
			'hosts.emptyHint': '追加すると、そこからファイルを収集できます。',
			'hosts.enabled': '有効',
			'hosts.disabled': '停止中',
			'hosts.password': 'パスワード',
			'hosts.key': '鍵',
			'hosts.noCredential': '認証情報なし',
			'hosts.fingerprint': 'フィンガープリント',
			'hosts.test': 'テスト',
			'hosts.testing': '接続中…',
			'hosts.delete': '削除',
			'hosts.confirmDelete': '{id} を削除しますか。収集ルールも一緒に削除されますが、保存済みのファイルは残ります。',
			'form.title': 'ホストを追加または更新',
			'form.label': '名前',
			'form.address': 'アドレス',
			'form.port': 'ポート',
			'form.username': 'ユーザー名',
			'form.authMode': '認証方式',
			'form.modePassword': 'ユーザー名 + パスワード',
			'form.modeKey': 'ユーザー名 + 秘密鍵',
			'form.password': 'パスワード',
			'form.passphrase': '鍵のパスフレーズ（任意）',
			'form.privateKey': '秘密鍵',
			'form.hint': '認証情報は Worker 内で暗号化してからデータベースに入り、この画面へ戻ることはありません。空欄のままにすると保存済みの値が維持されます。',
			'form.save': 'ホストを保存',
			'form.cancel': 'キャンセル',
			'form.saved': 'ホストを保存しました',
			'form.saving': '保存中…',
			'form.needAddress': 'アドレスを入力してください。',
			'form.needUsername': 'ユーザー名を入力してください。',
			'form.needPassword': 'パスワードを入力するか、秘密鍵方式に切り替えてください。',
			'form.needKey': '秘密鍵を貼り付けるか、パスワード方式に切り替えてください。',
			'form.saveFailed': '保存できませんでした：{detail}',
			'form.requestFailed': 'リクエストが Worker に到達しませんでした（{detail}）。変更は行われていません。',
			'form.requestTimeout': 'Worker が {seconds} 秒以内に応答しませんでした。変更は行われていません。もう一度お試しください。',
			'rules.title': '収集するディレクトリ',
			'rules.lede': 'すべてのマシンに効くルールはどこでも適用され、特定のマシンのルールはそこだけで適用されます。除外が先に判定されます。',
			'rules.scope': '適用範囲',
			'rules.allHosts': 'すべてのマシン',
			'rules.pattern': 'パターン',
			'rules.kind': '種類',
			'rules.include': '収集',
			'rules.exclude': '除外',
			'rules.add': 'ルールを追加',
			'rules.delete': '削除',
			'rules.empty': 'ディレクトリが未設定です。',
			'rules.emptyHint': 'ルールが一本もないと、何も収集されません。',
			'result.title': '接続テスト',
			'result.empty': 'マシンをテストすると、その正体、各段階の所要時間、そしてルールが実際のファイルシステムでどう解決されるかが分かります。',
			'result.ok': '接続済み',
			'result.failed': '接続できません',
			'result.unknownError': 'Worker からエラーメッセージが返りませんでした。',
			'result.total': '合計',
			'result.raw': '生の応答',
			'result.rules': 'ルールの解決結果',
			'result.matches': '{count} 件が一致',
			'result.needsCollection': 'ディレクトリ部分にワイルドカードがあるため、ここではなく収集時に解決されます。',
			'result.noRules': 'このマシンに適用されるルールはまだありません。',
			'fact.hostname': 'ホスト名',
			'fact.user': 'ログイン',
			'fact.system': 'システム',
			'fact.disk': 'ディスク',
			'fact.diskValue': '{size} GB 中 {free} GB 空き',
			'theme.auto': '端末に合わせる',
			'theme.light': 'ライト',
			'auth.setupTitle': 'パスワードを設定',
			'auth.setupLede': 'この配備にはまだパスワードがありません。最初に設定した人がこの画面を管理することになるので、今設定してください。',
			'auth.setupAction': '設定して続ける',
			'auth.setupHint': '12 文字以上。覚えられる一文のほうが、短い記号の羅列より安全です。',
			'auth.signInTitle': 'サインイン',
			'auth.signInLede': 'この画面は保存されたマシンの認証情報を扱うため、公開していません。',
			'auth.signInAction': 'サインイン',
			'auth.password': 'パスワード',
			'auth.current': '現在のパスワード',
			'auth.failed': 'うまくいきませんでした。',
			'runs.collectNow': '今すぐ収集',
			'runs.collectFailed': '収集を開始できませんでした。',
			'runs.nothingToDo': '収集するマシンがありません。先に追加してください。',
			'runs.outOfTime': 'この実行に残された時間では何も収集できません。',
			'runs.planOnly': '次のマシン：{host}。収集自体はまだ実装されていないため、何も収集していません。',
			'runs.resumeFrom': '再開位置：{from}',
			'runs.title': '収集履歴',
			'runs.lede': '各回の収集が何をしたか、そして扱えなかったもの。',
			'runs.ok': '正常',
			'runs.problems': '問題あり',
			'runs.unfinished': '途中で停止',
			'runs.noDuration': '所要時間なし',
			'runs.counts': '保存 {stored} · スキップ {skipped} · 失敗 {failed}',
			'runs.issues': '{n} 件の問題',
			'runs.showIssues': '問題を表示',
			'runs.detailTitle': '第 {id} 回の収集：扱えなかったもの',
			'runs.deliberate': '意図的にスキップ',
			'runs.fault': 'エラー',
			'runs.back': '一覧に戻る',
			'runs.empty': 'まだ何も収集していません。',
			'runs.emptyHint': 'マシンを収集すると、各回の結果と問題点がここに表示されます。',
			'runs.kind.too_large': 'サイズ超過',
			'runs.kind.capacity': '空き容量なし',
			'runs.kind.error': 'エラー',
			'runs.kind.excluded': '除外',
			'runs.kind.unchanged': '変更なし',
			'browse.title': '保存済みファイル',
			'browse.lede': 'これまでに収集したすべてのファイルです。パスの一部で検索できます。',
			'browse.search': '検索',
			'browse.machine': 'マシン',
			'browse.anyMachine': 'すべて',
			'browse.sort': '並び順',
			'browse.newest': '新しい順',
			'browse.oldest': '古い順',
			'browse.largest': '大きい順',
			'browse.smallest': '小さい順',
			'browse.byPath': 'パス順',
			'browse.history': '置き換え済みの版も含める',
			'browse.count': '{n} 件',
			'browse.showing': '{n} / {total} 件を表示',
			'browse.empty': 'まだ何も収集していません。',
			'browse.emptyHint': 'マシンと収集するディレクトリを追加し、収集を実行してください。',
			'browse.noMatch': '一致するものがありません。',
			'browse.noMatchHint': 'ディレクトリ名の一部で試すか、絞り込みを解除してください。',
			'browse.protected': '重要',
			'browse.protect': '重要として印を付ける',
			'browse.unprotect': '印を外す',
			'browse.replaced': '置き換え済み',
			'browse.share': '共有',
			'browse.loadMore': 'さらに表示',
			'browse.copyPath': 'パスをコピー',
			'browse.copyId': 'ID をコピー',
			'browse.copied': 'コピーしました',
			'browse.gone': '保存されていません',			'browse.storedAgo': '{v}に保存',
			'browse.seenAgo': 'マシン上の最終変更は{v}',

			'storage.title': 'ストレージ',
			'storage.lede': '保存領域の使用状況と、いっぱいになったときの動作です。保護は空きより優先されます。重要と印を付けたファイルは決して削除されず、保護されたファイルだけが残った場合は、そのうちの 1 つを消すのではなく新しいファイルを拒否します。',
			'storage.used': '{total} 中 {used} 使用（{percent}%）',
			'storage.remaining': '残り {n}。',
			'storage.retained': 'うち {n} は保持分です。置き換え済みまたは削除済みでも、バイトが保存に残り、予算に計上され続けているファイルです。',
			'storage.protected': '{n} は保護されており削除されません。',
			'storage.saturated': '保存領域が満杯で、残るファイルはすべて保護されているため、新しいファイルを拒否しています。保護を解除するか、予算を増やしてください。',
			'storage.fullReclaimable': '保存領域が満杯です。次のファイルは、最も古い保護されていないファイルを削除して場所を空けます。',
			'storage.perFile': '1 ファイルあたり最大 {n}。',
			'fresh.worst': '最も長く収集されていないマシンは {behind} 前です。目標は {target} 以内。',
			'fresh.behind': '目標より遅れています。マシンに到達できないか、遅すぎて他を圧迫しているかのどちらかです。どちらなのかは下の履歴が示します。',
			'fresh.never': '{n} 台のマシンが一度も正常に収集されていません。それらのファイルは更新されていません。',
			'fresh.neverOne': '未収集',
			'fresh.noMachines': 'マシンがまだないため、鮮度を保つ対象がありません。',
			'fresh.seconds': '{n} 秒前',
			'fresh.minutes': '{n} 分前',
			'fresh.hours': '{n} 時間前',



			'shares.title': '共有リンク',
			'shares.lede': '保存済みのファイル 1 つに対するリンクを発行します。期限が来れば自動で無効になり、それより早く取り消すこともできます。',
			'shares.objectId': '保存ファイルの id',
			'shares.lifetime': '有効期間',
			'shares.15m': '15 分',
			'shares.1h': '1 時間',
			'shares.2h': '2 時間',
			'shares.12h': '12 時間',
			'shares.24h': '24 時間',
			'shares.password': 'パスワード（任意）',
			'shares.create': 'リンクを作成',
			'shares.needId': '先に保存ファイルの id を入力してください。',
			'shares.failed': 'リンクを作成できませんでした。',
			'shares.made': 'リンクを作成しました',
			'shares.copy': 'コピー',
			'shares.copied': 'コピーしました',
			'shares.linkLabel': '共有リンク',
			'shares.protected': 'パスワードあり',
			'shares.revoke': 'リンクを取り消す',
			'shares.revoked': '取り消し済み',
			'shares.expired': '期限切れ',
			'shares.empty': 'リンクはまだありません。',
			'shares.emptyHint': 'リンク 1 つにつき保存ファイル 1 つ、期間は指定できます。',
			'shares.downloads': '{n} 回ダウンロード',
			'shares.in': '{v}後',
			'shares.ago': '{v}前',
			'shares.passwordOnce': 'パスワード：{v} —— 表示は今回だけです。サーバーから読み戻すことはできないため、リンクと一緒に相手へ渡してください。',
			'merges.title': '結合ファイル',
			'merges.lede': '複数の保存済みファイルから 1 つを作ります。結合はルールであり一度きりの操作ではありません。結果は由来とともに記録されるため、最新かどうかを判断できます。',
			'merges.outputName': '結果の名前',
			'merges.combination': '結合のしかた',
			'merges.union': 'それぞれのリストを 1 つの文書にまとめる',
			'merges.concat': 'そのまま順に連結する',
			'merges.patterns': '対象の保存済みファイル（1 行に 1 パターン）',
			'merges.preview': 'プレビュー',
			'merges.save': 'ルールを保存',
			'merges.run': '今すぐ作成',
			'merges.forget': 'ルールを削除',
			'merges.empty': '結合ファイルはまだありません。',
			'merges.emptyHint': 'ルールはパターンで対象を指定し、結合方法を決めます。まずプレビューを：どのパターンが何件一致したかが分かり、「何も起きていないように見える」原因はたいていそこにあります。',
			'merges.current': '最新',
			'merges.stale': '期限切れ',
			'merges.notBuilt': '未作成',
			'merges.sources': 'ソース {n} 件',
			'merges.willCombine': '{n} 件を結合します。読み込み {bytes}、出力は約 {out}。',
			'merges.matched': '{n} 件一致',
			'merges.matchedNothing': '一致なし',
			'merges.needName': '先に結果の名前を付けてください。',
			'merges.needPattern': '保存済みファイルを 1 つ以上、または一致するパターンを指定してください。',
			'merges.failed': 'うまくいきませんでした。',
			'merges.built': '{bytes} を作成しました。結果は他のファイルと同じく保存され、閲覧も共有もできます。',
			'theme.dark': 'ダーク',
		},
	};
	for (const code of Object.keys(table) as Locale[]) Object.assign(table[code], WORKFLOW_COPY[code]);
	return JSON.stringify(table);
}

/**
 * Styles: blue-pink-white liquid glass over a bloom field, with a real light and a real dark theme.
 *
 * Two notes on why this is shaped the way it is:
 *   - Glass only reads as glass when there is something behind it to refract, so both themes carry a
 *     radial bloom field. On a flat fill the same panels turn into grey slabs.
 *   - Hierarchy is expressed by radius and blur depth rather than one radius on everything: the
 *     container, the toolbars and the chips sit at three different scales.
 *
 * Motion is limited to the transfer spine's measured bar, which is content-driven. Fades that paint
 * the page at low opacity were removed: they made text measurable at 45% strength whenever anything
 * captured the page early.
 */
const STYLES = `
:root {
  --r-xl: 26px; --r-lg: 16px; --r-md: 11px; --r-sm: 8px;
  --ease: cubic-bezier(.22,.61,.36,1);
}

/* ---------- light (default) ---------- */
:root, :root[data-theme="light"] {
  --ink: #070C1A;
  --fg: #0C1526;
  --fg-soft: #33415C;
  --muted: #5A6683;
  --blue: #1B3AC4;
  --blush: #FF7AB8;
  --orchid: #6D4BE0;

  /* The surface is mostly solid on purpose. Legibility is the surface's job and the glass effect is
     the job of what happens BEHIND it: a strong blur plus a saturation boost pick the bloom colours
     up and smear them across the panel, which is where the liquid look comes from. Making the panel
     itself see-through instead just washes the text out. */
  --glass: rgba(255,255,255,.78);
  --glass-strong: rgba(255,255,255,.62);
  --glass-line: rgba(255,255,255,1);
  --glass-edge: rgba(16,24,40,.10);
  --edge-line: rgba(16,24,40,.15);
  --shadow: 0 26px 52px -30px rgba(16,24,40,.55), 0 3px 10px -5px rgba(16,24,40,.14);
  --inset: inset 0 1px 0 rgba(255,255,255,1);

  /* Ambient light only: never meant to be read through, so these stay quiet and sit at the margins
     rather than behind the content. Strong enough that the panes visibly pick colour up through the
     blur, weak enough that body text keeps a 5.6:1 ratio. */
  --bloom-1: rgba(27,58,196,.34);
  --bloom-2: rgba(255,122,184,.32);
  --bloom-3: rgba(109,75,224,.22);
  --page: #F4F7FE;

  --ok: #0F7A55; --ok-bg: rgba(15,122,85,.10);
  --warn: #8A5B00; --warn-bg: rgba(138,91,0,.10);
  --err: #B4232B; --err-bg: rgba(180,35,43,.10);
  --field-bg: rgba(255,255,255,.92);
  --code-bg: rgba(16,24,40,.06);
  color-scheme: light;
}

/* ---------- dark ---------- */
:root[data-theme="dark"] {
  --ink: #F2F5FF;
  --fg: #EEF2FF;
  --fg-soft: #C3CCE6;
  --muted: #8C97B8;
  --blue: #7FA0FF;
  --blush: #FF9CCB;
  --orchid: #B49BFF;

  --glass: rgba(24,30,48,.66);
  --glass-strong: rgba(255,255,255,.1);
  --glass-line: rgba(255,255,255,.16);
  --glass-edge: rgba(255,255,255,.11);
  --edge-line: rgba(255,255,255,.18);
  --shadow: 0 28px 64px -32px rgba(0,0,0,.9), 0 3px 12px -7px rgba(0,0,0,.7);
  --inset: inset 0 1px 0 rgba(255,255,255,.14);

  --bloom-1: rgba(45,86,255,.36);
  --bloom-2: rgba(255,110,180,.24);
  --bloom-3: rgba(120,80,240,.3);
  --page: #05080F;

  --ok: #5FD3A6; --ok-bg: rgba(95,211,166,.12);
  --warn: #E8C06A; --warn-bg: rgba(232,192,106,.12);
  --err: #FF8A8A; --err-bg: rgba(255,138,138,.12);
  --field-bg: rgba(255,255,255,.09);
  --code-bg: rgba(255,255,255,.09);
  color-scheme: dark;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--page);
  color: var(--fg);
  /* One stack across Latin, Simplified Chinese, Traditional Chinese and Japanese. No webfont: a
     font file would be a deployment artifact, and these system faces are the ones that actually
     render all four locales well on their own platforms. */
  font-family: Inter, "Segoe UI Variable Text", -apple-system, BlinkMacSystemFont, "Hiragino Sans",
               "Noto Sans JP", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Microsoft JhengHei",
               "PingFang TC", "Noto Sans TC", system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* ---------- the bloom field: what the glass refracts ----------
   The blooms are deliberately SMALLER than the viewport. A bloom the size of the screen puts the
   brightest part of the gradient directly behind the panels, which washes out the edge that makes
   glass read as glass; anchoring colour to the corners leaves a calm pass in the optical centre
   where the content sits, and the glass still has real colour to refract. */
.field { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
.bloom { position: absolute; display: block; border-radius: 50%; filter: blur(64px); }
.b1 { width: 34vw; height: 34vw; min-width: 240px; min-height: 240px; background: var(--bloom-1); top: -8vw; left: -6vw; }
.b2 { width: 30vw; height: 30vw; min-width: 220px; min-height: 220px; background: var(--bloom-2); top: -4vh; right: -7vw; }
.b3 { width: 42vw; height: 42vw; min-width: 280px; min-height: 280px; background: var(--bloom-3); bottom: -30vw; left: 8vw; opacity: .7; }

@media (prefers-reduced-motion: no-preference) {
  .bloom { animation: drift 26s var(--ease) infinite alternate; }
  .b2 { animation-duration: 32s; animation-delay: -6s; }
  .b3 { animation-duration: 38s; animation-delay: -12s; }
}
@keyframes drift {
  from { transform: translate3d(0,0,0) scale(1); }
  to   { transform: translate3d(3vw,-3vh,0) scale(1.12); }
}

/* ---------- shell ---------- */
.shell { position: relative; z-index: 1; max-width: 1120px; margin: 0 auto; padding: 26px 20px 72px; }

/* There is deliberately NO entrance animation on the shell.
   A page-load fade that paints at low opacity is fragile: anything that captures the page early —
   a screenshot run, a slow first paint, a print — records the faded state, and text measured at
   45% strength is a legibility bug rather than a style. The one orchestrated moment on this page is
   the transfer spine's measured bar, which is content-driven and therefore worth the motion. */

.skiplink {
  position: absolute; left: -9999px; top: 10px; z-index: 10;
  background: var(--glass-strong); color: var(--fg); padding: 10px 16px;
  border-radius: var(--r-md); border: 1px solid var(--glass-line); backdrop-filter: blur(16px);
}
.skiplink:focus { left: 20px; }

.glass {
  position: relative;
  background: var(--glass);
  /* A real edge, not a white-on-white hairline: the boundary is what makes a pane read as a pane.
     (This is the one place the light theme uses a dark line.) */
  border: 1px solid var(--edge-line);
  box-shadow: var(--shadow), var(--inset);
  -webkit-backdrop-filter: blur(34px) saturate(200%);
  backdrop-filter: blur(34px) saturate(200%);
  border-radius: var(--r-xl);
}
/* The rim: an inner highlight along the top edge.
   Deliberately kept OFF the content: an absolutely positioned overlay with no stacking rule paints
   above the panel's own text, and a measured contrast pass caught exactly that — light-theme body
   text fell to 2.25:1 while the identical dark theme held 6.35:1. The z-index rule below keeps the
   highlight behind everything inside the pane. */
.glass::before {
  content: ""; position: absolute; inset: 0; z-index: 0; border-radius: inherit; pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,.55), rgba(255,255,255,0) 22%);
}
.glass > * { position: relative; z-index: 1; }

/* ---------- top bar ---------- */
.bar {
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  padding: 14px 18px; margin-bottom: 22px;
  background: var(--glass); border: 1px solid var(--edge-line);
  box-shadow: var(--shadow), var(--inset);
  -webkit-backdrop-filter: blur(34px) saturate(200%);
  backdrop-filter: blur(34px) saturate(200%);
  border-radius: var(--r-lg);
}
.mark { display: flex; align-items: center; gap: 10px; }
.glyph {
  width: 26px; height: 26px; border-radius: 9px; display: block;
  background: linear-gradient(135deg, var(--blue), var(--blush));
  box-shadow: 0 6px 16px -6px var(--orchid), var(--inset);
}
.wordmark { font-size: 18px; font-weight: 680; letter-spacing: -.015em; }

.meters { display: flex; gap: 8px; flex-wrap: wrap; margin-right: auto; }
.meter {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--fg-soft);
  padding: 5px 11px 5px 9px; border-radius: var(--r-sm);
  background: var(--glass-strong); border: 1px solid var(--glass-line);
}
.meter .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); display: block; }
.meter.on .dot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.meter.off .dot { background: var(--err); box-shadow: 0 0 0 3px var(--err-bg); }
.meter.off { color: var(--err); }

.controls { display: flex; gap: 8px; flex-wrap: wrap; }
.seg {
  display: inline-flex; padding: 3px; gap: 2px; border-radius: var(--r-md);
  background: var(--glass-strong); border: 1px solid var(--glass-edge);
}
.segbtn {
  appearance: none; border: 0; background: transparent; color: var(--fg-soft);
  font: inherit; font-size: 12.5px; padding: 5px 10px; border-radius: var(--r-sm);
  cursor: pointer; white-space: nowrap; transition: color .18s var(--ease), background .18s var(--ease);
}
.segbtn:hover { color: var(--fg); background: var(--code-bg); }
.segbtn.active { background: var(--glass); color: var(--fg); font-weight: 640; box-shadow: var(--inset); }
.segbtn.icon { padding: 5px 9px; font-size: 14px; line-height: 1; }
.segbtn:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }

/* ---------- the gate ---------- */
/* Centred and narrow: it holds one field, and a full-width form for a single input reads as a form
   that lost its content. */
.gate { max-width: 460px; margin: 8vh auto 0; padding: 26px 26px 24px; }
.gate h2 { font-size: 21px; letter-spacing: -.02em; margin-bottom: 6px; }
.gate .lede { margin-bottom: 18px; }
.gate form { display: grid; gap: 12px; }
.gate .actions { margin-top: 4px; }
.gate .actions button { width: 100%; }
.hint.error { color: var(--err); }
@media (max-width: 560px) { .gate { margin-top: 4vh; padding: 20px 18px; } }

/* ---------- collection history ---------- */
/* The counts sit inline with the chips rather than in a column, because a run's line reads as a sentence:
   which machine, how long, how it ended, what it did. */
.run-counts { font-size: 12px; color: var(--muted); }
.run-detail { border: 1px solid var(--glass-line); border-radius: var(--r-md); padding: 12px 14px; background: var(--code-bg); box-shadow: var(--inset); }
.run-detail .rule { border-bottom: 0; }
/* The machine's own words, allowed to wrap: an error message that is cut off is the one thing this panel
   exists to show, so it is the last thing that should be truncated by layout. */
.run-detail .hint { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }

/* ---------- stored files ---------- */
/* The count sits above the list rather than below it, because "showing 50 of 214" is only useful before
   someone has started reading the list as if it were the whole answer. */
.browse-count { margin: 10px 0 4px; }
.browse-count .hint { margin: 0; }
/* A checkbox inherits the full-width treatment that inputs get, which stretches a single tick across the
   width of the panel. */
.toggle { display: flex; align-items: center; gap: 8px; }
.toggle input { width: auto; padding: 0; margin: 0; }

/* ---------- shared links ---------- */
/* The created link is the one thing here the operator must copy before leaving, so it gets a raised
   treatment rather than blending into the list of existing links below it.

   Variable names are the ones this stylesheet actually defines: an earlier version of these rules used
   invented names, and an undefined custom property does not error — it resolves to nothing, so the border
   and background simply disappear. */
.share-made { border: 1px solid var(--glass-line); border-radius: var(--r-md); padding: 12px 14px; margin: 10px 0 4px; background: var(--code-bg); box-shadow: var(--inset); }
.share-made-title { font-size: 12.5px; font-weight: 640; margin: 0 0 8px; letter-spacing: -.005em; }
.share-link { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.share-made-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.share-target { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.share-size { font-size: 12px; color: var(--muted); }

/* ---------- headings ---------- */
h2 { font-size: 15px; font-weight: 660; letter-spacing: -.005em; margin: 0 0 4px; }
h3 { font-size: 20px; font-weight: 680; letter-spacing: -.018em; margin: 0 0 6px; }
h4.sub { font-size: 12.5px; font-weight: 620; color: var(--muted); margin: 22px 0 8px; }
.lede { color: var(--muted); font-size: 13.5px; margin: 0 0 14px; max-width: 62ch; }
.hint { color: var(--muted); font-size: 12.5px; margin: 10px 0 0; max-width: 68ch; }

/* ---------- setup ---------- */
.setup { padding: 20px 22px; margin-bottom: 22px; }
.steps { margin: 12px 0 0; padding-left: 20px; display: grid; gap: 14px; }
.steps li { padding-left: 4px; }
.steps p { margin: 0 0 10px; max-width: 68ch; color: var(--fg-soft); }
.keyout { margin-top: 12px; }

/* ---------- layout ---------- */
.grid { display: grid; grid-template-columns: 320px 1fr; gap: 20px; align-items: start; }
@media (max-width: 880px) { .grid { grid-template-columns: 1fr; } }
.stack { display: grid; gap: 20px; min-width: 0; }

.rail, .form, .rules, .panel { padding: 20px 22px; }

/* ---------- hosts ---------- */
#hostlist { display: grid; gap: 10px; margin: 4px 0 14px; }
.host {
  padding: 13px 14px; border-radius: var(--r-lg);
  background: var(--glass-strong); border: 1px solid var(--glass-line);
  box-shadow: var(--inset);
  transition: border-color .2s var(--ease), transform .2s var(--ease);
}
.host:hover { border-color: color-mix(in srgb, var(--blue) 45%, var(--glass-line)); }
.host-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.host-label { font-weight: 640; font-size: 14.5px; letter-spacing: -.01em; }
.host-target {
  margin: 7px 0 9px; font-size: 12.5px; color: var(--fg-soft);
  overflow-wrap: anywhere;
}
.host-target .user { color: var(--fg); font-weight: 560; }
.host-target .at, .host-target .port { color: var(--muted); }
.host-target .addr { font-variant-numeric: tabular-nums; }
.creds { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 11px; }
.host-actions { display: flex; gap: 7px; }

.chip {
  display: inline-flex; align-items: center; font-size: 11.5px; line-height: 1;
  padding: 4px 9px; border-radius: 99px;
  background: color-mix(in srgb, var(--muted) 12%, transparent);
  color: var(--muted); border: 1px solid transparent; white-space: nowrap;
}
.chip.ok { background: var(--ok-bg); color: var(--ok); }
.chip.warn { background: var(--warn-bg); color: var(--warn); }
.chip.err { background: var(--err-bg); color: var(--err); }
.chip.quiet { background: var(--code-bg); color: var(--muted); }

/* ---------- fields ---------- */
.fields { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.f { display: grid; gap: 5px; flex: 1 1 190px; min-width: 0; }
.f.narrow { flex: 0 0 96px; }
.f.wide2 { flex: 2 1 260px; }
.f > span { font-size: 12px; color: var(--muted); }
input, select, textarea, button { font: inherit; color: var(--fg); }
input, select, textarea {
  width: 100%; padding: 9px 11px;
  background: var(--field-bg); border: 1px solid var(--glass-line);
  border-radius: var(--r-md); transition: border-color .18s var(--ease), box-shadow .18s var(--ease);
}
input:focus, select:focus, textarea:focus, button:focus-visible {
  outline: none; border-color: var(--blue);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 22%, transparent);
}
textarea { font-size: 12.5px; line-height: 1.5; resize: vertical; }
.actions { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 4px; }
/* The authentication choice is a real choice, not two optional fields side by side: an operator
   picks one method and the other set disappears. */
.authmode { border: 0; margin: 0 0 12px; padding: 0; }
.authmode legend { padding: 0 0 7px; font-size: 11.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.mode { display: inline-flex; align-items: center; gap: 6px; margin-right: 18px; font-size: 13px; cursor: pointer; }
.mode input { margin: 0; }
/* Feedback lives next to the button that produced it. The result panel further down the page is
   where the full payload goes; it is not where a rejected click should have to be discovered. */
.formmsg { margin-top: 10px; font-size: 13px; line-height: 1.5; max-width: 68ch; }
.formmsg.ok { color: var(--ok); }
.formmsg.err { color: var(--err); }
.formmsg.busy { color: var(--muted); }

button {
  border: 1px solid var(--edge-line); background: var(--glass-strong);
  padding: 9px 16px; border-radius: var(--r-md); cursor: pointer;
  transition: transform .16s var(--ease), border-color .18s var(--ease), background .18s var(--ease);
}
button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--blue) 55%, var(--glass-line)); }
button:active:not(:disabled) { transform: translateY(1px) scale(.995); }
button:disabled { opacity: .55; cursor: default; }
button.primary {
  background: linear-gradient(135deg, var(--blue), var(--orchid));
  border-color: transparent; color: #fff; font-weight: 620;
  box-shadow: 0 10px 24px -12px var(--orchid), var(--inset);
}
:root[data-theme="dark"] button.primary { color: #0A0F1E; }
/* A gradient fill is the loudest thing available, so it is reserved for the one action that
   completes a panel — saving a host. Secondary creates ("add rule", "add host", "create tables")
   take the quiet treatment so the page has a single focal point instead of four. */
button.quiet { background: var(--glass-strong); font-weight: 560; }
button.ghost { background: transparent; }
button.small { padding: 7px 12px; font-size: 13px; }
button.wide { width: 100%; }
button.danger:hover:not(:disabled) { border-color: var(--err); color: var(--err); }

/* ---------- empty states ---------- */
.empty { padding: 16px; border-radius: var(--r-lg); border: 1px dashed var(--glass-line); }
.empty-line { margin: 0; font-size: 13.5px; }
.empty .hint { margin-top: 4px; }

/* ---------- the transfer spine (the hero) ---------- */
.spine { margin: 18px 0 6px; }
.spine-track {
  display: flex; gap: 3px; height: 4px; border-radius: 99px; overflow: hidden;
  background: var(--code-bg);
}
.spine-track .seg {
  display: block; height: 100%; border-radius: 99px;
  background: color-mix(in srgb, var(--blue) 42%, transparent);
  transform-origin: left center;
}
.spine-track .seg.peak { background: linear-gradient(90deg, var(--blue), var(--blush)); }
@media (prefers-reduced-motion: no-preference) {
  .spine-track .seg { animation: grow .55s var(--ease) both; }
}
@keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }

.spine-legend {
  list-style: none; margin: 12px 0 0; padding: 0;
  display: grid; gap: 1px;
}
.stage {
  display: grid; grid-template-columns: 1fr auto 46px; align-items: baseline; gap: 12px;
  padding: 7px 2px; border-bottom: 1px solid var(--glass-edge);
  font-size: 13px;
}
.stage:last-child { border-bottom: 0; }
.stage-name { color: var(--fg-soft); overflow-wrap: anywhere; }
.stage-ms { font-variant-numeric: tabular-nums; color: var(--fg); font-weight: 600; }
.stage-ms .unit { font-weight: 400; color: var(--muted); font-size: 11.5px; margin-left: 2px; }
.stage-pct { text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.spine-total {
  display: flex; align-items: baseline; gap: 6px; justify-content: flex-end;
  margin-top: 10px; font-size: 12.5px; color: var(--muted);
}
.spine-total strong { font-size: 17px; color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.spine-total .unit { font-size: 11.5px; }

/* ---------- result ---------- */
.result-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.result-title { margin: 0 0 2px; }

.facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 14px 0 0; }
.facts dt { color: var(--muted); font-size: 12.5px; }
.facts dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }

.failed { padding: 2px; }
.fail-msg {
  margin: 8px 0 0; padding: 12px 14px; border-radius: var(--r-md);
  background: var(--err-bg); color: var(--err); font-size: 13.5px; overflow-wrap: anywhere;
}

.evals { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.eval { padding: 12px 13px; border-radius: var(--r-lg); background: var(--field-bg); border: 1px solid var(--glass-line); }
.eval-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eval-detail { margin: 9px 0 0; font-size: 12.5px; color: var(--muted); }
.eval-detail.warn { color: var(--warn); }
.eval-detail.bad { color: var(--err); }

.pattern {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12.5px; background: var(--code-bg); padding: 3px 7px; border-radius: 6px;
  overflow-wrap: anywhere;
}
.files { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.file {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; padding: 3px 7px; border-radius: 6px;
  background: var(--glass-strong); border: 1px solid var(--glass-line); color: var(--fg-soft);
}
.file.more { color: var(--muted); }

.rules-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 1px; }
.rule {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  padding: 10px 2px; border-bottom: 1px solid var(--glass-edge);
}
.rule:last-child { border-bottom: 0; }
.rule-tail { margin-left: auto; }

/* --- combined files -------------------------------------------------------------------------
   The three classes below were used by the merge panel before any rule defined them, which is the
   failure mode this project has already been bitten by once: an undefined class does not error, it
   silently renders with no styling, so the panel looks like a layout mistake rather than a missing rule.
   Section padding is shared explicitly with every management panel.

   No backticks in these comments either: the whole document is one outer template literal, so a backtick
   anywhere - styles included - ends it early. The guard that checks for this used to look only at the
   script body, which is how these three got through and broke the build. */
.merge-preview {
  margin-top: 12px; padding: 12px 14px; border-radius: var(--r-lg);
  background: var(--glass-strong); border: 1px solid var(--glass-line);
}
/* A refused preview is tinted rather than only worded: the message is the detail, the colour is what makes it
   noticeable while scrolling past. The warn variable is the one that exists - an earlier version of this rule
   used a warn-line variable I had invented, which would have silently fallen back to the glass line and made
   the tint invisible rather than obviously wrong. */
.merge-preview.bad { border-color: var(--warn); }
.merge-preview .hint { margin: 0 0 6px; }
.merge-preview .hint:last-child { margin-bottom: 0; }

/* One row per source pattern. The count is what the operator is reading, so it sits at the end of the row
   where the eye lands after the pattern it belongs to. */
.merge-pattern {
  display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
  padding: 5px 0; border-top: 1px solid var(--glass-edge);
}
.merge-pattern:first-of-type { border-top: 0; }

.merge-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }

/* --- storage --------------------------------------------------------------------------------
   The fill changes colour with how full the store is, because a number alone does not say whether anything is
   about to happen: below 70 percent nothing will, above 90 the next file starts deleting things. Two thresholds
   rather than a gradient, so the state is readable at a glance rather than judged by eye. */
.usage-bar {
  height: 8px; border-radius: 999px; overflow: hidden; margin: 12px 0 10px;
  background: var(--glass-strong); border: 1px solid var(--glass-line);
}
.usage-fill { height: 100%; border-radius: 999px; background: var(--ok); transition: width .25s ease; }
.usage-fill.warm { background: var(--warn); }
.usage-fill.hot { background: var(--err); }
.usage-line { margin: 0 0 4px; font-size: 13px; color: var(--fg); }

.reveal { margin-top: 18px; }
.reveal summary {
  cursor: pointer; font-size: 12.5px; color: var(--muted);
  padding: 6px 0; list-style: none;
}
.reveal summary::-webkit-details-marker { display: none; }
.reveal summary::before { content: "▸ "; }
.reveal[open] summary::before { content: "▾ "; }
.reveal summary:hover { color: var(--fg); }

pre.raw {
  margin: 8px 0 0; padding: 14px; border-radius: var(--r-lg);
  background: var(--code-bg); border: 1px solid var(--glass-line);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 1.55; overflow: auto; max-height: 340px;
  color: var(--fg-soft);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}

/* ---------- narrow screens ----------
   The control cluster (four language names plus three appearance buttons) is the widest intrinsic
   block on the page: measured at ~375px against ~380px of available width, which pushed the whole
   document wider than the viewport and clipped every panel. Narrowing the cluster and the page
   gutter is what removes the horizontal overflow; hiding horizontal overflow would only disguise it. */
@media (max-width: 560px) {
  .shell { padding: 14px 12px 48px; }
  .bar { gap: 10px; padding: 11px 12px; margin-bottom: 16px; }
  .segbtn { padding: 5px 7px; font-size: 11.5px; }
  .segbtn.icon { padding: 5px 7px; }
  .wordmark { font-size: 16px; }
  .rail, .form, .rules, .panel, .setup { padding: 16px 15px; }
  .f, .f.wide2 { flex: 1 1 100%; }
  .f.narrow { flex: 1 1 100%; }
  .fields { gap: 10px; }
  .stage { grid-template-columns: 1fr auto 40px; gap: 8px; }
  h3 { font-size: 18px; }
}
${WORKFLOW_STYLES}
`;
