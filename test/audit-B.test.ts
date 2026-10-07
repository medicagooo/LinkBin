/**
 * Adversarial audit (round B) of the sharing feature.
 *
 * Every test is written so that it FAILS when the property it names is violated, and the property is
 * stated from the attacker's side.
 *
 * Tests named `[baseline-failure]` are the ones that FAILED against the revision this audit started from
 * (`src/index.ts` SHA-256 22E65C91…, whose share-relevant code is identical to commit HEAD 7e7f824 —
 * the published `signingKey` fallback, `row.path.split('/').pop() || row.path`, and a bare
 * `decodeURIComponent`). Three of them are the evidence for reported vulnerabilities; a concurrent
 * session patched all three in the working tree while this audit was running, so they are kept as
 * regression tests that now pass. `[measured]` marks a behaviour established by direct measurement
 * rather than by reading.
 *
 * Hypotheses (see the audit request): H1 token→other file, H2 password bypass, H3 refusal leaks content,
 * H4 recipient learns too much, H5 dead link revived, H6 unauthenticated create/cancel, H7 origin taken
 * from the request.
 *
 * Nothing in `src/` is modified. The database and bucket are seeded directly, as in
 * `test/share-routes.test.ts`.
 */

import { env } from 'cloudflare:test';
import worker from '../src/index';
import { hashPassword } from '../src/auth';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

const BASE = TEST_BASE_URL;
const OPERATOR_PASSWORD = 'a sufficiently long interface password';
const SHARE_PASSWORD = 'shared-secret';

/** Object one: the file a share is created for. */
const CONTENT = 'the stored bytes of object one';
const ONE_PATH = '/etc/config.yaml';
const ONE_KEY = 'objects/h1/etc/config.yaml';
const ONE_HASH = 'hash-of-object-one';

/** Object two: a file no share points at, whose bytes must never be served by object one's token. */
const OTHER_CONTENT = 'THE BYTES OF OBJECT TWO, WHICH WAS NEVER SHARED';
const OTHER_PATH = '/etc/shadow';
const OTHER_KEY = 'objects/h1/etc/shadow';
const OTHER_HASH = 'hash-of-object-two';

/** Object three: an object whose stored path ends in a separator (directory-shaped). */
const DUMP_CONTENT = 'the bytes of the directory-shaped object';
const DUMP_PATH = '/srv/private/dumps/';
const DUMP_KEY = 'objects/h1/srv/private/dumps/';
const DUMP_HASH = 'hash-of-object-three';

/**
 * Issues a request against the Worker.
 *
 * `key` defaults to the fixture master key. Passing `null` builds the deployment state in which
 * `SSH_MASTER_KEY` was never set — a real state for a Worker deployed before `wrangler secret put`, and
 * one `signingKey()` in `src/index.ts` has a published fallback for, so it has to be tested rather than
 * assumed away.
 *
 * `origin` lets a test put an arbitrary Host in front of the Worker, which is what hypothesis 7 is about.
 */
function call(
	path: string,
	init?: RequestInit,
	options: { key?: string | null; origin?: string } = {},
): Promise<Response> {
	const key = options.key === undefined ? TEST_MASTER_KEY : options.key;
	const target = { ...(env as object), SSH_MASTER_KEY: key ?? undefined };
	return worker.fetch(new Request(`${options.origin ?? BASE}${path}`, init), target as never, {} as never);
}

interface Fixture {
	session: string;
	oneId: number;
	otherId: number;
	dumpId: number;
}

let fx: Fixture;

/** Stores one object's bytes in the bucket and its row in the database, returning the row id. */
async function seedObject(path: string, key: string, content: string, hash: string): Promise<number> {
	const bytes = new TextEncoder().encode(content);
	await env.BUCKET.put(key, bytes);
	await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
	)
		.bind(path, key, bytes.byteLength, hash)
		.run();
	const row = await env.DB.prepare('SELECT id FROM objects WHERE object_key = ?').bind(key).first<{ id: number }>();
	return Number(row!.id);
}

/**
 * A deployment with one operator password set and one host holding three stored files.
 *
 * The password is set through the real setup route, so the deployment under test is a *secured* one:
 * hypothesis 6 is about reaching the share routes when a password already exists, not about the
 * documented first-visit window.
 */
