import { env } from 'cloudflare:test';
import worker from '../src/index';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Authentication: a stranger who finds the address can do nothing.
 *
 * Asserted from outside, through the same request/response edge the platform invokes. Nothing here
 * inspects how a password is hashed or how a session is represented — only that the right callers get
 * through and the wrong ones do not, because those are the properties that actually protect the
 * deployment. A test that pinned the hash format would pass while the interface stood open.
 */

const BASE = 'https://linkbin.test';

function call(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), env as never, {} as never);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return call(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
}

/** Reads the session cookie out of a response, if one was set. */
function sessionCookie(res: Response): string | null {
	const raw = res.headers.get('set-cookie');
	if (!raw) return null;
	const match = /linkbin_session=([^;]+)/.exec(raw);
	return match ? match[1] : null;
}

const GOOD = 'correct horse battery staple';

async function setPassword(password = GOOD): Promise<Response> {
	return post('/api/auth/setup', { password });
}

async function signIn(password = GOOD): Promise<Response> {
	return post('/api/auth/login', { password });
}

/** Everything the database holds about authentication, for assertions about what is NOT stored. */
async function authRows(): Promise<{ secret: any[]; attempts: any[] }> {
	const secret = await env.DB.prepare('SELECT * FROM auth_secret').all();
	const attempts = await env.DB.prepare('SELECT * FROM auth_attempts').all();
	return { secret: secret.results ?? [], attempts: attempts.results ?? [] };
}

async function resetAuth(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	await env.DB.prepare('DELETE FROM auth_secret').run();
	// Attempts are cleared too, so one test's deliberate failures cannot rate-limit the next. In
	// production the counter is scoped per caller; every test here shares one synthetic caller.
	await env.DB.prepare('DELETE FROM auth_attempts').run();
}

describe('a stranger gets nothing', () => {
	beforeEach(resetAuth);

	it('refuses the management API without a session', async () => {
		for (const path of ['/api/hosts', '/api/rules', '/api/usage']) {
			const res = await call(path);
			expect(res.status, `${path} should be refused`).toBe(401);
		}
	});

	it('refuses to create a host without a session, and does not create it', async () => {
		const res = await post('/api/hosts', { label: 'x', address: 'h.invalid', username: 'root' });
		expect(res.status).toBe(401);
		const { results } = await env.DB.prepare('SELECT * FROM hosts').all();
		expect(results?.length).toBe(0);
	});

	it('does not reveal whether a resource exists: an unknown path and a protected one look alike', async () => {
		const protectedRes = await call('/api/hosts');
		const unknownRes = await call('/api/there-is-no-such-route');
		expect(protectedRes.status).toBe(401);
		expect(unknownRes.status).toBe(401);
	});

	it('still serves the interface itself, so there is somewhere to sign in', async () => {
		const res = await call('/');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('LinkBin');
	});
});

describe('first visit sets the password', () => {
	beforeEach(resetAuth);

	it('reports that no password is set yet', async () => {
		const res = await call('/api/auth/state');
		const body: any = await res.json();
		expect(body.configured).toBe(false);
	});

	it('accepts a password and then reports itself configured', async () => {
		const res = await setPassword();
		expect(res.status).toBe(200);
		const state: any = await (await call('/api/auth/state')).json();
		expect(state.configured).toBe(true);
	});

	it('refuses a password that is too short', async () => {
		const res = await setPassword('short');
		expect(res.status).toBe(400);
		const state: any = await (await call('/api/auth/state')).json();
		expect(state.configured).toBe(false);
	});

	it('refuses an empty or whitespace-only password', async () => {
		expect((await setPassword('')).status).toBe(400);
		expect((await setPassword('        ')).status).toBe(400);
	});

	it('cannot be used a second time to overwrite the password', async () => {
		await setPassword(GOOD);
		const second = await setPassword('a completely different password');
		expect(second.status).toBeGreaterThanOrEqual(400);
		// The original must still work, proving the overwrite was refused rather than merely reported.
		expect((await signIn(GOOD)).status).toBe(200);
	});

	it('never stores the password itself', async () => {
		await setPassword(GOOD);
		const { secret } = await authRows();
		expect(secret.length).toBe(1);
		const row = secret[0];
		const serialised = JSON.stringify(row);
		expect(serialised).not.toContain(GOOD);
		// A hash and a salt are both present, and the cost is recorded so it can be raised later.
		expect(row.hash).toBeTruthy();
		expect(row.salt).toBeTruthy();
		expect(Number(row.iterations)).toBeGreaterThan(1000);
	});

	it('stores a different hash for the same password on a different deployment, so the salt is real', async () => {
		await setPassword(GOOD);
		const first = (await authRows()).secret[0];
		await env.DB.prepare('DELETE FROM auth_secret').run();
		await setPassword(GOOD);
		const second = (await authRows()).secret[0];
		expect(second.salt).not.toBe(first.salt);
		expect(second.hash).not.toBe(first.hash);
	});
});

