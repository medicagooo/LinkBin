import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { PROFILE_SOURCES } from '../src/proxy-profile';
import { stringify } from 'yaml';

let cookie = '';
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(TEST_BASE_URL + path, init),
  { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
const post = (path: string, body: unknown, signed = true) => call(path, { method: 'POST',
  headers: { 'content-type': 'application/json', ...(signed ? { cookie } : {}) }, body: JSON.stringify(body) });
const upload = (name: string, text = 'file contents') => call('/api/files/upload?name=' + encodeURIComponent(name), {
  method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: text,
});
async function uploaded(name = 'test.yaml', text = 'file contents') {
  const response = await upload(name, text);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as any).objectId as number;
}
async function link(id: number) {
  const response = await post('/api/file-links', { objectId: id });
  expect(response.status).toBe(200);
  return (await response.json() as any).link;
}
beforeEach(async () => {
  await call('/api/admin/apply-schema', { method: 'POST' });
  for (const table of ['file_links', 'derived_objects', 'derived_rules', 'object_sources', 'object_flags', 'object_reclaims', 'multipart_sessions', 'shares', 'objects', 'auth_attempts', 'auth_secret']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM hosts WHERE id != '@derived'").run();
  const inventory = await env.BUCKET.list();
  for (const object of inventory.objects) await env.BUCKET.delete(object.key);
  await post('/api/auth/setup', { password: 'test operator password' }, false);
  const login = await post('/api/auth/login', { password: 'test operator password' }, false);
  cookie = /linkbin_session=[^;]+/.exec(login.headers.get('set-cookie')!)![0];
});

describe('R2 file management and direct links', () => {
  it('requires an operator session for uploads, downloads, deletes and link management', async () => {
    for (const [path, method] of [['/api/files/upload?name=x', 'POST'], ['/api/files/download?id=1', 'GET'], ['/api/files/delete', 'POST'], ['/api/file-links', 'GET'], ['/api/file-links', 'POST'], ['/api/file-links/revoke', 'POST']]) {
      expect((await call(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status).toBe(401);
    }
  });
  it('streams uploaded files for an operator and supports HEAD and Unicode filenames', async () => {
    const id = await uploaded('中文配置.yaml', '中文正文');
    const response = await call(`/api/files/download?id=${id}`, { headers: { cookie } });
    expect(await response.text()).toBe('中文正文');
    expect(response.headers.get('content-disposition')).toContain('filename*=UTF-8');
    const head = await call(`/api/files/download?id=${id}`, { method: 'HEAD', headers: { cookie } });
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe('12');
    const hosts = await (await call('/api/hosts', { headers: { cookie } })).json() as any;
    expect(hosts.hosts).toHaveLength(0);
    expect((await (await call('/api/status')).json() as any).hosts.count).toBe(0);
  });
  it('keeps a direct URL stable across replacement, reuses it, and immediately revokes the old token', async () => {
    const id = await uploaded('subscription.yaml', 'version one');
    const first = await link(id);
    expect((await link(id)).url).toBe(first.url);
    expect(await (await worker.fetch(new Request(first.url), env as never, {} as never)).text()).toBe('version one');
    const updated = await uploaded('subscription.yaml', 'version two');
    expect((await link(updated)).url).toBe(first.url);
    const path = new URL(first.url).pathname;
    expect(await (await call(path)).text()).toBe('version two');
    expect((await call(path, { method: 'HEAD' })).headers.get('content-length')).toBe('11');
    expect((await call(path, { method: 'POST' })).status).toBe(405);
    expect((await post('/api/file-links/revoke', { token: first.token })).status).toBe(200);
    expect((await call(path)).status).toBe(410);
    const next = await link(updated);
    expect(next.url).not.toBe(first.url);
    expect((await (await call('/api/file-links', { headers: { cookie } })).json() as any).links).toHaveLength(2);
  });
  it('deletes bytes and accounts reclaimed capacity; links and snapshots stop downloading', async () => {
    const id = await uploaded();
    const direct = await link(id);
    const share = await (await post('/api/shares', { objectId: id, password: 'password123' })).json() as any;
    expect((await post('/api/files/delete', { id })).status).toBe(200);
    expect((await call(new URL(direct.url).pathname)).status).toBe(410);
    expect((await call(new URL(share.share.url).pathname, { headers: { 'x-share-password': 'password123' } })).status).toBe(410);
    expect((await (await call('/api/usage', { headers: { cookie } })).json() as any).usage.totalBytes).toBe(0);
    const replacement = await uploaded('test.yaml', 'new private contents');
    expect((await call(new URL(direct.url).pathname)).status).toBe(410);
    expect((await link(replacement)).url).not.toBe(direct.url);
  });
  it('permanently revokes a current file link when capacity reclaims it', async () => {
    const id = await uploaded();
    const direct = await link(id);
    // Simulate a budget-filling managed object without allocating ten GiB in an offline test.
    await env.DB.prepare('UPDATE objects SET size_bytes = ? WHERE id = ?').bind(10 * 1024 * 1024 * 1024, id).run();
    const response = await post('/api/usage/reclaim', { sizeBytes: 1 });
    expect(response.status, await response.clone().text()).toBe(200);
    await uploaded('test.yaml', 'new private contents');
    expect((await call(new URL(direct.url).pathname)).status).toBe(410);
  });
  it('stops an upload at its server deadline and releases the shared writer lease', async () => {
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let canceled = false;
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { canceled = true; } });
    const request = new Request(TEST_BASE_URL + '/api/files/upload?name=stalled.bin', { method: 'POST', headers: { cookie }, body: source });
    try {
      const pending = worker.fetch(request, { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
      for (let attempt = 0; attempt < 200 && !request.body!.locked; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
      expect(request.body!.locked).toBe(true);
      clock += 120_001;
      controller.enqueue(new Uint8Array([1]));
      const response = await pending;
      expect(response.status).toBe(413);
      expect(await response.text()).toMatch(/time budget/);
      expect(canceled).toBe(true);
      expect(await env.DB.prepare("SELECT id FROM multipart_sessions WHERE id = '@storage-writer'").first()).toBeNull();
    } finally { now.mockRestore(); }
    expect((await upload('after-timeout.txt')).status).toBe(200);
  });
  it.each(['../bad.yaml', 'folder/file.yaml', 'x\\bad.yaml', 'x\nyaml', ''])('refuses unsafe upload names: %j', async name => {
    expect((await upload(name)).status).toBe(400);
  });
  it('refuses excessive declared sizes before reading and keeps the prior version', async () => {
    const id = await uploaded();
    const direct = await link(id);
    const response = await call('/api/files/upload?name=test.yaml', { method: 'POST', headers: { cookie,
      'content-length': String(100 * 1024 * 1024 + 1) }, body: 'too large declaration' });
    expect(response.status).toBe(413);
    expect(await (await call(new URL(direct.url).pathname)).text()).toBe('file contents');
  });
  it('runs the profile from uploaded files and automatically refreshes a stable output link on source upload', async () => {
    for (const [name, label] of PROFILE_SOURCES) await uploaded(name, stringify({ proxies: [{ name: label + '-vless', type: 'vless', server: 'node.invalid' }] }));
    const definition = { outputName: 'merged-all.yaml', combination: 'proxy-profile', sources: PROFILE_SOURCES.map(([name]) => ({ pattern: '/' + name })) };
    const saved = await (await post('/api/derived', definition)).json() as any;
    expect(saved.id).toBeTruthy();
    const run = await post('/api/derived/run', { id: saved.id });
    expect(run.status, await run.clone().text()).toBe(200);
    const body = await run.json() as any;
    const objects = await (await call('/api/objects', { headers: { cookie } })).json() as any;
    const output = objects.objects.find((object: any) => object.path === '/merged-all.yaml');
    const direct = await link(output.id);
    const first = await (await call(new URL(direct.url).pathname)).text();
    expect(first).toContain('ByteVirt-vless');
    const invalid = await upload('bytevirt.yaml', 'proxies: []');
    expect(invalid.status).toBe(200);
    expect((await invalid.json() as any).mergeIssues).toHaveLength(1);
    expect(await (await call(new URL(direct.url).pathname)).text()).toBe(first);
    const update = await upload('bytevirt.yaml', stringify({ proxies: [{ name: 'ByteVirt-updated', type: 'vless', server: 'node.invalid' }] }));
    expect((await update.json() as any).mergeIssues).toEqual([]);
    expect(await (await call(new URL(direct.url).pathname)).text()).toContain('ByteVirt-updated');
    const source = (await (await call('/api/objects', { headers: { cookie } })).json() as any).objects.find((object: any) => object.path === '/bytevirt.yaml');
    expect((await post('/api/files/delete', { id: source.id })).status).toBe(409);
  });
});

describe('password-confirmed recipient downloads', () => {
  it('shows a browser form, escapes the filename, refuses wrong passwords, and downloads only after POST verification', async () => {
    const id = await uploaded('<script>.yaml', 'private payload');
    const share = (await (await post('/api/shares', { objectId: id, password: 'password123' })).json() as any).share;
    const path = new URL(share.url).pathname;
    const page = await call(path, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('method="post"');
    expect(html).toContain('&lt;script&gt;.yaml');
    expect(html).not.toContain('private payload');
    expect(html).not.toContain('password123');
    expect((await call(path)).status).toBe(401); // Existing JSON clients remain compatible.
    const wrong = await call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=incorrect' });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('密码错误');
    const download = await call(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=password123' });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('private payload');
    expect(download.headers.get('cache-control')).toBe('no-store');
  });
  it('preserves snapshot behavior after replacement and refuses oversized or unsupported submissions', async () => {
    const id = await uploaded();
    const share = (await (await post('/api/shares', { objectId: id, password: 'password123' })).json() as any).share;
    const path = new URL(share.url).pathname;
    expect((await call(path, { method: 'DELETE' })).status).toBe(405);
    for (const [type, body] of [['application/json', '{"password":"password123"}'], ['application/x-www-form-urlencoded', 'password=password123&padding=' + 'x'.repeat(70000)]]) {
      expect((await call(path, { method: 'POST', headers: { 'content-type': type }, body })).headers.get('content-type')).toContain('text/html');
    }
    await uploaded('test.yaml', 'replacement');
    expect((await call(path, { headers: { 'x-share-password': 'password123' } })).status).toBe(410);
  });
  it.each(['x'.repeat(1025), '密'.repeat(1024)])('accepts long legacy or form-encoded Unicode passwords', async password => {
    const id = await uploaded();
    const created = await post('/api/shares', { objectId: id, password });
    expect(created.status).toBe(200);
    const share = (await created.json() as any).share;
    const response = await call(new URL(share.url).pathname, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password }).toString() });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('file contents');
  });
});
