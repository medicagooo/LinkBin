import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Sharing, end to end through the request/response edge.
 *
 * A share is the one route where an unauthenticated caller can obtain file bytes, so these check the
 * boundary from both sides: the recipient must be able to download with nothing but the link and the
 * password, and must not be able to obtain anything else — not another file, not the machine's path, not
 * the file after the link has died, and not the file without the password when one is set.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long interface password';

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

let token = '';
let objectId = 0;

const CONTENT = 'the stored bytes';

async function bootstrap(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['shares', 'object_flags', 'objects', 'hosts', 'auth_secret', 'auth_attempts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	token = /linkbin_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];

	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'h.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();

	const bytes = new TextEncoder().encode(CONTENT);
	await env.BUCKET.put('objects/h1/etc/config.yaml', bytes);
	await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', '/etc/config.yaml', 'objects/h1/etc/config.yaml', ?, 'hash-1', '2026-01-01T00:00:00Z')`,
	)
		.bind(bytes.byteLength)
		.run();
	objectId = Number((await env.DB.prepare('SELECT id FROM objects').first<{ id: number }>())!.id);
}

function asOperator(path: string, init?: RequestInit): Promise<Response> {
	return call(path, { ...init, headers: { 'content-type': 'application/json', cookie: `linkbin_session=${token}`, ...(init?.headers ?? {}) } });
}

async function newShare(body: Record<string, unknown> = {}): Promise<any> {
	const res = await asOperator('/api/shares', { method: 'POST', body: JSON.stringify({ objectId, ...body }) });
	return { status: res.status, body: (await res.json()) as any };
}

describe('issuing a share', () => {
	beforeEach(bootstrap);

	it('returns a link on this deployment, not a storage hostname', async () => {
		const { status, body } = await newShare();
		expect(status).toBe(200);
		expect(body.share.url.startsWith(`${BASE}/s/`)).toBe(true);
		// Nothing about the bucket or its hostname is exposed.
		expect(body.share.url).not.toContain('r2');
		expect(body.share.url).not.toContain('objects/');
	});

	it('defaults to a couple of hours rather than a fixed unchangeable value', async () => {
		const { body } = await newShare();
		const lifetimeMs = Date.parse(body.share.expiresAt) - Date.now();
		expect(lifetimeMs).toBeGreaterThan(90 * 60 * 1000);
		expect(lifetimeMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 5000);
	});

	it('honours a stated lifetime', async () => {
		const { body } = await newShare({ seconds: 60 });
		const lifetimeMs = Date.parse(body.share.expiresAt) - Date.now();
		expect(lifetimeMs).toBeLessThanOrEqual(61_000);
	});

	it('refuses a lifetime beyond the stated maximum', async () => {
		const { status, body } = await newShare({ seconds: 7 * 24 * 60 * 60 });
		expect(status).toBe(400);
		expect(body.error).toMatch(/longest|maximum/i);
	});

	it('refuses an empty password rather than creating a share that only looks protected', async () => {
		const { status, body } = await newShare({ password: '' });
		expect(status).toBe(400);
		expect(body.error).toMatch(/empty/i);
	});

	it('refuses a file that does not exist', async () => {
		const res = await asOperator('/api/shares', { method: 'POST', body: JSON.stringify({ objectId: 999999 }) });
		expect(res.status).toBe(404);
	});

	it('requires a signed-in operator', async () => {
		const res = await call('/api/shares', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId }) });
		expect(res.status).toBe(401);
	});
});

