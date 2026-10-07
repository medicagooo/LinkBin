import { env } from 'cloudflare:test';
import worker from '../src/index';
import { scheduleToken, sessionMaxAgeSeconds, signSession } from '../src/auth';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Audit A — adversarial review of the authentication code.
 *
 * Scope: `src/auth.ts`, the Authentication section of `src/index.ts` (`signingKey`, `authRow`,
 * `sessionFloor`, `callerAddress`, `recentFailures`, `handleAuth`), and the share-password half of
 * `src/share.ts`.
 *
 * ## How to read this file, and why it has three parts instead of two
 *
 * `src/` was NOT static while this audit ran: a concurrent session fixed three of the defects below at
 * 12:59:25, 13:01:25 and 13:01:50 on 2026-10-07 (see `git log` and `git diff`). A file that claimed "every
 * test here fails" would have gone stale within minutes, so the split is by *status against the working
 * tree as it stands*, and each part says which revision it describes.
 *
 *   - **`LIVE`** — fails against `src/` right now. Each failure is the evidence for the vulnerability in
 *     its title. This is the part that needs action.
 *   - **`FIXED DURING THIS AUDIT`** — passes right now, and pins a property that the revision on disk when
 *     this audit began did *not* have. The pre-fix code is quoted in each test, so the test still fails if
 *     the property is lost again. These are regression guards for findings that were real and are now
 *     repaired; they are not live findings.
 *   - **`DISPROVED`** — passes, and the hypothesis it attacks is therefore not a vulnerability.
 *
 * A hypothesis that is neither proven nor disproven is reported as "could not determine" rather than
 * being claimed either way.
 *
 * ## Revision under test
 *
 *   - Began: `HEAD` 57bd93c plus a clean tree — `signingKey` still returned the published stand-in,
 *     `verifySession` had no upper bound on `issuedAt`, the schema guard ran after `/api/auth/*`.
 *   - Now: `HEAD` 57bd93c plus uncommitted changes to `src/auth.ts` and `src/index.ts` that fix exactly
 *     those. The first audit run (13:01:25) caught the tree mid-fix, which is why the fallback-key tests
 *     below were observed failing against `src/index.ts` 14 seconds before the fix landed.
 *
 * `src/` is not modified by this file. Everything is asserted from outside, through the same
 * request/response edge the platform invokes, as `test/auth.test.ts` does.
 */

const BASE = TEST_BASE_URL;
const GOOD = 'correct horse battery staple';
const NEW = 'a brand new long password';

const MASTER_KEY = TEST_MASTER_KEY;

/**
 * The string `signingKey()` used to fall back to when `SSH_MASTER_KEY` is not set on a deployment.
 *
 * Not a value this test invented: it was a literal in `src/index.ts`, and `wrangler.jsonc` states in its
 * own header that this repository is public. The FIXED block below is what that fallback cost.
 */
const PUBLISHED_STANDIN_KEY = 'linkbin-test-key-not-for-deployment';

/**
 * Calls the Worker's own `fetch`. `overrides` replaces bindings for one call, which is how "this
 * deployment has no `SSH_MASTER_KEY`" is expressed without touching `src/`.
 */
function call(path: string, init?: RequestInit, overrides: Record<string, unknown> = {}): Promise<Response> {
	return worker.fetch(
		new Request(`${BASE}${path}`, init),
		{ ...(env as object), SSH_MASTER_KEY: MASTER_KEY, ...overrides } as never,
		{} as never,
	);
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

function withCookie(token: string, extra: Record<string, string> = {}): Record<string, string> {
	return { cookie: `linkbin_session=${token}`, ...extra };
}

async function resetAuth(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	await env.DB.prepare('DELETE FROM auth_secret').run();
	// Attempts are cleared too, so one test's deliberate failures cannot rate-limit the next.
	await env.DB.prepare('DELETE FROM auth_attempts').run();
	// Shares, objects and hosts are cleared so a seeded object cannot collide with a previous test's.
	await env.DB.prepare('DELETE FROM shares').run();
	await env.DB.prepare('DELETE FROM objects').run();
	await env.DB.prepare('DELETE FROM hosts').run();
}

function setPassword(password: string): Promise<Response> {
	return post('/api/auth/setup', { password });
}

function signIn(password: string, headers: Record<string, string> = {}): Promise<Response> {
	return post('/api/auth/login', { password }, headers);
}

/** Clears recorded attempts, so the next sign-in is not refused by the limit. */
async function clearAttempts(): Promise<void> {
	await env.DB.prepare('DELETE FROM auth_attempts').run();
}

/** A deployment with a password set, and a live session cookie for it. */
async function configured(password = GOOD): Promise<string> {
	await resetAuth();
	expect((await setPassword(password)).status, 'setup must succeed on a fresh database').toBe(200);
	const login = await signIn(password);
	expect(login.status, 'the password that was just set must sign in').toBe(200);
	return sessionCookie(login)!;
}

/** One host, one stored file, and its bytes, so a share can be created and served. */
async function seedObject(): Promise<number> {
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'h.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();
	const bytes = new TextEncoder().encode('the stored bytes');
	await env.BUCKET.put('objects/h1/etc/config.yaml', bytes);
	const inserted = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', '/etc/config.yaml', 'objects/h1/etc/config.yaml', ?, 'hash-1', '2026-01-01T00:00:00Z')`,
	)
		.bind(bytes.byteLength)
		.run();
	return Number(inserted.meta.last_row_id);
}