async function bootstrap(key: string | null = TEST_MASTER_KEY): Promise<Fixture> {
	await call('/api/admin/apply-schema', { method: 'POST' }, { key });
	for (const table of ['shares', 'object_flags', 'objects', 'hosts', 'auth_secret', 'auth_attempts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}

	await call(
		'/api/auth/setup',
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: OPERATOR_PASSWORD }) },
		{ key },
	);

	// A deployment with no master key cannot be signed into at all, so nothing here depends on a session
	// existing: the tests in that state seed the rows they need directly and attack with a forged cookie.
	let session = '';
	if (key !== null) {
		const login = await call(
			'/api/auth/login',
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: OPERATOR_PASSWORD }) },
			{ key },
		);
		session = /linkbin_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
		if (!session) throw new Error(`the operator could not sign in: ${login.status} ${await login.text()}`);
	}

	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'h.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();

	const oneId = await seedObject(ONE_PATH, ONE_KEY, CONTENT, ONE_HASH);
	const otherId = await seedObject(OTHER_PATH, OTHER_KEY, OTHER_CONTENT, OTHER_HASH);
	const dumpId = await seedObject(DUMP_PATH, DUMP_KEY, DUMP_CONTENT, DUMP_HASH);

	return { session, oneId, otherId, dumpId };
}

/**
 * A session token with its signed payload altered.
 *
 * The nonce is changed rather than the last character of the signature: base64url decodes the final
 * character from only a few significant bits, so changing that one can leave the decoded signature
 * bytes identical and would make this test pass or fail for the wrong reason.
 */
function tamper(token: string): string {
	const parts = token.split('.');
	parts[1] = (parts[1][0] === 'A' ? 'B' : 'A') + parts[1].slice(1);
	return parts.join('.');
}

function asOperator(path: string, init?: RequestInit, options: { key?: string | null; origin?: string } = {}): Promise<Response> {
	return call(
		path,
		{ ...init, headers: { 'content-type': 'application/json', cookie: `linkbin_session=${fx.session}`, ...(init?.headers ?? {}) } },
		options,
	);
}

async function newShare(body: Record<string, unknown> = {}, options: { key?: string | null; origin?: string } = {}): Promise<{ status: number; body: any }> {
	const res = await asOperator('/api/shares', { method: 'POST', body: JSON.stringify({ objectId: fx.oneId, ...body }) }, options);
	return { status: res.status, body: (await res.json()) as any };
}

async function expire(token: string): Promise<void> {
	await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE token = ?')
		.bind(new Date(Date.now() - 1000).toISOString(), token)
		.run();
}

/**
 * A live share row written straight into the database.
 *
 * Used where a test needs a share to already exist but must not sign in to create one — the state where
 * SSH_MASTER_KEY is unset has no session at all, and that is the point of the test using it.
 */
