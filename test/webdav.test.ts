import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { parseWebDavResponses } from '../src/webdav-remote';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';

const password = 'test operator password';
const basic = `Basic ${btoa(`desktop:${password}`)}`;
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(TEST_BASE_URL + path, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
const dav = (path: string, init: RequestInit = {}) => call(path, { ...init, headers: { authorization: basic, ...(init.headers ?? {}) } });

beforeEach(async () => {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['source_profiles', 'objects', 'auth_attempts', 'auth_secret']) await env.DB.prepare(`DELETE FROM ${table}`).run();
	await env.DB.prepare("DELETE FROM hosts WHERE id != '@derived'").run();
	for (const item of (await env.BUCKET.list()).objects) await env.BUCKET.delete(item.key);
	await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
});

describe('WebDAV R2 surface', () => {
	it('requires Basic authentication and exposes R2 files with WebDAV metadata', async () => {
		expect((await call('/dav/')).status).toBe(401);
		const put = await dav('/dav/uploads/hello.txt', { method: 'PUT', body: 'hello' });
		expect(put.status).toBe(201);
		const etag = put.headers.get('etag');
		expect(etag).toMatch(/^"/);
		const listing = await dav('/dav/uploads/', { method: 'PROPFIND', headers: { depth: '1' } });
		expect(listing.status).toBe(207);
		expect(await listing.text()).toContain('hello.txt');
		const get = await dav('/dav/uploads/hello.txt');
		expect(await get.text()).toBe('hello');
		expect(get.headers.get('etag')).toBe(etag);
		const head = await dav('/dav/uploads/hello.txt', { method: 'HEAD' });
		expect(await head.text()).toBe('');
		expect(head.headers.get('content-length')).toBe('5');
	});

	it('protects replacements and implements COPY, MOVE and DELETE', async () => {
		const first = await dav('/dav/uploads/a.txt', { method: 'PUT', body: 'one' });
		const stale = first.headers.get('etag')!;
		expect((await dav('/dav/uploads/a.txt', { method: 'PUT', headers: { 'if-match': '"stale"' }, body: 'two' })).status).toBe(412);
		const updated = await dav('/dav/uploads/a.txt', { method: 'PUT', headers: { 'if-match': stale }, body: 'two' });
		expect(updated.status).toBe(204);
		expect((await dav('/dav/uploads/a.txt', { method: 'COPY', headers: { destination: `${TEST_BASE_URL}/dav/uploads/c.txt` } })).status).toBe(201);
		expect((await dav('/dav/uploads/a.txt', { method: 'COPY', headers: { destination: `${TEST_BASE_URL}/dav/uploads/c.txt`, overwrite: 'F' } })).status).toBe(412);
		expect((await dav('/dav/uploads/c.txt', { method: 'MOVE', headers: { destination: `${TEST_BASE_URL}/dav/uploads/d.txt` } })).status).toBe(201);
		expect(await (await dav('/dav/uploads/d.txt')).text()).toBe('two');
		expect((await dav('/dav/uploads/d.txt', { method: 'DELETE' })).status).toBe(204);
		expect((await dav('/dav/uploads/d.txt')).status).toBe(404);
		expect((await dav('/dav/', { method: 'OPTIONS' })).headers.get('dav')).toBe('1');
		expect((await dav('/dav/uploads/a.txt', { method: 'LOCK' })).status).toBe(405);
	});

	it('rejects traversal and unsupported SMB source configuration', async () => {
		expect([400, 404]).toContain((await dav('/dav/uploads/%2e%2e/%2e%2e/secret')).status);
		const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
		const cookie = login.headers.get('set-cookie')!.split(';')[0];
		const profile = await call('/api/source-profiles', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'smb', protocol: 'smb', endpoint: 'https://files.invalid', username: 'u', password: 'p' }) });
		expect(profile.status).toBe(501);
		const httpProfile = await call('/api/source-profiles', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'plain', endpoint: 'http://files.invalid', username: 'u', password: 'p' }) });
		expect(httpProfile.status).toBe(400);
		const embeddedCredentials = await call('/api/source-profiles', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'embedded', endpoint: 'https://u:p@files.invalid', username: 'u', password: 'p' }) });
		expect(embeddedCredentials.status).toBe(400);
	});
});

describe('WebDAV XML parsing', () => {
	it('parses collection, size, mtime and etag without trusting remote paths', () => {
		const entries = parseWebDavResponses(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>https://remote.test/root/a.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getetag>"abc"</d:getetag></d:prop></d:propstat></d:response><d:response><d:href>https://remote.test/root/folder/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`);
		expect(entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: 'a.txt', size: 12, isDirectory: false, version: 'abc' }),
			expect.objectContaining({ name: 'folder', isDirectory: true }),
		]));
		expect(parseWebDavResponses('<d:multistatus xmlns:d="DAV:"><d:response><d:href>%E0%A4%A</d:href></d:response></d:multistatus>')).toEqual([]);
	});
});