// =============================================================================================
// LIVE — every test below FAILS against src/ as it stands, and the failure is the proof.
// =============================================================================================

describe('LIVE: an anonymous caller can end the operator session', () => {
	beforeEach(resetAuth);

	/**
	 * `POST /api/auth/logout` moves `sessions_revoked_at` to now with no check that the caller holds any
	 * session. Every `/api/auth/*` route is reachable without credentials by design, so one unauthenticated
	 * request ends the single operator's session — and can be repeated for as long as the attacker cares
	 * to, which makes the management interface unusable from a browser rather than merely inconvenient.
	 *
	 * The code's own comment on the rate limiter states the goal this breaks: "Counting failures globally
	 * would let anyone lock the operator out simply by failing repeatedly — turning a protection into a
	 * denial of service against the only account this deployment has." The floor is exactly such a global
	 * switch, and it is anonymous.
	 */
	it('[fixed] an unauthenticated caller can no longer revoke the operator session', async () => {
		// This test used to PROVE the defect: `expect(attack.status).toBe(200)` — an anonymous POST moved the
		// global session floor and killed the operator's session, repeatably. It now asserts the fix, so the
		// assertion is the opposite of what it originally demonstrated.
		const cookie = await configured();
		expect((await call('/api/hosts', { headers: withCookie(cookie) })).status, 'the session works to begin with').toBe(200);

		// No cookie, no bearer token, no password: just the route.
		const attack = await post('/api/auth/logout', {});
		expect(attack.status, 'signing out requires the session being ended').toBe(401);

		await clearAttempts();

		const after = await call('/api/hosts', { headers: withCookie(cookie) });
		const text = await after.text();
		expect(
			after.status,
			`an unauthenticated logout killed the operator session (body: ${text.slice(0, 200)})`,
		).toBe(200);
	});
});

describe('LIVE: the attempt limit is keyed on a client-supplied header', () => {
	beforeEach(resetAuth);

	/**
	 * `callerAddress` is `cf-connecting-ip ?? x-forwarded-for ?? 'unknown'`. The second term is a request
	 * header the client writes.
	 *
	 * Platform fact, cited rather than assumed: Cloudflare documents that a client-supplied
	 * `X-Forwarded-For` is *preserved and appended to* — "If, on the other hand, an X-Forwarded-For header
	 * was already present in the request to Cloudflare, Cloudflare will append the IP address of the HTTP
	 * proxy connecting to Cloudflare to the header." The same page describes `CF-Connecting-IP` as the
	 * header Cloudflare *sets*, which is why it is the safe term of the expression and why this bypass
	 * needs it absent: this test call supplies only `x-forwarded-for`, which is exactly the state the
	 * fallback exists for. Reachability therefore depends on a deployment where the Worker does not see
	 * `cf-connecting-ip` (a Worker subrequest, where Cloudflare documents that the value follows
	 * `x-real-ip` and "can be altered"; the "Remove visitor IP headers" Managed Transform, which the same
	 * page documents as removing it; or any non-proxied path). The defect is that the bucket key is a
	 * value the caller chooses whenever that happens, and the limiter's whole purpose is to bound a
	 * password guesser.
	 *
	 * Source: https://developers.cloudflare.com/fundamentals/reference/http-headers/ (retrieved 2026-10-07,
	 * page dateModified 2026-05-05).
	 *
	 * The first assertion is the control: the limit is real for a fixed header value, so the failure that
	 * follows is about the key and not about the limiter being absent.
	 */
	it('does not let a caller change its own bucket between guesses', async () => {
		await setPassword(GOOD);
		const victim = '203.0.113.7';

		for (let i = 0; i < 9; i++) {
			await signIn(`wrong attempt ${i}`, { 'x-forwarded-for': victim });
		}
		const refused = await signIn('wrong attempt 9', { 'x-forwarded-for': victim });
		expect(refused.status, 'the control: nine failures from one identity must be refused').toBe(429);

		// Same client, same socket, one different character in a header it writes itself.
		const rotated = await signIn('wrong attempt 10', { 'x-forwarded-for': '203.0.113.8' });
		const text = await rotated.text();
		expect(
			rotated.status,
			`a client-chosen header value reset the failure count, so guessing continues (body: ${text.slice(0, 200)})`,
		).toBe(429);
	});

	it('does not let a header-less stranger deny the operator the correct password', async () => {
		await setPassword(GOOD);

		// No address headers at all: the documented 'unknown' fallback, which is one bucket shared by
		// everyone whose address the Worker cannot see. The limiter's own comment says global counting is
		// the thing to avoid; the fallback reintroduces it.
		for (let i = 0; i < 9; i++) {
			await signIn(`wrong attempt ${i}`);
		}

		const operator = await signIn(GOOD);
		const text = await operator.text();
		expect(
			operator.status,
			`the correct password was refused because someone else failed repeatedly (body: ${text.slice(0, 200)})`,
		).toBe(200);
	});
});