async function seedShareRow(token: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO shares (token, object_id, password_salt, password_hash, password_iterations, expires_at, created_at)
		 VALUES (?, ?, NULL, NULL, NULL, ?, ?)`,
	)
		.bind(token, fx.oneId, new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), new Date().toISOString())
		.run();
}

/**
 * A session token signed with the key `src/index.ts` falls back to when `SSH_MASTER_KEY` is unset.
 *
 * This deliberately re-implements the derivation from the *published constant* rather than importing
 * anything from `src/`, because the claim being tested is that no secret is needed: the constant is in
 * the repository, and anyone who reads the source can derive the signing key from it.
 */
const PUBLISHED_FALLBACK_KEY = 'linkbin-test-key-not-for-deployment';

async function sessionFromKey(master: string, issuedAt: number): Promise<string> {
	const encoder = new TextEncoder();
	const material = await crypto.subtle.importKey('raw', encoder.encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const prk = await crypto.subtle.sign('HMAC', material, encoder.encode('linkbin/v1/session'));
	const signing = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const payload = `${issuedAt}.audit-b`;
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', signing, encoder.encode(payload)));
	let binary = '';
	for (const byte of signature) binary += String.fromCharCode(byte);
	return `${payload}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function sessionFromPublishedKey(issuedAt: number): Promise<string> {
	return sessionFromKey(PUBLISHED_FALLBACK_KEY, issuedAt);
}

/** A session correctly signed with the key the test deployment is configured with. */
function sessionSignedWithTestKey(issuedAt: number): Promise<string> {
	return sessionFromKey(TEST_MASTER_KEY, issuedAt);
}

// ------------------------------------------------------------------------------------------------
// H1 — a token must grant exactly the one object its row names
// ------------------------------------------------------------------------------------------------

describe('H1: a share token cannot be pointed at a different stored file', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('serves object one and nothing else, whatever parameters the recipient adds', async () => {
		const { body } = await newShare();
		const token = body.share.token as string;

		// A second share, so a token belonging to another object also exists and could be smuggled in.
		const second = await newShare({ objectId: fx.otherId });
		const otherToken = second.body.share.token as string;

		const attempts = [
			`/s/${token}?objectId=${fx.otherId}`,
			`/s/${token}?id=${fx.otherId}`,
			`/s/${token}?object_id=${fx.otherId}`,
			`/s/${token}?objectKey=${encodeURIComponent(OTHER_KEY)}`,
			`/s/${token}?key=${encodeURIComponent(OTHER_KEY)}`,
			`/s/${token}?path=${encodeURIComponent(OTHER_PATH)}`,
			`/s/${token}?token=${otherToken}`,
			`/s/${token}?share=${otherToken}`,
			`/s/${token}?objectId=${fx.otherId}&path=..%2f..%2fetc%2fshadow`,
			`/s/${token}/${otherToken}`,
			`/s/${token}?download=1&index=1&filename=${encodeURIComponent(OTHER_PATH)}`,
			`/s/${encodeURIComponent('../api/shares')}`,
		];

		for (const path of attempts) {
			const res = await call(path);
			const raw = await res.text();
			expect(raw, `${path} returned another object's bytes`).not.toContain(OTHER_CONTENT);
			expect(raw, `${path} returned object three's bytes`).not.toContain(DUMP_CONTENT);
			if (res.status === 200) expect(raw, `${path} served something other than its own object`).toBe(CONTENT);
		}
	});

	it('ignores a header that names another object', async () => {
		const { body } = await newShare();
		const res = await call(`/s/${body.share.token}`, {
			headers: {
				'x-object-id': String(fx.otherId),
				'x-object-key': OTHER_KEY,
				'x-share-object': String(fx.otherId),
				'x-forwarded-host': 'evil.example',
				range: 'bytes=0-3',
			},
		});
		const raw = await res.text();
		expect(raw).not.toContain(OTHER_CONTENT);
		expect(raw).toBe(CONTENT);
	});
});

// ------------------------------------------------------------------------------------------------
// H2 — the password must not be bypassable
// ------------------------------------------------------------------------------------------------

