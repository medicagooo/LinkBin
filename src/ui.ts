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
<a class="skiplink" href="#panel" data-i18n="skip">Skip to content</a>

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

  <main class="grid">
    <section class="glass rail" aria-labelledby="hosts-h">
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
        <div class="fields">
          <label class="f"><span data-i18n="form.password">Password</span><input id="f-password" type="password" autocomplete="new-password"></label>
          <label class="f"><span data-i18n="form.passphrase">Key passphrase</span><input id="f-passphrase" type="password" autocomplete="new-password"></label>
        </div>
        <label class="f"><span data-i18n="form.privateKey">Private key</span><textarea id="f-key" rows="3" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
        <p class="hint" data-i18n="form.hint"></p>
        <div class="actions">
          <button class="primary" id="saveHost" data-i18n="form.save">Save host</button>
          <button class="ghost" id="cancelHost" data-i18n="form.cancel">Cancel</button>
        </div>
      </section>

      <section class="glass rules" aria-labelledby="rules-h">
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

      <section class="glass panel" id="panel" aria-labelledby="result-h">
        <h2 id="result-h" data-i18n="result.title">Connection test</h2>
        <div id="result"><p class="lede" data-i18n="result.empty"></p></div>
      </section>
    </div>
  </main>
</div>

<script>
(function () {
  'use strict';

  var BOOT = { locale: ${JSON.stringify(locale)}, locales: ${JSON.stringify(LOCALES)}, labels: ${JSON.stringify(LOCALE_LABELS)} };

  var T = ${translationsLiteral()};

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
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function api(path, options) {
    var opts = options || {};
    opts.headers = { 'content-type': 'application/json' };
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        return { status: res.status, ok: res.ok, body: body };
      });
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
        api('/api/rules/delete', { method: 'POST', body: JSON.stringify({ id: r.id }) }).then(function () { loadRules(); });
      });
      var tail = node('div', 'rule-tail');
      tail.appendChild(del);
      li.appendChild(tail);
      list.appendChild(li);
    });
    host.appendChild(list);
  }

  // --- data ----------------------------------------------------------------------------------
  function loadStatus() {
    return api('/api/status').then(function (r) {
      renderMeters(r.body);
      renderSetup(r.body);
    });
  }

  function loadHosts() {
    return api('/api/hosts').then(function (r) { renderHosts(r.body.hosts || []); });
  }

  function loadRules() {
    return api('/api/rules').then(function (r) { renderRules(r.body.rules || []); });
  }

  function refreshAll() {
    applyStaticText();
    renderLangSwitch();
    renderThemeSwitch();
    loadStatus();
    loadHosts();
    loadRules();
  }

  // --- events --------------------------------------------------------------------------------
  $('addToggle').addEventListener('click', function () {
    var form = $('hostform');
    form.hidden = !form.hidden;
    if (!form.hidden) $('f-label').focus();
  });

  $('cancelHost').addEventListener('click', function () { $('hostform').hidden = true; });

  $('saveHost').addEventListener('click', function () {
    var payload = {
      label: $('f-label').value,
      address: $('f-address').value,
      port: Number($('f-port').value || 22),
      username: $('f-username').value,
      password: $('f-password').value,
      privateKey: $('f-key').value,
      privateKeyPassphrase: $('f-passphrase').value
    };
    api('/api/hosts', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      showRaw(r.ok && r.body.ok ? t('form.saved') : t('result.failed'), r.body);
      if (r.ok && r.body.ok) {
        // Nothing sensitive should linger in the DOM after a save.
        $('f-password').value = '';
        $('f-key').value = '';
        $('f-passphrase').value = '';
        $('hostform').hidden = true;
        refreshAll();
      }
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

  refreshAll();

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
			'form.password': 'Password',
			'form.passphrase': 'Key passphrase',
			'form.privateKey': 'Private key',
			'form.hint': 'Credentials are encrypted in the Worker before they reach the database and are never sent back to this page. Leaving a field empty keeps whatever is already stored.',
			'form.save': 'Save host',
			'form.cancel': 'Cancel',
			'form.saved': 'Host saved',
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
			'theme.dark': 'Dark',
		},
		'zh-CN': {
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
			'form.password': '密码',
			'form.passphrase': '私钥口令',
			'form.privateKey': '私钥',
			'form.hint': '凭据在 Worker 内加密后才写入数据库，并且永远不会回传到本页面。留空表示保留已存储的值。',
			'form.save': '保存主机',
			'form.cancel': '取消',
			'form.saved': '主机已保存',
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
			'theme.dark': '深色',
		},
		'zh-TW': {
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
			'form.password': '密碼',
			'form.passphrase': '私鑰口令',
			'form.privateKey': '私鑰',
			'form.hint': '憑證在 Worker 內加密後才寫入資料庫，而且永遠不會回傳到本頁面。留空表示保留已儲存的值。',
			'form.save': '儲存主機',
			'form.cancel': '取消',
			'form.saved': '主機已儲存',
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
			'theme.dark': '深色',
		},
		ja: {
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
			'form.password': 'パスワード',
			'form.passphrase': '鍵のパスフレーズ',
			'form.privateKey': '秘密鍵',
			'form.hint': '認証情報は Worker 内で暗号化してからデータベースに入り、この画面へ戻ることはありません。空欄のままにすると保存済みの値が維持されます。',
			'form.save': 'ホストを保存',
			'form.cancel': 'キャンセル',
			'form.saved': 'ホストを保存しました',
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
			'theme.dark': 'ダーク',
		},
	};
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
`;