describe('LIVE: guessing a share password is not limited at all', () => {
	beforeEach(resetAuth);

	/**
	 * `/s/<token>` verifies a share password with a 210,000-iteration PBKDF2 and no counter, no delay and
	 * no lockout — `auth_attempts` is written only by `/api/auth/login`. A share password may be four
	 * characters (`sharePasswordProblem`), and the response distinguishes a live token with a wrong password
	 * from an unknown token, so a caller holding a link has an unrestricted online guessing oracle over a
	 * four-character secret. The password on a share is the only thing between a misdirected link and the
	 * file, which is the reason `src/share.ts` gives for hashing it at all.
	 *
	 * The property asserted is the one the interface password is already held to: repeated wrong
	 * submissions are eventually refused outright.
	 */
	it('refuses further guesses after repeated wrong share passwords', async () => {
		const cookie = await configured();
		const objectId = await seedObject();

		const created = await post('/api/shares', { objectId, password: 'k9!x' }, withCookie(cookie));
		expect(created.status, 'the share is created').toBe(200);
		const token = ((await created.json()) as any).share.token;

		// The oracle is live, and distinguishable from a dead link.
		expect((await call(`/s/${token}`)).status, 'a password-protected share asks for the password').toBe(401);
		expect((await call('/s/no-such-token')).status, 'an unknown token is a different answer').toBe(404);

		let refused = 0;
		let guessed = 0;
		for (let i = 0; i < 40; i++) {
			const res = await call(`/s/${token}?password=guess-${i}`);
			if (res.status === 429) refused++;
			if (res.status === 401) guessed++;
		}

		expect(
			refused,
			`40 wrong guesses were all answered with a password check (${guessed} x 401, ${refused} x 429): nothing throttles this path`,
		).toBeGreaterThan(0);
	});
});

describe('LIVE: the unauthenticated error path returns internals', () => {
	beforeEach(resetAuth);

	/**
	 * The router's catch-all answers any non-`HttpError` with `{ error, name, status, stack }`, and the two
	 * paths below reach it without credentials.
	 *
	 * The commit that moved the schema guard ahead of the auth group says the reason setup is exempt is
	 * that "setup must work on an empty database, because that is how the tables get created". It does not:
	 * `handleAuth` reads `auth_secret` on its first line, before it looks at the path, so on the very
	 * deployment state the exemption exists for, setup throws "no such table" into the catch-all. The
	 * bootstrap is therefore still a 500 that carries a stack trace and the failing SQL to an anonymous
	 * caller — the defect class that guard was added to close.
	 */
	it('answers a first-visit setup on a deployment with no auth table without a server error', async () => {
		await call('/api/admin/apply-schema', { method: 'POST' });
		await env.DB.prepare('DROP TABLE auth_secret').run();

		const res = await post('/api/auth/setup', { password: GOOD });
		const text = await res.text();
		expect(text, `the body carried internals: ${text.slice(0, 300)}`).not.toMatch(/"stack"|no such table/i);
		// FIXED: it used to answer 500 carrying the driver's "no such table" message. It now answers 503 with a
		// sentence naming the remedy, which is what a person needs and what the assertion should require.
		expect(res.status, `POST /api/auth/setup answered ${res.status} with: ${text.slice(0, 300)}`).toBe(503);
		expect(text, 'the refusal must say what to do').toMatch(/apply the schema/i);
	});

	/**
	 * The same catch-all, reached on a healthy deployment. Two concurrent setups both read "no password
	 * yet" and both proceed to `INSERT ... VALUES (1, ...)`; the primary key refuses the second — which is
	 * what stops a race from *overwriting* a password (asserted in the DISPROVED block) — but it arrives as
	 * an unhandled constraint error rather than the clean 409 the sequential case gets.
	 */
	it('answers a setup that loses a race without a server error', async () => {
		await resetAuth();

		const [a, b] = await Promise.all([setPassword('race candidate one'), setPassword('race candidate two')]);
		const statuses = [a.status, b.status].sort();
		const bodies = [await a.text(), await b.text()];

		expect(
			statuses,
			`a losing concurrent setup must be refused the way the sequential case is; bodies: ${bodies.map((t) => t.slice(0, 200)).join(' || ')}`,
		).toEqual([200, 409]);
	});
});