describe('H2: the password cannot be bypassed', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('refuses every submission that is not the password, and still accepts the password itself', async () => {
		const { body } = await newShare({ password: SHARE_PASSWORD });
		const token = body.share.token as string;

		const attempts: Array<{ why: string; path: string; headers?: Record<string, string> }> = [
			{ why: 'no password at all', path: `/s/${token}` },
			{ why: 'empty query value', path: `/s/${token}?password=` },
			{ why: 'bare parameter with no value', path: `/s/${token}?password` },
			{ why: 'wrong password', path: `/s/${token}`, headers: { 'x-share-password': 'not-the-password' } },
			{ why: 'uppercase password', path: `/s/${token}`, headers: { 'x-share-password': SHARE_PASSWORD.toUpperCase() } },
			{ why: 'password with a trailing space, in the query', path: `/s/${token}?password=${SHARE_PASSWORD}%20` },
			{ why: 'a differently named parameter', path: `/s/${token}?Password=${SHARE_PASSWORD}` },
			{ why: 'an array-shaped parameter', path: `/s/${token}?password[]=${SHARE_PASSWORD}` },
			{ why: 'a different share\'s password', path: `/s/${token}?password=${'xxxxxxxxxxxxxxxx'}` },
			// `?password=…%00` is deliberately absent from this loop: it is accepted, and that is measured and
			// explained in the `[measured]` test below rather than hidden here.
			{ why: 'empty header value', path: `/s/${token}`, headers: { 'x-share-password': '' } },
			{ why: 'header with a numeric value', path: `/s/${token}`, headers: { 'x-share-password': '0' } },
			{ why: 'a non-string-looking value', path: `/s/${token}`, headers: { 'x-share-password': 'null' } },
			{ why: 'the empty header shadowing a correct query value', path: `/s/${token}?password=${SHARE_PASSWORD}`, headers: { 'x-share-password': '' } },
			{ why: 'an empty query value shadowing nothing', path: `/s/${token}?password=&password=${SHARE_PASSWORD}` },
		];

		for (const attempt of attempts) {
			const res = await call(attempt.path, { headers: attempt.headers });
			const raw = await res.text();
			expect(res.status, `${attempt.why} was accepted (${attempt.path})`).toBe(401);
			expect(raw, `${attempt.why} leaked the file`).not.toContain(CONTENT);
		}

		// The control: the loop above must not be passing because the share is simply broken.
		const right = await call(`/s/${token}`, { headers: { 'x-share-password': SHARE_PASSWORD } });
		expect(right.status).toBe(200);
		expect(await right.text()).toBe(CONTENT);
	});

	it('[measured] a trailing NUL is ignored by verification, which is a leniency, not a bypass', async () => {
		// Measured, because the alternative was guessing. `hashPassword` treats a trailing NUL byte as
		// absent: `importKey('raw', …)` on this runtime does not distinguish `"P\0"` from `"P"`. It is not a
		// NUL-stripping pass — `"P\0x"` hashes differently — and no other control character behaves this way
		// (`%01` is refused), so it is specific to a trailing NUL.
		//
		// Why this is NOT a password bypass: every accepted value still contains the password. The two
		// directions are (a) the password plus a trailing NUL, which only someone who knows the password can
		// construct, and (b) a stored password that ends in a NUL being open to its own prefix, which is a
		// secret the recipient has to know anyway.
		const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
		expect(await hashPassword(`${SHARE_PASSWORD}\u0000`, salt)).toBe(await hashPassword(SHARE_PASSWORD, salt));
		expect(await hashPassword(`${SHARE_PASSWORD}\u0000x`, salt)).not.toBe(await hashPassword(SHARE_PASSWORD, salt));

		const { body } = await newShare({ password: SHARE_PASSWORD });
		const token = body.share.token as string;
		expect((await call(`/s/${token}?password=${SHARE_PASSWORD}%00`)).status).toBe(200);
		expect((await call(`/s/${token}?password=${SHARE_PASSWORD}%00x`)).status).toBe(401);
		expect((await call(`/s/${token}?password=${SHARE_PASSWORD}%01`)).status).toBe(401);
		expect((await call(`/s/${token}?password=wrong%00`)).status).toBe(401);
		expect((await call(`/s/${token}?password=%00`)).status).toBe(401);
	});

	it('[measured] the empty-password guard in verifySharePassword is load-bearing, not merely a fast path', async () => {
		// src/share.ts says of that guard: "PBKDF2 hashes the empty string to a value no real password
		// produces, so an empty submission cannot match a real password's hash regardless; it is refused there
		// for speed, not for safety. Confirmed by direct measurement rather than assumed."
		//
		// That is false on this runtime. A password of four NULs is accepted at creation (it is not
		// whitespace, so `sharePasswordProblem` passes it) and hashes exactly as the empty string does. Only
		// the `if (!password) return false` guard keeps such a share from being open to anyone who submits
		// nothing, so the comment invites a future change that would turn a cosmetic guard into the only
		// thing standing between a link and the file.
		const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
		expect(await hashPassword('\u0000\u0000\u0000\u0000', salt)).toBe(await hashPassword('', salt));

		const { status, body } = await newShare({ password: '\u0000\u0000\u0000\u0000' });
		expect(status, 'a four-NUL password must be accepted for this test to mean anything').toBe(200);
		const token = body.share.token as string;

		// The guard holds: nothing supplied is refused even though the hash is the empty string's.
		expect((await call(`/s/${token}?password=`)).status).toBe(401);
		expect((await call(`/s/${token}`)).status).toBe(401);
		// And the value the operator chose does work, which is the only thing that currently hides this.
		expect((await call(`/s/${token}?password=%00%00%00%00`)).status).toBe(200);
	});

	it('accepts a header value padded with a space only because HTTP strips it, and the query form does not', async () => {
		// Not a bypass: the accepted value is the password itself, with the surrounding whitespace removed by
		// the header parser before the Worker ever sees it (`headers.get` returns it stripped). Recorded so
		// the asymmetry with the query form is known rather than discovered later. A password whose stored
		// value has leading or trailing spaces is therefore reachable only through the query form.
		const { body } = await newShare({ password: SHARE_PASSWORD });
		const token = body.share.token as string;

		const paddedHeader = await call(`/s/${token}`, { headers: { 'x-share-password': `${SHARE_PASSWORD} ` } });
		expect(paddedHeader.status).toBe(200);

		const paddedQuery = await call(`/s/${token}?password=${SHARE_PASSWORD}%20`);
		expect(paddedQuery.status).toBe(401);
	});
});

