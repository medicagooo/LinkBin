import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Whether a NUL-bearing password can produce an account openable by submitting nothing.
 *
 * The mechanism was measured directly: this runtime's raw-key import drops TRAILING NUL bytes, so
 * `hashPassword('P\0')` equals `hashPassword('P')` and `hashPassword('\0\0\0\0')` equals `hashPassword('')`.
 * A leading NUL is preserved, so the effect is specifically on trailing ones.
 *
 * That makes a specific outcome worth testing rather than reasoning about: if a password made only of NULs
 * can be SET on the interface, then the hash stored for it is the hash of the empty string, and a sign-in
 * attempt with an empty password would compute that same hash and succeed. That would be an account with no
 * password at all — the exact thing the length rule exists to prevent.
 */

const BASE = TEST_BASE_URL;

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

function post(path: string, body: unknown): Promise<Response> {
	return call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function reset(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	await env.DB.prepare('DELETE FROM auth_secret').run();
	await env.DB.prepare('DELETE FROM auth_attempts').run();
}

function sessionCookie(res: Response): string | null {
	const match = /linkbin_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
	return match ? match[1] : null;
}

describe('a password made of NUL bytes', () => {
	beforeEach(reset);

	it('can be set, and then an EMPTY password must not sign in', async () => {
		// Twelve NULs is long enough to pass the length rule as written.
		const nulPassword = '\u0000'.repeat(12);
		const setup = await post('/api/auth/setup', { password: nulPassword });

		if (setup.status !== 200) {
			// Refused at creation is an acceptable outcome — the best one, in fact.
			expect(setup.status).toBe(400);
			return;
		}

		const empty = await post('/api/auth/login', { password: '' });
		expect(empty.status, 'signing in with nothing must not work').toBe(401);
		expect(sessionCookie(empty), 'no session may be issued for an empty password').toBeNull();
	});

	it('cannot have a trailing NUL added to change which password works', async () => {
		// If trailing NULs are dropped, then `P` and `P\0` are the same password — which means a password the
		// operator believes they chose carefully can be satisfied by a truncated version of it.
		const base = 'correct horse battery staple';
		await post('/api/auth/setup', { password: base });

		expect((await post('/api/auth/login', { password: base })).status).toBe(200);
		// The same string is still the same password; what must not happen is a DIFFERENT shorter string
		// working. `P\0` working is only reachable if the operator set `P\0`, which this test does not.
		expect((await post('/api/auth/login', { password: base.slice(0, -1) })).status).toBe(401);
	});

	it('is refused when the runtime would treat it as the empty string', async () => {
		// The property that matters: no password the runtime hashes to the empty string may be accepted.
		const nulOnly = '\u0000\u0000\u0000\u0000';
		const res = await post('/api/auth/setup', { password: nulOnly });
		expect(res.status, 'a password that hashes to the empty string must be refused at creation').toBe(400);
	});
});

describe('a share password made of NUL bytes', () => {
	beforeEach(async () => {
		await reset();
		await post('/api/auth/setup', { password: 'a sufficiently long password' });
		const login = await post('/api/auth/login', { password: 'a sufficiently long password' });
		const cookie = sessionCookie(login)!;

		await env.DB.prepare(
			`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
			 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		).run();
		await env.BUCKET.put('objects/h1/etc/a.txt', new TextEncoder().encode('bytes'));
		await env.DB.prepare(
			`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
			 VALUES ('h1', '/etc/a.txt', 'objects/h1/etc/a.txt', 5, 'h', '2026-01-01T00:00:00Z')`,
		).run();
		(globalThis as Record<string, unknown>).shareCookie = `linkbin_session=${cookie}`;
	});

	it('is refused at creation, because it hashes to the empty string', async () => {
		const id = (await env.DB.prepare('SELECT id FROM objects').first<{ id: number }>())!.id;
		const res = await call('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: (globalThis as any).shareCookie },
			body: JSON.stringify({ objectId: id, password: '\u0000\u0000\u0000\u0000' }),
		});
		expect(res.status, 'a share password that hashes to the empty string must be refused').toBe(400);
	});
});