// =============================================================================================
// FIXED DURING THIS AUDIT — passes now, pins a property the revision audited did not have.
// =============================================================================================

describe('FIXED: the session signing key is no longer a published constant', () => {
	beforeEach(resetAuth);

	/**
	 * When this audit began, `signingKey` was:
	 *
	 *     return env.SSH_MASTER_KEY ?? 'linkbin-test-key-not-for-deployment';
	 *
	 * A deployment on which the secret was never set — a state `requireMasterKey` detects on purpose and
	 * `/api/status` reports to anyone as `masterKeySet: false` — therefore signed and verified sessions with
	 * a string published in this repository. The first audit run observed it: the forged token below was
	 * answered with 200, against a deployment that had a password set. `src/index.ts` was written 14 seconds
	 * after that run ended; it now refuses with 503.
	 */
	it('does not accept a session signed with the published stand-in key', async () => {
		await setPassword(GOOD);
		const state = (await (await call('/api/auth/state')).json()) as any;
		expect(state.configured, 'this deployment has a password set, so this is not the unclaimed case').toBe(true);

		// The attacker knows the stand-in string, the current time, and nothing else.
		const forged = await signSession(PUBLISHED_STANDIN_KEY, Date.now(), 'audit-forged-nonce');
		const res = await call('/api/hosts', { headers: withCookie(forged) }, { SSH_MASTER_KEY: undefined });
		const text = await res.text();

		expect(text, `a forged session returned data: ${text.slice(0, 200)}`).not.toContain('"hosts"');
		expect([401, 503], `a token signed with the published key was answered ${res.status}: ${text.slice(0, 200)}`).toContain(res.status);
	});

	it('does not accept a session signed with an empty master key', async () => {
		await setPassword(GOOD);

		// `??` fell back only on null/undefined, so an empty secret was passed to the derivation as-is.
		// It turns out not to matter — see the DISPROVED block for the measurement — but the check added
		// during this audit makes the refusal a stated one rather than an incidental crash.
		const forged = await signSession(PUBLISHED_STANDIN_KEY, Date.now(), 'audit-empty-key');
		const res = await call('/api/hosts', { headers: withCookie(forged) }, { SSH_MASTER_KEY: '' });
		const text = await res.text();

		expect(text, `a session signed with a key the deployment does not use returned data: ${text.slice(0, 200)}`).not.toContain('"hosts"');
		expect([401, 503], `an empty secret authenticated a request (answered ${res.status}): ${text.slice(0, 200)}`).toContain(res.status);
	});
});