// ------------------------------------------------------------------------------------------------
// H3 — refusals must carry no file content and no storage detail
// ------------------------------------------------------------------------------------------------

describe('H3: a refusal carries no file bytes and no storage detail', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('is empty of content for a missing password, a wrong one, an expired link and a cancelled one', async () => {
		const guarded = await newShare({ password: SHARE_PASSWORD });
		const open = await newShare();
		await expire(open.body.share.token);

		const revoked = await newShare({ password: SHARE_PASSWORD });
		await asOperator('/api/shares/revoke', { method: 'POST', body: JSON.stringify({ token: revoked.body.share.token }) });

		const cases: Array<{ label: string; res: Response }> = [
			{ label: 'missing password', res: await call(`/s/${guarded.body.share.token}`) },
			{ label: 'wrong password', res: await call(`/s/${guarded.body.share.token}`, { headers: { 'x-share-password': 'wrong' } }) },
			{ label: 'expired link, no password', res: await call(`/s/${open.body.share.token}`) },
			{ label: 'cancelled link, right password', res: await call(`/s/${revoked.body.share.token}`, { headers: { 'x-share-password': SHARE_PASSWORD } }) },
			{ label: 'unknown token', res: await call('/s/nothing-like-a-real-token') },
		];

		for (const { label, res } of cases) {
			const raw = await res.text();
			expect(res.status, `${label} should not be a success`).not.toBe(200);
			expect(raw, `${label} leaked object one`).not.toContain(CONTENT);
			expect(raw, `${label} leaked object two`).not.toContain(OTHER_CONTENT);
			expect(raw, `${label} leaked the storage key`).not.toContain('objects/');
			expect(raw, `${label} leaked the source path`).not.toContain('/etc/');
			expect(raw, `${label} leaked the content hash`).not.toContain(ONE_HASH);
			expect(raw, `${label} leaked the machine`).not.toContain('h.invalid');
			expect(res.headers.get('content-disposition'), `${label} offered a download`).toBeNull();
		}
	});

	it('refuses an expired link before the password, and does not dress a dead token up as a live one', async () => {
		const { body } = await newShare({ password: SHARE_PASSWORD });
		await expire(body.share.token);

		// Right password, dead link: the reason must be the expiry, so a recipient does not keep re-typing
		// a password that was never wrong.
		const res = await call(`/s/${body.share.token}`, { headers: { 'x-share-password': SHARE_PASSWORD } });
		const payload = (await res.json()) as any;
		expect(payload.reason).toBe('expired');
	});
});

// ------------------------------------------------------------------------------------------------
// H4 — what the recipient learns
// ------------------------------------------------------------------------------------------------

