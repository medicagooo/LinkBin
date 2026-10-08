import vm from 'node:vm';
import { renderIndexPage } from '../src/ui.ts';

// Runs the emitted client script with controlled DOM and API ports. CSS is verified in a browser.
class Element {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.children = []; this.listeners = {};
    this.className = attrs.class || ''; this.value = attrs.value || ''; this.checked = 'checked' in attrs;
    this.disabled = 'disabled' in attrs; this.hidden = 'hidden' in attrs; this.style = {}; this._text = '';
    this.classList = { add: (...names) => { this.className = [...new Set(this.className.split(' ').concat(names))].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(n => !names.includes(n)).join(' '); },
      toggle: (name, force) => { const has = this.className.split(' ').includes(name); const on = force ?? !has; this.classList[on ? 'add' : 'remove'](name); return on; },
      contains: name => this.className.split(' ').includes(name) };
  }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = value; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }
  get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    child.parentNode = this; this.children.splice(this.children.indexOf(reference), 0, child); return child;
  }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  async dispatch(name, extra = {}) { for (const listener of this.listeners[name] || []) await listener({ target: this, preventDefault() {}, ...extra }); }
  matches(selector) {
    if (selector === '*') return true;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) return attr[1] in this.attrs && (attr[2] === undefined || this.attrs[attr[1]] === attr[2]);
    const [tag, ...classes] = selector.split('.');
    return (!tag || this.tagName === tag.toUpperCase()) && classes.every(c => this.className.split(' ').includes(c));
  }
  querySelectorAll(selector) { return this.children.flatMap(c => (c.matches(selector) ? [c] : []).concat(c.querySelectorAll(selector))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  scrollIntoView() {}
}

export const file = { id: 1, path: '/configs/a.yaml', hostId: 'demo', sizeBytes: 42, live: true, bytesPresent: true, createdAt: '2026-10-08T00:00:00Z' };
export const host = { id: 'demo', label: 'Demo host', address: 'example.test', port: 22, username: 'test', enabled: true, credential: { kind: 'password', fingerprint: 'fixture' } };

export function fixture(path) {
  const url = new URL(path, 'http://localhost');
  const data = {
    '/api/auth/state': { configured: true, signedIn: true },
    '/api/status': { masterKeySet: true, schema: { ready: true }, r2Bound: true },
    '/api/hosts': { hosts: [host] }, '/api/rules': { rules: [] },
    '/api/objects': { objects: [file], total: 1, limit: 50 },
    '/api/usage': { usage: { totalBytes: 42, budgetBytes: 10737418240, remainingBytes: 10737418198, usedFraction: 0.000000004, maxFileBytes: 104857600, importantBytes: 0, retainedBytes: 0 } },
    '/api/shares': { shares: [] }, '/api/file-links': { links: [] }, '/api/runs': { runs: [] },
    '/api/freshness': { machines: [], neverCount: 0, worstSeconds: null, targetSeconds: 300 },
    '/api/derived/status': { rules: [] },
  };
  return data[url.pathname] || { ok: true };
}

export async function page(overrides = {}, options = {}) {
  const html = renderIndexPage(options.locale || 'en');
  const document = new Element('document');
  const stack = [document];
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const token of markup.matchAll(/<\/?[\w-]+\b[^>]*>|[^<]+/g)) {
    const text = token[0];
    if (text.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!text.startsWith('<')) { stack.at(-1)._text += text; continue; }
    const tag = text.match(/^<([\w-]+)/)[1]; const attrs = {};
    for (const match of text.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)) attrs[match[1]] = match[2] ?? match[3] ?? '';
    const element = new Element(tag, attrs); stack.at(-1).appendChild(element);
    if (!['input','meta','link','br','hr','img'].includes(tag)) stack.push(element);
  }
  document.documentElement = document.querySelector('html'); document.body = document.querySelector('body');
  document.getElementById = id => document.querySelector('#' + id);
  document.createElement = tag => new Element(tag);
  document.execCommand = () => options.legacyCopy ?? true;
  const calls = [];
  const context = { document, console, URL, URLSearchParams, AbortController, navigator: { language: options.locale || 'en', clipboard: options.clipboard },
    location: { search: '', hash: '', origin: 'http://localhost' }, localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout: (fn, ms) => { if (ms < 1000) queueMicrotask(fn); return 1; }, clearTimeout() {},
    alert() {}, confirm: () => true,
    fetch: async (path, init = {}) => {
      calls.push({ path, ...init });
      const route = new URL(path, 'http://localhost').pathname;
      const response = overrides[route];
      const result = typeof response === 'function' ? await response(path, init) : response ?? fixture(path);
      if (result instanceof Error) throw result;
      const status = result?.status || 200; const body = result?.body ?? result;
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
    },
  };
  context.window = context;
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  return { document, calls, flush, get: id => document.getElementById(id), async click(id) { await document.getElementById(id).dispatch('click'); await flush(); } };
}