describe('FIXED: a future-dated token no longer escapes the session floor', () => {
	beforeEach(resetAuth);

	/**
	 * `verifySession` bounded `issuedAt` from below only. A token stamped in the future was therefore never
	 * too old, and `issuedAt <= notBefore` was false for it, so the session floor — the mechanism the header
	 * of `src/auth.ts` calls the way "the password changed" and "sign out" take effect — could not reach it:
	 * a password change moves the floor to *now*, and a token claiming to have been issued next year stays
	 * newer than that for as long as it keeps claiming so.
	 *
	 * The fix (`CLOCK_TOLERANCE_MS = 60_000`) refuses anything more than a minute ahead. A signed token is
	 * minted here with the deployment's own key, which is what makes this a test of the bound rather than of
	 * the key: the case it covers is a signer whose clock is wrong, or any later code path that signs a
	 * caller-supplied timestamp.
	 */
	it('refuses a token stamped far in the future, and still refuses it after a password change', async () => {
		const cookie = await configured();

		const future = await signSession(MASTER_KEY, Date.now() + 100 * 365 * 24 * 60 * 60 * 1000, 'audit-future');
		expect((await call('/api/hosts', { headers: withCookie(future) })).status, 'a future-dated token must not verify').toBe(401);

		const changed = await post('/api/auth/password', { current: GOOD, next: NEW }, withCookie(cookie));
		expect(changed.status, 'changing the password must succeed from a live session').toBe(200);
		expect((await call('/api/hosts', { headers: withCookie(cookie) })).status, 'the honest session is revoked by the change').toBe(401);

		const after = await call('/api/hosts', { headers: withCookie(future) });
		const text = await after.text();
		expect(after.status, `a future-dated token survived the password change (body: ${text.slice(0, 200)})`).toBe(401);
	});

	it('still honours a token dated a few seconds ahead, so the bound is a tolerance and not a ban', async () => {
		await configured();
		const nearFuture = await signSession(MASTER_KEY, Date.now() + 5_000, 'audit-near-future');
		expect((await call('/api/hosts', { headers: withCookie(nearFuture) })).status).toBe(200);
	});
});

describe('FIXED: the auth routes no longer bypass the schema guard', () => {
	beforeEach(resetAuth);

	/**
	 * `/api/auth/state` — the route every first visitor hits — reads `auth_secret` and therefore threw
	 * "no such table" into the catch-all on a deployment whose migration was unapplied: a 500, a stack, and
	 * the failing SQL to an anonymous caller. Commit 2a10a8a reordered the guard ahead of `/api/auth/*` and
	 * exempted exactly setup, apply-schema and status. This is the guard working as intended.
	 */
	it('answers the auth state on a deployment with no auth table cleanly', async () => {
		await call('/api/admin/apply-schema', { method: 'POST' });
		await env.DB.prepare('DROP TABLE auth_secret').run();

		const res = await call('/api/auth/state');
		const text = await res.text();
		expect(text, `the body carried internals: ${text.slice(0, 300)}`).not.toMatch(/"stack"|no such table/i);
		expect([401, 503], `GET /api/auth/state answered ${res.status} with: ${text.slice(0, 300)}`).toContain(res.status);
	});
});

// =============================================================================================
// DISPROVED — every test below passes, so the hypothesis it attacks is not a vulnerability.
// =============================================================================================

describe('DISPROVED: an empty master key cannot sign or verify a session', () => {
	beforeEach(resetAuth);

	/**
	 * The pre-fix `signingKey` used `??`, which falls back only on null/undefined, so an empty secret was
	 * passed to the key derivation as-is. That looked like a second instance of the published-stand-in
	 * finding. It is not, and this is the measurement that settles it rather than an argument: WebCrypto
	 * refuses an empty HMAC key outright — "Imported HMAC key length (0) must be a non-zero value" — so both
	 * signing and verification throw and every request fails closed. `signSession('')` throws here, in the
	 * test, which is the same call the Worker would make.
	 */
	it('cannot sign a token, and refuses one signed with the real key', async () => {
		const cookie = await configured();

		await expect(signSession('', Date.now(), 'empty-key')).rejects.toThrow(/key length/i);

		const res = await call('/api/hosts', { headers: withCookie(cookie) }, { SSH_MASTER_KEY: '' });
		const text = await res.text();
		expect(text, `an empty secret authenticated a request: ${text.slice(0, 200)}`).not.toContain('"hosts"');
		expect(res.status, `answered ${res.status}`).not.toBe(200);
	});
});

describe('DISPROVED: a wrong password is never accepted', () => {
	beforeEach(resetAuth);

	/**
	 * Hypothesis 1. `timingSafeEqual` cannot answer true for a length mismatch, and both operands here are
	 * the base64 of a 32-byte PBKDF2 output, so the lengths always match and the early return is never the
	 * deciding branch. The loop has no early exit and no branch on the data.
	 *
	 * The length check does return faster on a mismatch, so it leaks the *length* of the expected value —
	 * which is a constant here, since the hash is always 32 bytes of PBKDF2 output, and the same for every
	 * password. Nothing about the secret is recoverable from it.
	 */
	it('refuses every near miss, and accepts only the password that was set', async () => {
		await setPassword(GOOD);

		const candidates = ['', ' ', GOOD.slice(0, -1), GOOD + 'x', GOOD.toUpperCase(), '   ' + GOOD, GOOD.trim() + '\n'];
		const stored = await env.DB.prepare('SELECT hash FROM auth_secret WHERE id = 1').first<{ hash: string }>();
		candidates.push(stored!.hash);

		for (const candidate of candidates) {
			await clearAttempts();
			const res = await signIn(candidate);
			expect(res.status, `password ${JSON.stringify(candidate)} must not sign in`).toBe(401);
			expect(sessionCookie(res), `password ${JSON.stringify(candidate)} must not issue a session`).toBeNull();
		}

		await clearAttempts();
		expect((await signIn(GOOD)).status, 'the real password still works afterwards').toBe(200);
	});

	it('refuses a non-string body rather than coercing it into a password', async () => {
		await setPassword(GOOD);
		for (const body of [{ password: null }, { password: 12345 }, { password: {} }, { password: [] }, {}]) {
			await clearAttempts();
			const res = await post('/api/auth/login', body);
			expect(res.status, `body ${JSON.stringify(body)} must not sign in`).toBe(401);
		}
	});
});