describe('H4: what a recipient learns about the machine and the store', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('learns the filename, the size and the expiry — not the path, the key, the hash or the host', async () => {
		const { body } = await newShare({ password: SHARE_PASSWORD });
		const res = await call(`/s/${body.share.token}`);
		const raw = await res.text();
		const payload = JSON.parse(raw) as any;

		for (const secret of [ONE_PATH, ONE_KEY, ONE_HASH, '/etc/', 'objects/', 'h.invalid', '"h1"', 'hostId', 'objectKey', 'contentHash']) {
			expect(raw, `the password prompt leaked ${secret}`).not.toContain(secret);
		}
		expect(payload.file.filename).toBe('config.yaml');
		expect(payload.file.sizeBytes).toBe(CONTENT.length);

		// The download itself must not carry the storage detail in a header either.
		const download = await call(`/s/${body.share.token}`, { headers: { 'x-share-password': SHARE_PASSWORD } });
		expect(await download.text()).toBe(CONTENT);
		for (const secret of [ONE_PATH, ONE_KEY, ONE_HASH, 'h.invalid']) {
			expect(download.headers.get('content-disposition') ?? '', `content-disposition leaked ${secret}`).not.toContain(secret);
		}
	});

	it('[baseline-failure] leaks the full source path when the stored path ends in a separator', async () => {
		// `row.path.split('/').pop() || row.path` (src/index.ts, publicShareView and serveShare) falls back
		// to the WHOLE path when the last segment is empty, which is the case for any path ending in '/'.
		// The fallback is meant for an empty path; it turns a directory-shaped path into a disclosure of the
		// machine's layout, in both the metadata response and the download's filename. Proven failing at the
		// audited revision, which returned `"filename": "/srv/private/dumps/"`.
		const created = await asOperator('/api/shares', { method: 'POST', body: JSON.stringify({ objectId: fx.dumpId, password: SHARE_PASSWORD }) });
		const token = ((await created.json()) as any).share.token as string;

		const prompt = await call(`/s/${token}`);
		const promptRaw = await prompt.text();
		const promptPayload = JSON.parse(promptRaw) as any;

		const download = await call(`/s/${token}`, { headers: { 'x-share-password': SHARE_PASSWORD } });
		const served = await download.text();
		const disposition = download.headers.get('content-disposition') ?? '';

		expect.soft(served, 'the download must still be the right object').toBe(DUMP_CONTENT);
		expect.soft(promptPayload.file.filename, 'the password prompt hands over the whole source path').toBe('dumps');
		expect.soft(disposition, 'the download filename hands over the whole source path').not.toContain(DUMP_PATH);
	});

	it('does not put the storage key or the hash in the bytes it serves', async () => {
		const { body } = await newShare();
		const res = await call(`/s/${body.share.token}`);
		const raw = await res.text();
		expect(raw).toBe(CONTENT);
		expect(raw).not.toContain(ONE_KEY);
		expect(raw).not.toContain(ONE_HASH);
	});
});

// ------------------------------------------------------------------------------------------------
// H5 — a dead link must stay dead
// ------------------------------------------------------------------------------------------------

describe('H5: an expired or cancelled link cannot be brought back', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('refuses a link at and after its expiry instant, with or without the right password', async () => {
		const guarded = await newShare({ password: SHARE_PASSWORD });
		const open = await newShare();

		// Exactly the expiry instant, not merely a moment after it.
		await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE token = ?').bind(new Date().toISOString(), open.body.share.token).run();
		const atInstant = await call(`/s/${open.body.share.token}`);
		expect(atInstant.status).toBe(410);
		expect(((await atInstant.json()) as any).reason).toBe('expired');

		await expire(guarded.body.share.token);
		const withPassword = await call(`/s/${guarded.body.share.token}`, { headers: { 'x-share-password': SHARE_PASSWORD } });
		expect(withPassword.status).toBe(410);
		expect(await withPassword.text()).not.toContain(CONTENT);
	});

	it('stays cancelled, cannot be un-cancelled by a second call, and cannot be extended', async () => {
		const { body } = await newShare({ password: SHARE_PASSWORD });
		const token = body.share.token as string;

		expect((await asOperator('/api/shares/revoke', { method: 'POST', body: JSON.stringify({ token }) })).status).toBe(200);
		expect((await call(`/s/${token}`)).status).toBe(410);

		// A second cancellation is refused, so nothing here silently flips the row back to active.
		expect((await asOperator('/api/shares/revoke', { method: 'POST', body: JSON.stringify({ token }) })).status).toBe(404);

		// Pushing the expiry far into the future must not revive a cancelled link.
		await env.DB.prepare('UPDATE shares SET expires_at = ? WHERE token = ?').bind('2099-01-01T00:00:00.000Z', token).run();
		const afterExtension = await call(`/s/${token}`, { headers: { 'x-share-password': SHARE_PASSWORD } });
		expect(afterExtension.status).toBe(410);
		expect(((await afterExtension.json()) as any).reason).toBe('revoked');
		expect(await (await call(`/s/${token}`)).text()).not.toContain(CONTENT);
	});

	it('a new link is a new token, so an old dead token never becomes the new one', async () => {
		const first = await newShare();
		await expire(first.body.share.token);
		expect((await call(`/s/${first.body.share.token}`)).status).toBe(410);

		const second = await newShare();
		expect(second.body.share.token).not.toBe(first.body.share.token);
		expect((await call(`/s/${first.body.share.token}`)).status).toBe(410);
		expect(await (await call(`/s/${second.body.share.token}`)).text()).toBe(CONTENT);
	});
});