describe('a recipient with the link', () => {
	beforeEach(bootstrap);

	it('downloads the file with no account and no other access', async () => {
		const { body } = await newShare();
		const res = await call(`/s/${body.share.token}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(CONTENT);
	});

	it('is told the size and filename before the download starts', async () => {
		const { body } = await newShare();
		const res = await call(`/s/${body.share.token}`);
		expect(res.headers.get('content-length')).toBe(String(CONTENT.length));
		expect(res.headers.get('content-disposition')).toContain('config.yaml');
	});

	it('is not told where the file lives on the machine', async () => {
		// The recipient was given one file, not an inventory of somebody's server. Checked on the metadata the
		// password prompt returns, since that is the response an unauthenticated caller can actually obtain —
		// a share with no password returns the file itself, so there is no metadata response to inspect.
		const { body } = await newShare({ password: 'shared-secret' });
		const res = await call(`/s/${body.share.token}`);
		expect(res.status).toBe(401);

		const raw = await res.text();
		expect(raw).not.toContain('/etc/');
		expect(raw).not.toContain('h1');
		expect(raw).not.toContain('objects/');
		// What it may say: the filename, the size, and that a password is needed.
		const payload = JSON.parse(raw) as any;
		expect(payload.file.filename).toBe('config.yaml');
		expect(payload.file.sizeBytes).toBe(CONTENT.length);
	});

	it('refuses a token that was never issued, without saying whether it once existed', async () => {
		const res = await call('/s/nothing-like-a-real-token');
		expect(res.status).toBe(404);
	});

	it('grants access to one file and cannot be edited into granting another', async () => {
		// The token names a share row, and the row names one object. There is no parameter that redirects it.
		const { body } = await newShare();
		const res = await call(`/s/${body.share.token}?objectId=2&path=/etc/shadow`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(CONTENT);
	});
});

describe('an expired link', () => {
	beforeEach(bootstrap);

	it('stops working, and says it expired rather than looking like a server fault', async () => {
		const { body } = await newShare();
		await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE token = ?')
			.bind(new Date(Date.now() - 1000).toISOString(), body.share.token)
			.run();

		const res = await call(`/s/${body.share.token}`);
		expect(res.status).toBe(410);
		const payload = (await res.json()) as any;
		expect(payload.reason).toBe('expired');
		expect(payload.error).toMatch(/expired/i);
	});
});

describe('a cancelled link', () => {
	beforeEach(bootstrap);

	it('stops working, and is refused distinctly from an expired one', async () => {
		const { body } = await newShare();
		const revoked = await asOperator('/api/shares/revoke', { method: 'POST', body: JSON.stringify({ token: body.share.token }) });
		expect(revoked.status).toBe(200);

		const res = await call(`/s/${body.share.token}`);
		expect(res.status).toBe(410);
		const payload = (await res.json()) as any;
		expect(payload.reason).toBe('revoked');
		// Distinct wording, so a recipient can tell their link was stopped rather than never valid.
		expect(payload.error).toMatch(/cancel/i);
	});

	it('cannot be revoked twice, so a typo does not silently report success', async () => {
		const { body } = await newShare();
		await asOperator('/api/shares/revoke', { method: 'POST', body: JSON.stringify({ token: body.share.token }) });
		const again = await asOperator('/api/shares/revoke', { method: 'POST', body: JSON.stringify({ token: body.share.token }) });
		expect(again.status).toBe(404);
	});

	it('requires a signed-in operator to cancel', async () => {
		const { body } = await newShare();
		const res = await call('/api/shares/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: body.share.token }) });
		expect(res.status).toBe(401);
	});
});

describe('a link with a password', () => {
	beforeEach(bootstrap);

	it('refuses without the password, and serves nothing at all', async () => {
		const { body } = await newShare({ password: 'shared-secret' });
		const res = await call(`/s/${body.share.token}`);
		expect(res.status).toBe(401);
		const payload = (await res.json()) as any;
		expect(payload.reason).toBe('password_required');
		// The refusal must not carry any of the file.
		expect(JSON.stringify(payload)).not.toContain(CONTENT);
	});

	it('refuses a wrong password, and serves nothing at all', async () => {
		const { body } = await newShare({ password: 'shared-secret' });
		const res = await call(`/s/${body.share.token}?password=wrong`);
		expect(res.status).toBe(401);
		expect(JSON.stringify(await res.json())).not.toContain(CONTENT);
	});

	it('serves the file to the right password, given in the URL', async () => {
		const { body } = await newShare({ password: 'shared-secret' });
		const res = await call(`/s/${body.share.token}?password=shared-secret`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(CONTENT);
	});

	it('serves the file to the right password, given in a header', async () => {
		// Preferred over the URL, so a password does not have to appear somewhere that gets logged.
		const { body } = await newShare({ password: 'shared-secret' });
		const res = await call(`/s/${body.share.token}`, { headers: { 'x-share-password': 'shared-secret' } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(CONTENT);
	});

	it('does not store the password in a recoverable form', async () => {
		await newShare({ password: 'shared-secret' });
		const rows = await env.DB.prepare('SELECT * FROM shares').all();
		expect(JSON.stringify(rows.results)).not.toContain('shared-secret');
	});

	it('still tells the recipient the file size, so a password prompt is not blind', async () => {
		const { body } = await newShare({ password: 'shared-secret' });
		const payload = (await (await call(`/s/${body.share.token}`)).json()) as any;
		expect(payload.file.sizeBytes).toBe(CONTENT.length);
		expect(payload.file.filename).toBe('config.yaml');
	});
});

describe("the operator's list of shares", () => {
	beforeEach(bootstrap);

	it('shows what each share points at and when it dies', async () => {
		await newShare({ seconds: 120 });
		const res = await asOperator('/api/shares');
		const body = (await res.json()) as any;

		expect(body.shares.length).toBe(1);
		expect(body.shares[0].path).toBe('/etc/config.yaml');
		expect(body.shares[0].active).toBe(true);
		expect(Date.parse(body.shares[0].expiresAt)).toBeGreaterThan(Date.now());
	});

	it('marks a cancelled share as no longer active', async () => {
		const { body } = await newShare();
		await asOperator('/api/shares/revoke', { method: 'POST', body: JSON.stringify({ token: body.share.token }) });
		const listed = (await (await asOperator('/api/shares')).json()) as any;
		expect(listed.shares[0].active).toBe(false);
		expect(listed.shares[0].revokedAt).toBeTruthy();
	});

	it('never discloses the password hash or the storage key', async () => {
		await newShare({ password: 'shared-secret' });
		const raw = await (await asOperator('/api/shares')).text();
		expect(raw).not.toContain('shared-secret');
		expect(raw).not.toContain('objects/');
		expect(raw).not.toContain('password_hash');
	});

	it('requires a signed-in operator', async () => {
		expect((await call('/api/shares')).status).toBe(401);
	});
});