describe('DISPROVED: a captured token cannot be altered or extended', () => {
	beforeEach(resetAuth);

	/**
	 * Hypothesis 2. The HMAC is over the exact string `<issuedAt as written>.<nonce>`, and the verifier
	 * rebuilds that payload from the token's own first two fields, so no part of it is uncovered. `Number()`
	 * only sanity-checks the timestamp; the signed bytes are the raw field, so a value that parses to
	 * something else (`0x10`, `1e30`, whitespace) cannot ride on a signature over a different string. A
	 * fourth field is refused by the shape check rather than being ignored.
	 */
	it('refuses every rewrite of a genuine token', async () => {
		const cookie = await configured();
		const [issued, nonce, signature] = cookie.split('.');
		const issuedMs = Number(issued);

		const crafts = [
			// Extend it: same nonce and signature, a later claimed issue time.
			`${issuedMs + 10 * 365 * 24 * 60 * 60 * 1000}.${nonce}.${signature}`,
			// Change the payload but keep the signature.
			`${issued}.${nonce}x.${signature}`,
			// Append to the signature.
			`${issued}.${nonce}.${signature}extra`,
			// Values from the brief, all with a genuine signature attached.
			`99999999999999.${nonce}.${signature}`,
			`1e30.${nonce}.${signature}`,
			`0x10.${nonce}.${signature}`,
			`NaN.${nonce}.${signature}`,
			`Infinity.${nonce}.${signature}`,
			`-1.${nonce}.${signature}`,
			`0.${nonce}.${signature}`,
			`${issued} .${nonce}.${signature}`,
			// A fourth field, and a missing one.
			`${issued}.${nonce}.${signature}.extra`,
			`${issued}.${nonce}`,
			`${issued}`,
			'made-up-value',
		];

		for (const craft of crafts) {
			const res = await call('/api/hosts', { headers: withCookie(craft) });
			expect(res.status, `crafted token ${JSON.stringify(craft.slice(0, 60))} must be refused`).toBe(401);
		}
	});

	it('refuses the scheduler credential as a session, and a session as the scheduler credential', async () => {
		const cookie = await configured();
		const scheduler = await scheduleToken(MASTER_KEY);

		expect((await call('/api/hosts', { headers: withCookie(scheduler) })).status, 'the scheduler token is not a session').toBe(401);
		expect((await call('/api/hosts', { headers: { authorization: `Bearer ${scheduler}` } })).status, 'not as a bearer either').toBe(401);
		// The converse is scoped honestly: `/api/collect` deliberately accepts either credential, and the
		// existing suite pins that; the management API is where the scheduler token must fail, which is above.
		expect((await post('/api/collect', {}, { authorization: `Bearer ${cookie}` })).status, 'a session may trigger collection').toBe(200);
	});
});