// ------------------------------------------------------------------------------------------------
// H6 — creating or cancelling a share without signing in
// ------------------------------------------------------------------------------------------------

describe('H6: an unauthenticated caller cannot create or cancel a share', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('refuses an anonymous create, an anonymous cancel, and a tampered session', async () => {
		const { body } = await newShare();

		const anonymousCreate = await call('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ objectId: fx.oneId }),
		});
		expect(anonymousCreate.status).toBe(401);

		const anonymousCancel = await call('/api/shares/revoke', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: body.share.token }),
		});
		expect(anonymousCancel.status).toBe(401);

		// The share must still be alive after both attempts.
		expect((await call(`/s/${body.share.token}`)).status).toBe(200);

		// A session with its signed payload altered is not a session.
		const withTampered = await call('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `linkbin_session=${tamper(fx.session)}` },
			body: JSON.stringify({ objectId: fx.oneId }),
		});
		expect(withTampered.status).toBe(401);

		// A share token is not a session either: the two credentials are separate on purpose.
		const withShareToken = await call('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `linkbin_session=${body.share.token}` },
			body: JSON.stringify({ objectId: fx.oneId }),
		});
		expect(withShareToken.status).toBe(401);
	});

	it('refuses the same session-minted-from-the-published-key when a master key IS configured (the control)', async () => {
		// This passes, and it is what makes the two findings below causal: the forged token is refused here,
		// where `signingKey()` returns the configured secret, and — at the revision this audit started from —
		// accepted below, where it did not.
		const forged = await sessionFromPublishedKey(Date.now() + 60_000);
		const res = await call('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `linkbin_session=${forged}` },
			body: JSON.stringify({ objectId: fx.oneId }),
		});
		expect(res.status).toBe(401);
	});

	it('[baseline-failure] refuses a session stamped in the future, which no revocation floor can catch', async () => {
		// A token dated ten years ahead is always newer than the floor a password change or a sign-out moves,
		// and `issuedAt + SESSION_SECONDS * 1000 < Date.now()` is false for it, so the original check let it
		// through forever. Signed here with the configured key because the invariant is about the comparison,
		// not about how the token was obtained; at the audited revision this token authenticated.
		const future = await sessionSignedWithTestKey(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
		const res = await call('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `linkbin_session=${future}` },
			body: JSON.stringify({ objectId: fx.oneId }),
		});
		expect.soft(res.status, 'a session stamped ten years in the future authenticated').toBe(401);

		// And after the operator changes their password — documented to end every existing session — the
		// legitimate session is refused while a future-dated one would not be.
		const changed = await asOperator('/api/auth/password', {
			method: 'POST',
			body: JSON.stringify({ current: OPERATOR_PASSWORD, next: 'a completely different long password' }),
		});
		expect(changed.status).toBe(200);

		const legitimate = await asOperator('/api/shares', { method: 'POST', body: JSON.stringify({ objectId: fx.oneId }) });
		const stillFuture = await call('/api/shares', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: `linkbin_session=${future}` },
			body: JSON.stringify({ objectId: fx.oneId }),
		});
		expect.soft(legitimate.status, 'the real session must be refused after the password change').toBe(401);
		expect.soft(stillFuture.status, 'a future-dated session must be refused after the password change').toBe(401);
	});
});