describe('signing in', () => {
	beforeEach(async () => {
		await resetAuth();
		await setPassword();
	});

	it('accepts the right password and issues a session', async () => {
		const res = await signIn();
		expect(res.status).toBe(200);
		expect(sessionCookie(res)).toBeTruthy();
	});

	it('refuses the wrong password and issues no session', async () => {
		const res = await signIn('not the password');
		expect(res.status).toBe(401);
		expect(sessionCookie(res)).toBeNull();
	});

	it('distinguishes a wrong password from an expired session', async () => {
		const wrong = await signIn('not the password');
		const noSession = await call('/api/hosts');
		expect(wrong.status).toBe(401);
		expect(noSession.status).toBe(401);
		// The bodies must differ, or a caller cannot tell "sign in again" from "you typed it wrong".
		expect((await wrong.json() as any).error).not.toBe((await noSession.json() as any).error);
	});

	it('lets a signed-in session use the API', async () => {
		const cookie = sessionCookie(await signIn())!;
		const res = await call('/api/hosts', { headers: { cookie: `linkbin_session=${cookie}` } });
		expect(res.status).toBe(200);
	});

	it('accepts the session as a bearer credential too, so non-browser callers work', async () => {
		const cookie = sessionCookie(await signIn())!;
		const res = await call('/api/hosts', { headers: { authorization: `Bearer ${cookie}` } });
		expect(res.status).toBe(200);
	});

	it('refuses a tampered session', async () => {
		const cookie = sessionCookie(await signIn())!;
		const tampered = cookie.slice(0, -3) + (cookie.endsWith('aaa') ? 'bbb' : 'aaa');
		const res = await call('/api/hosts', { headers: { cookie: `linkbin_session=${tampered}` } });
		expect(res.status).toBe(401);
	});

	it('refuses a session that was never issued, rather than treating it as valid', async () => {
		const res = await call('/api/hosts', { headers: { cookie: 'linkbin_session=made-up-value' } });
		expect(res.status).toBe(401);
	});
});

describe('signing out and changing the password', () => {
	beforeEach(async () => {
		await resetAuth();
		await setPassword();
	});

	it('ends the session on sign-out, enforced by the server', async () => {
		const cookie = sessionCookie(await signIn())!;
		await post('/api/auth/logout', {}, { cookie: `linkbin_session=${cookie}` });
		const res = await call('/api/hosts', { headers: { cookie: `linkbin_session=${cookie}` } });
		expect(res.status, 'a signed-out session must stop working').toBe(401);
	});

	it('requires the current password to change it', async () => {
		const cookie = sessionCookie(await signIn())!;
		const res = await post('/api/auth/password', { current: 'wrong', next: 'another long password' }, { cookie: `linkbin_session=${cookie}` });
		expect(res.status).toBe(401);
	});

	it('ends every existing session when the password changes', async () => {
		const cookie = sessionCookie(await signIn())!;
		const changed = await post(
			'/api/auth/password',
			{ current: GOOD, next: 'a brand new long password' },
			{ cookie: `linkbin_session=${cookie}` },
		);
		expect(changed.status).toBe(200);

		// The old session must no longer work; changing a password that leaves sessions alive does not
		// actually lock anything out.
		const after = await call('/api/hosts', { headers: { cookie: `linkbin_session=${cookie}` } });
		expect(after.status).toBe(401);

		// And the new password works, proving the change took effect rather than merely failing.
		expect((await signIn('a brand new long password')).status).toBe(200);
		expect((await signIn(GOOD)).status).toBe(401);
	});

	it('refuses a new password that is too short, and keeps the old one working', async () => {
		const cookie = sessionCookie(await signIn())!;
		const res = await post('/api/auth/password', { current: GOOD, next: 'tiny' }, { cookie: `linkbin_session=${cookie}` });
		expect(res.status).toBe(400);
		expect((await signIn(GOOD)).status).toBe(200);
	});
});

describe('brute force is limited', () => {
	beforeEach(async () => {
		await resetAuth();
		await setPassword();
	});

	it('records failed attempts', async () => {
		await signIn('wrong one');
		await signIn('wrong two');
		const { attempts } = await authRows();
		expect(attempts.length).toBeGreaterThanOrEqual(2);
	});

	it('slows or refuses after repeated failures rather than answering indefinitely', async () => {
		let refused = false;
		for (let i = 0; i < 30; i++) {
			const res = await signIn(`wrong attempt number ${i}`);
			if (res.status === 429) {
				refused = true;
				break;
			}
		}
		expect(refused, 'repeated failures must eventually be refused outright').toBe(true);
	});

	it('still lets the correct password through after the limit resets', async () => {
		for (let i = 0; i < 5; i++) await signIn(`wrong ${i}`);
		// Five failures is under the limit, so the real password must still work.
		expect((await signIn()).status).toBe(200);
	});
});