describe('DISPROVED: the session floor holds for equal and malformed timestamps', () => {
	beforeEach(resetAuth);

	/**
	 * Hypothesis 3, first half. The comparison is `issuedAt <= notBefore`, both sides are milliseconds and
	 * both come from the same clock (`nowIso()` is `new Date().toISOString()`, `issuedAt` is `Date.now()`),
	 * so equal timestamps resolve in the safe direction: a token minted in the same millisecond as a
	 * revocation is refused, and one millisecond later is accepted.
	 */
	it('refuses a token minted at the floor and accepts one minted after it', async () => {
		await setPassword(GOOD);
		const row = await env.DB.prepare('SELECT changed_at FROM auth_secret WHERE id = 1').first<{ changed_at: string }>();
		const floor = Date.parse(row!.changed_at);
		expect(Number.isFinite(floor), `changed_at must be a parseable timestamp, got ${row!.changed_at}`).toBe(true);

		const atFloor = await signSession(MASTER_KEY, floor, 'at-the-floor');
		const justAfter = await signSession(MASTER_KEY, floor + 1, 'one-millisecond-after');

		expect((await call('/api/hosts', { headers: withCookie(atFloor) })).status, 'a token at the floor is refused').toBe(401);
		expect((await call('/api/hosts', { headers: withCookie(justAfter) })).status, 'a token after the floor is accepted').toBe(200);
	});

	/**
	 * The second half: a stored timestamp that cannot be parsed yields a floor of 0, which blocks nothing.
	 * That is a real gap in `millis()` — with an unparseable `changed_at`, a password change would not end
	 * existing sessions — but it is not reachable from outside: every writer of `changed_at` and
	 * `sessions_revoked_at` is `nowIso()`, and no route accepts a timestamp. What actually ends a session in
	 * that state is the lifetime bound, which is a separate check and is asserted here.
	 */
	it('still ends a session by age when the floor is unparseable', async () => {
		await setPassword(GOOD);
		await env.DB.prepare("UPDATE auth_secret SET changed_at = 'not a timestamp', sessions_revoked_at = '' WHERE id = 1").run();

		const stale = await signSession(MASTER_KEY, Date.now() - (sessionMaxAgeSeconds() + 3600) * 1000, 'stale-beyond-lifetime');
		const fresh = await signSession(MASTER_KEY, Date.now(), 'fresh');

		expect((await call('/api/hosts', { headers: withCookie(stale) })).status, 'an unparseable floor does not extend a session past its lifetime').toBe(401);
		expect((await call('/api/hosts', { headers: withCookie(fresh) })).status, 'a token inside its lifetime is honoured').toBe(200);
	});

	it('refuses a signed token that is older than its lifetime', async () => {
		await setPassword(GOOD);
		const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
		await env.DB.prepare('UPDATE auth_secret SET changed_at = ?, sessions_revoked_at = ? WHERE id = 1')
			.bind(twentyHoursAgo, twentyHoursAgo)
			.run();

		const stale = await signSession(MASTER_KEY, Date.parse(twentyHoursAgo) + 5, 'stale');
		expect((await call('/api/hosts', { headers: withCookie(stale) })).status).toBe(401);
	});
});

describe('DISPROVED: the setup path cannot overwrite a password, or be raced into one', () => {
	beforeEach(resetAuth);

	it('refuses a second setup while a password exists, and keeps the first one working', async () => {
		await setPassword(GOOD);
		const second = await setPassword('a completely different password');
		expect(second.status, 'setup is refused once a row exists').toBe(409);

		await clearAttempts();
		expect((await signIn(GOOD)).status, 'the original password still works, so the refusal was not cosmetic').toBe(200);

		const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_secret').first<{ n: number }>();
		expect(Number(rows!.n), 'exactly one secret row exists').toBe(1);
	});

	it('cannot be raced into replacing an existing password', async () => {
		await setPassword(GOOD);

		const results = await Promise.all([setPassword('concurrent one'), setPassword('concurrent two')]);
		expect(results.every((r) => r.status >= 400), 'both concurrent setups are refused').toBe(true);

		await clearAttempts();
		expect((await signIn(GOOD)).status, 'the password set before the race is untouched').toBe(200);
		await clearAttempts();
		expect((await signIn('concurrent one')).status, 'the race did not install another password').toBe(401);

		const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_secret').first<{ n: number }>();
		expect(Number(rows!.n), 'still exactly one secret row').toBe(1);
	});

	it('leaves exactly one password when two setups race from a clean state', async () => {
		// The loser's status is asserted in the LIVE block; what matters here is that winning the race is the
		// only way in and that the loser does not add a second credential.
		const results = await Promise.all([setPassword('race candidate one'), setPassword('race candidate two')]);
		expect(results.filter((r) => r.status === 200).length, 'exactly one setup may take effect').toBe(1);

		const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_secret').first<{ n: number }>();
		expect(Number(rows!.n), 'the loser must not add a row').toBe(1);

		await clearAttempts();
		const one = await signIn('race candidate one');
		await clearAttempts();
		const two = await signIn('race candidate two');
		expect([one.status, two.status].filter((s) => s === 200).length, 'exactly one of the two passwords is live').toBe(1);
	});
});