describe('H6 (no SSH_MASTER_KEY on the deployment): the signing key must not be a published constant', () => {
	beforeEach(async () => {
		// The deployment state under test: a password IS set (so this is not the first-visit window), and
		// SSH_MASTER_KEY was never configured — which /api/status tells any visitor, without signing in.
		fx = await bootstrap(null);
	});

	it('confirms the deployment reports itself as having no master key', async () => {
		const status = (await (await call('/api/status', undefined, { key: null })).json()) as any;
		expect(status.masterKeySet).toBe(false);
	});

	it('[baseline-failure] refuses a session minted from the published constant, so a stranger cannot CREATE a share', async () => {
		// No password, no session, no secret: only the constant that is in this repository, from which the
		// session-signing key was derived at the audited revision. The property asserted is status-agnostic
		// on purpose: a deployment with no secret may refuse cleanly (401) or refuse to operate (503), but it
		// must never treat the caller as signed in.
		const forged = await sessionFromPublishedKey(Date.now() + 60_000);
		expect(forged).not.toBe(fx.session);

		const res = await call(
			'/api/shares',
			{ method: 'POST', headers: { 'content-type': 'application/json', cookie: `linkbin_session=${forged}` }, body: JSON.stringify({ objectId: fx.oneId }) },
			{ key: null },
		);
		const created = res.status === 200 ? ((await res.json()) as any).share?.token ?? null : null;
		const served = created ? await (await call(`/s/${created}`, undefined, { key: null })).text() : null;

		expect.soft(res.status, 'a session minted from a published constant was treated as signed in').not.toBe(200);
		expect.soft(created, 'a stranger created a share').toBeNull();
		expect.soft(served, 'the forged session produced a link that serves the file').toBeNull();
	});

	it("[baseline-failure] refuses the same forged session to CANCEL somebody else's share", async () => {
		// The operator's live share, seeded directly because this deployment cannot be signed into.
		const token = 'seeded-operator-share-token';
		await seedShareRow(token);
		expect(await (await call(`/s/${token}`, undefined, { key: null })).text()).toBe(CONTENT);

		const forged = await sessionFromPublishedKey(Date.now() + 60_000);
		const res = await call(
			'/api/shares/revoke',
			{ method: 'POST', headers: { 'content-type': 'application/json', cookie: `linkbin_session=${forged}` }, body: JSON.stringify({ token }) },
			{ key: null },
		);
		const afterwards = await call(`/s/${token}`, undefined, { key: null });

		expect.soft(res.status, "a stranger cancelled the operator's share").not.toBe(200);
		expect.soft(afterwards.status, "the operator's live link must still work").toBe(200);
	});
});

// ------------------------------------------------------------------------------------------------
// H7 — the origin in the share link comes from the request
// ------------------------------------------------------------------------------------------------

describe('H7: the share link is built from the origin the caller used', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('cannot be reached at all by an unauthenticated caller, so no attacker-controlled link is emitted', async () => {
		// The origin of a Worker request IS the Host the client sent, so putting another host in front of
		// the Worker is exactly how an attacker would try this.
		const res = await call(
			'/api/shares',
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: fx.oneId }) },
			{ origin: 'https://evil.example' },
		);
		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain('evil.example');
	});

	it('documents the mechanism: an authenticated request on another host yields a link on that host', async () => {
		// Confirmed rather than denied: the origin is the caller's. It is not an injection reachable by a
		// stranger, because reaching createShare at all requires a session (H6 above); the value of the
		// mechanism is that it works on a custom domain.
		const { status, body } = await newShare({}, { origin: 'https://evil.example' });
		expect(status).toBe(200);
		expect(body.share.url.startsWith('https://evil.example/s/')).toBe(true);
		expect(body.share.url).not.toContain(BASE);
	});
});

// ------------------------------------------------------------------------------------------------
// Adjacent: a malformed token must not be a server fault
// ------------------------------------------------------------------------------------------------

describe('a malformed token is refused like any other wrong token', () => {
	beforeEach(async () => {
		fx = await bootstrap();
	});

	it('[baseline-failure] answers a malformed token with the same clean 404, not a 500 carrying a stack trace', async () => {
		// The route documents that a wrong token must be indistinguishable from a dead one. At the audited
		// revision `/s/%` threw out of `decodeURIComponent`, and the error handler returned a 500 whose body
		// carried the message and a stack — to an anonymous caller, for input anyone could type by accident.
		for (const path of ['/s/%', '/s/%E0%A4%A', '/s/abc%']) {
			const res = await call(path);
			const raw = await res.text();
			let payload: any = null;
			try {
				payload = JSON.parse(raw);
			} catch {
				payload = null;
			}
			expect.soft(res.status, `${path} was answered with ${res.status}, not the refusal a wrong token gets`).toBe(404);
			expect.soft(payload?.error, `${path} handed an anonymous caller the internal error`).toBe('this link is not valid');
			expect.soft(payload?.stack, `${path} included a stack trace in the response`).toBeUndefined();
		}
	});
});