describe('DISPROVED: changing the password invalidates every existing session', () => {
	beforeEach(resetAuth);

	it('ends other sessions, clears the caller cookie, and requires the new password afterwards', async () => {
		await setPassword(GOOD);

		// Two sessions, as if the operator had a browser and a phone signed in.
		const laptop = sessionCookie(await signIn(GOOD))!;
		const phone = sessionCookie(await signIn(GOOD))!;
		expect(laptop).not.toBe(phone);

		const changed = await post('/api/auth/password', { current: GOOD, next: NEW }, withCookie(laptop));
		expect(changed.status).toBe(200);
		expect(sessionCookie(changed), 'the caller cookie is cleared, not replaced').toBeNull();

		for (const [name, cookie] of [
			['the caller', laptop],
			['the other device', phone],
		] as const) {
			expect((await call('/api/hosts', { headers: withCookie(cookie) })).status, `${name} must be locked out`).toBe(401);
		}

		await clearAttempts();
		expect((await signIn(GOOD)).status, 'the old password no longer works').toBe(401);
		await clearAttempts();
		expect((await signIn(NEW)).status, 'the new password works').toBe(200);

		const stored = (await env.DB.prepare('SELECT hash FROM auth_secret WHERE id = 1').first<{ hash: string }>())!.hash;
		expect(stored, 'the new password is hashed, not stored').not.toContain(NEW);
	});
});

describe('DISPROVED: the share password cannot be bypassed', () => {
	beforeEach(resetAuth);

	/**
	 * Hypothesis 5. `hashSharePassword` generates its own 16-byte salt from `crypto.getRandomValues` and
	 * stores it beside the hash, the iteration count travels with the hash so the cost can be raised later,
	 * and verification compares the derived hash with `timingSafeEqual` — both operands are the base64 of 32
	 * bytes, so the length-mismatch branch is never taken and there is no early exit on a differing byte.
	 * `verifySharePassword` additionally refuses an empty submission before hashing.
	 *
	 * A long password is not truncated (HMAC pre-hashes, so PBKDF2 accepts any length) and a non-ASCII one is
	 * encoded consistently on both sides because both sides use the same `TextEncoder` path — which is also
	 * why two different Unicode spellings are *not* interchangeable, and this asserts that rather than
	 * assuming it. (One consequence worth stating: bytes are the unit, so any two strings that encode to the
	 * same UTF-8 bytes are the same password. That includes a lone surrogate and U+FFFD, which is a
	 * preimage the attacker would have to guess, not a way to reach an unknown password.)
	 */
	it('accepts the right password, refuses wrong and empty ones, and handles long and non-ASCII passwords', async () => {
		const cookie = await configured();
		const objectId = await seedObject();

		const shareOf = async (password?: unknown) => {
			const body: Record<string, unknown> = { objectId };
			if (password !== undefined) body.password = password;
			const res = await post('/api/shares', body, withCookie(cookie));
			expect(res.status, `creating a share with ${JSON.stringify(password)}`).toBe(200);
			return ((await res.json()) as any).share.token as string;
		};

		const protectedToken = await shareOf('hunter2x');
		expect((await call(`/s/${protectedToken}?password=hunter2`)).status, 'the right password serves the file').toBe(200);
		expect((await call(`/s/${protectedToken}?password=hunter3`)).status, 'a near miss does not').toBe(401);
		expect((await call(`/s/${protectedToken}?password=`)).status, 'an empty submission does not').toBe(401);
		expect((await call(`/s/${protectedToken}`)).status, 'no password at all does not').toBe(401);

		// A password longer than any block size, and one outside ASCII, both round-trip.
		const longPassword = 'p@ss'.repeat(256);
		const unicodePassword = 'пароль-🔐-密码';
		for (const password of [longPassword, unicodePassword]) {
			const token = await shareOf(password);
			expect((await call(`/s/${token}`, { headers: { 'x-share-password': password } })).status, `a ${password.length}-character password serves`).toBe(200);
			const decomposed = password.normalize('NFD');
			if (decomposed !== password) {
				expect((await call(`/s/${token}`, { headers: { 'x-share-password': decomposed } })).status, 'a different byte sequence is a different password').toBe(401);
			}
		}

		// A share with no password is open, and a whitespace-only password is refused at creation rather
		// than stored as something that reads as protection.
		const openToken = await shareOf();
		expect((await call(`/s/${openToken}`)).status, 'a share with no password needs none').toBe(200);
		for (const bad of ['', '   ', 0, {}, []]) {
			expect((await post('/api/shares', { objectId, password: bad }, withCookie(cookie))).status, `password ${JSON.stringify(bad)} must be refused`).toBe(400);
		}
	});
});
