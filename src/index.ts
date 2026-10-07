/**
 * LinkBin Worker.
 *
 * Two things live here:
 *
 *   1. The **management API and UI** — hosts, and the directories to collect from them, are added at
 *      runtime through the web UI and stored encrypted in D1. Adding a machine therefore needs no
 *      redeploy, and this deployment's only secret is `SSH_MASTER_KEY`.
 *   2. A **schema bootstrap** route. Deployment happens through Workers Builds from GitHub, so there
 *      is no CLI attached to a release: the Worker has to be able to create its own tables. The
 *      schema is the same `migrations/0001_init.sql` the CLI would use, imported as a string, so
 *      there is exactly one source of truth.
 *
 * The collection channel is SSH from this Worker out to the host. Nothing is installed on the hosts:
 * the Worker connects with `cloudflare:sockets` using a Workers-native SSH stack. `ssh2` cannot be
 * used at all because it compiles WebAssembly at import time and workerd forbids runtime compilation.
 *
 * Not built yet: collection into R2, the download path, and scheduling. The `objects` and
 * `multipart_sessions` tables exist, and the byte budget below is measured against them, but nothing
 * ingests yet.
 *
 * Constraint that shapes every write path: **D1 has no transactions.** The only atomic unit is a
 * single `db.batch()`. So multi-step intentions are expressed as independently repeatable statements
 * rather than as a unit that must succeed or fail as a whole.
 */

import { credentialFingerprint, decryptField, encryptField, generateMasterKey } from './crypto';
import { getHost, listHosts, nowIso, rulesForHost, slugify, type HostRow, type SourceRuleRow } from './db';
import { LOCALES, pickLocale, renderIndexPage, type Locale } from './ui';
import { statementsOf } from './sql';
import { REQUIRED_SCHEMA, SCHEMA_MIGRATIONS } from './migrations';
import { resolveRules, type RemoteHost } from './remote';
import { connectRemote } from './ssh-remote';
import { planAdmission, type BudgetObject } from './budget';
import { buildObjectQuery, type BrowseFilter, type BrowseSort, type ObjectRow } from './browse';
import { issuesForHost, runDetail, summarizeRuns, toIssueDetail, type IssueRow, type RunRow } from './receipts';
import {
	describeShare,
	newShareToken,
	hashSharePassword,
	resolveLifetime,
	shareLifetimeProblem,
	sharePasswordProblem,
	type ShareRow,
} from './share';
import {
	attemptLimits,
	hashPassword,
	minPasswordLength,
	newNonce,
	newSalt,
	passwordProblem,
	sessionMaxAgeSeconds,
	signSession,
	scheduleToken,
	isScheduleToken,
	timingSafeEqual,
	verifySession,
} from './auth';
// Wrangler's default bundling treats `.sql` as a `Text` module, so these are plain strings at runtime.
// Importing the migration files keeps the CLI path and the in-Worker path on one schema. The list itself
// lives in `src/migrations.ts` so a test can check it against the files: a migration that is not listed is
// never applied by a CLI-less deployment, and that is not visible from anywhere the running Worker can see.

interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	/**
	 * Base64 32-byte AES-GCM key. The ONLY secret this Worker needs. Everything else sensitive lives
	 * encrypted in D1.
	 */
	SSH_MASTER_KEY: string;
	/**
	 * Test-only. A stand-in for the remote machine, so rule resolution and collection can be exercised
	 * without a machine — which is necessary because local development cannot reach one.
	 *
	 * **Production never sets this**, and nothing in production code constructs a fake. If this is ever
	 * given a production implementation, that is a departure from the decision recorded in STATE.md
	 * rather than an implementation detail.
	 */
	TEST_REMOTE?: RemoteHost;
}

/**
 * The scale this deployment is designed for. These are enforced rather than advisory, because the
 * paid plan has hard ceilings underneath them and an unauthenticated API (D35) could otherwise be
 * used to walk straight past every one of them.
 */
const MAX_HOSTS = 50;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per file
const STORAGE_BUDGET_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB total in R2, a capacity budget

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers,
		},
	});
}

/** Narrows a `?lang=` value to a supported locale, so an unknown tag falls back to negotiation. */
function isLocale(value: string | null): value is Locale {
	return value !== null && (LOCALES as readonly string[]).includes(value);
}

function requireMasterKey(env: Env): string {	if (!env.SSH_MASTER_KEY) {
		throw new HttpError(
			503,
			'SSH_MASTER_KEY is not set on this deployment, so stored credentials cannot be read or written. Generate one at GET /api/master-key and set it as a secret.',
		);
	}
	return env.SSH_MASTER_KEY;
}

// ---------------------------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------------------------
// The migration list and the required-object list now live in `src/migrations.ts`, so they can be checked
// against the migration files themselves by a test rather than by reading. Both have drifted before, and
// both times the symptom was a readiness check that reported a healthy schema while a route could not run.

/**
 * The column a migration statement would add, or null when the statement adds no column.
 *
 * Kept as a guard rather than as machinery: a migration that adds a column cannot be applied twice,
 * so this is used to detect one at startup-feature time instead of letting it fail on a second run.
 * Prefer a new table over a new column.
 */
function columnAddedBy(sql: string): string | null {
	const match = /^\s*ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+ADD\s+COLUMN\s+["'`]?(\w+)["'`]?/i.exec(sql);
	return match ? `${match[1]}.${match[2]}` : null;
}

async function applySchema(env: Env): Promise<Response> {
	const planned: { migration: string; sql: string }[] = [];
	for (const migration of SCHEMA_MIGRATIONS) {
		for (const sql of statementsOf(migration.sql)) {
			planned.push({ migration: migration.name, sql });
		}
	}

	// A column-adding statement cannot be made repeatable, so a migration containing one is a
	// mistake rather than something to work around. Failing here names the migration instead of
	// surfacing later as a duplicate-column error on the second press of a button.
	const offender = planned.find((step) => columnAddedBy(step.sql) !== null);
	if (offender) {
		throw new HttpError(
			500,
			`migration ${offender.migration} adds a column, which cannot be applied twice; use a new table instead`,
		);
	}

	const statements = planned.map((step) => env.DB.prepare(step.sql));

	// Batch size is bounded on purpose: a batch is atomic, so a smaller batch means a failure names a
	// narrower range. It is not atomic ACROSS batches, which is exactly why every statement is
	// idempotent and re-running the whole thing is safe.
	const BATCH = 20;
	let applied = 0;
	for (let i = 0; i < statements.length; i += BATCH) {
		await env.DB.batch(statements.slice(i, i + BATCH));
		applied += Math.min(BATCH, statements.length - i);
	}

	const { results } = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
	).all<{ name: string }>();

	return json({
		ok: true,
		statementsApplied: applied,
		migrations: SCHEMA_MIGRATIONS.map((m) => m.name),
		objects: (results ?? []).map((t) => t.name),
		note: 'Idempotent: every statement is CREATE ... IF NOT EXISTS, so this is safe to repeat.',
	});
}

/**
 * Reports whether the schema is present, so the interface can tell the operator what to do next.
 *
 * The list of required objects lives in `src/migrations.ts` so a test can check it against the migration
 * files. It has drifted before: two features added tables without extending it, and the result was a
 * readiness check reporting a healthy schema while a route could not run at all — worse than no check,
 * because it is believed.
 */
async function schemaStatus(env: Env): Promise<{ ready: boolean; missing: string[] }> {
	const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all<{
		name: string;
	}>();
	const present = new Set((results ?? []).map((r) => r.name));
	const missing = REQUIRED_SCHEMA.filter((name) => !present.has(name));
	return { ready: missing.length === 0, missing };
}

/**
 * Whether the database has everything the Worker needs, cached for the life of the request.
 *
 * The guard exists because a missing migration used to surface as a 500 whose body carried a stack trace
 * and the failing SQL — internal detail handed to an anonymous caller, and a message that told the
 * operator nothing about what to do. A deployment with an unapplied migration is a configuration state,
 * not a crash, and it is reported as one.
 */
async function schemaReady(env: Env): Promise<{ ready: boolean; missing: string[] }> {
	return await schemaStatus(env);
}

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

const SESSION_COOKIE = 'linkbin_session';

/**
 * Routes reachable without signing in.
 *
 * `/api/auth/*` obviously, or there would be no way in. `/api/admin/apply-schema` is here because on a
 * fresh deployment the tables do not exist yet, so there is nowhere to store a password and no way to
 * authenticate — the bootstrap has to precede the lock. It is idempotent, creates only tables and
 * indexes, and reads nothing, so the exposure is bounded to "someone could ensure the schema exists".
 * Everything else, including every route that touches a stored credential, requires a session.
 */
function isPublicApi(path: string): boolean {
	if (path.startsWith('/api/auth/')) return true;
	if (path === '/api/admin/apply-schema') return true;
	// Needed before a password can exist, and it exposes no credential.
	if (path === '/api/status') return true;
	return false;
}

/** The master key, or a test-only stand-in so the suite does not need a real secret. */
function signingKey(env: Env): string {
	return env.SSH_MASTER_KEY ?? 'linkbin-test-key-not-for-deployment';
}

interface AuthRow {
	salt: string;
	hash: string;
	iterations: number;
	changed_at: string;
	sessions_revoked_at: string;
}

async function authRow(env: Env): Promise<AuthRow | null> {
	return await env.DB.prepare('SELECT salt, hash, iterations, changed_at, sessions_revoked_at FROM auth_secret WHERE id = 1').first<AuthRow>();
}

/** Reads a timestamp as epoch milliseconds; 0 when absent, so a missing floor blocks nothing. */
function millis(iso: string | null | undefined): number {
	if (!iso) return 0;
	const value = Date.parse(iso);
	return Number.isFinite(value) ? value : 0;
}

/** The instant before which a session is no longer honoured. */
async function sessionFloor(env: Env): Promise<number> {
	const row = await authRow(env);
	if (!row) return 0;
	return Math.max(millis(row.changed_at), millis(row.sessions_revoked_at));
}

function readSessionToken(request: Request): string | null {
	const cookie = request.headers.get('cookie');
	if (cookie) {
		for (const part of cookie.split(';')) {
			const [name, ...rest] = part.trim().split('=');
			if (name === SESSION_COOKIE) return rest.join('=') || null;
		}
	}
	// A bearer token as well as a cookie, so a non-browser caller does not have to fake a cookie jar.
	const auth = request.headers.get('authorization');
	if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || null;
	return null;
}

async function isSignedIn(env: Env, request: Request): Promise<boolean> {
	const token = readSessionToken(request);
	if (!token) return false;
	const check = await verifySession(signingKey(env), token, await sessionFloor(env));
	return check.valid;
}

/**
 * Whether the caller presented the scheduler's credential rather than a session.
 *
 * Deliberately separate from {@link isSignedIn}: the two are different credentials, and a session must
 * not be usable where the scheduler's is expected, nor the reverse. Collapsing them would mean
 * revoking one silently disabled the other.
 */
async function isScheduler(env: Env, request: Request): Promise<boolean> {
	const token = readSessionToken(request);
	if (!token) return false;
	return await isScheduleToken(signingKey(env), token);
}

/**
 * Failed attempts from one caller within the window. Counted, not incremented, so it cannot drift out
 * of step with what actually happened.
 *
 * Scoped to the caller deliberately. Counting failures globally would let anyone lock the operator out
 * simply by failing repeatedly — turning a protection into a denial of service against the only
 * account this deployment has.
 */
async function recentFailures(env: Env, remote: string): Promise<number> {
	const { windowSeconds } = attemptLimits();
	const since = new Date((Math.floor(Date.now() / 1000) - windowSeconds) * 1000).toISOString();
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE succeeded = 0 AND at >= ? AND remote IS ?')
		.bind(since, remote)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** The caller's address, as far as this deployment can tell. */
function callerAddress(request: Request): string {
	return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
}

async function recordAttempt(env: Env, succeeded: boolean, remote: string | null): Promise<void> {
	// One statement, so no atomicity is needed; a lost row weakens the limit slightly rather than
	// breaking anything, which is the right way round for a rate limiter with no transactions.
	await env.DB.prepare('INSERT INTO auth_attempts (at, succeeded, remote) VALUES (?, ?, ?)')
		.bind(nowIso(), succeeded ? 1 : 0, remote)
		.run();
}

function sessionCookieHeader(token: string, maxAge: number): string {
	// HttpOnly so a script cannot read it, SameSite=Lax so a cross-site form post cannot use it, and
	// Secure so it is not sent over plain HTTP. `Path=/` because the whole interface needs it.
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

function clearedCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

async function handleAuth(path: string, request: Request, env: Env): Promise<Response> {
	const row = await authRow(env);

	if (path === '/api/auth/state' && request.method === 'GET') {
		return json({
			configured: row !== null,
			signedIn: row !== null && (await isSignedIn(env, request)),
			minPasswordLength: minPasswordLength(),
		});
	}

	// First visit: set the password. Refused once one exists, so this cannot be used to overwrite it —
	// the check is the row's existence, not a flag that could be reset.
	if (path === '/api/auth/setup' && request.method === 'POST') {
		if (row) throw new HttpError(409, 'a password is already set; sign in and change it instead');

		const body = (await request.json()) as { password?: string };
		const problem = passwordProblem(String(body.password ?? ''));
		if (problem) throw new HttpError(400, problem);

		const salt = newSalt();
		const hash = await hashPassword(body.password!, salt);
		const now = nowIso();
		await env.DB.prepare(
			'INSERT INTO auth_secret (id, salt, hash, iterations, changed_at, sessions_revoked_at, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
		)
			.bind(salt, hash, 210_000, now, now, now)
			.run();

		return json({ ok: true, configured: true });
	}

	if (path === '/api/auth/login' && request.method === 'POST') {
		if (!row) throw new HttpError(409, 'no password is set yet');

		const remote = callerAddress(request);
		const { max } = attemptLimits();
		if ((await recentFailures(env, remote)) >= max) {
			throw new HttpError(429, 'too many failed attempts; wait a few minutes and try again');
		}

		const body = (await request.json()) as { password?: string };
		const candidate = String(body.password ?? '');
		const hash = await hashPassword(candidate, row.salt, Number(row.iterations));
		const ok = timingSafeEqual(hash, row.hash);
		await recordAttempt(env, ok, remote);

		if (!ok) throw new HttpError(401, 'that password is not correct');

		const token = await signSession(signingKey(env), Date.now(), newNonce());
		return json({ ok: true, expiresInSeconds: sessionMaxAgeSeconds() }, 200, {
			'set-cookie': sessionCookieHeader(token, sessionMaxAgeSeconds()),
		});
	}

	// Sign-out is server-enforced: the floor moves past this token, so it stops working immediately
	// rather than only being forgotten by whatever was holding it.
	if (path === '/api/auth/logout' && request.method === 'POST') {
		if (row) {
			await env.DB.prepare('UPDATE auth_secret SET sessions_revoked_at = ? WHERE id = 1').bind(nowIso()).run();
		}
		return json({ ok: true }, 200, { 'set-cookie': clearedCookieHeader() });
	}

	if (path === '/api/auth/password' && request.method === 'POST') {
		if (!row) throw new HttpError(409, 'no password is set yet');
		if (!(await isSignedIn(env, request))) throw new HttpError(401, 'sign in first');

		const body = (await request.json()) as { current?: string; next?: string };
		const currentHash = await hashPassword(String(body.current ?? ''), row.salt, Number(row.iterations));
		if (!timingSafeEqual(currentHash, row.hash)) throw new HttpError(401, 'the current password is not correct');

		const problem = passwordProblem(String(body.next ?? ''));
		if (problem) throw new HttpError(400, problem);

		// A fresh salt: reusing one across two passwords would let a precomputed table for the old
		// password apply to the new one.
		const salt = newSalt();
		const hash = await hashPassword(body.next!, salt);
		const now = nowIso();
		await env.DB.prepare('UPDATE auth_secret SET salt = ?, hash = ?, iterations = ?, changed_at = ?, sessions_revoked_at = ? WHERE id = 1')
			.bind(salt, hash, 210_000, now, now)
			.run();

		return json({ ok: true }, 200, { 'set-cookie': clearedCookieHeader() });
	}

	throw new HttpError(404, `unknown auth route ${path}`);
}

// ---------------------------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------------------------

const PUBLIC_SHARE_PREFIX = '/s/';

interface ShareJoinRow extends ShareRow {
	object_key: string;
	path: string;
	size_bytes: number;
	content_hash: string;
	host_id: string;
}

async function shareByToken(db: D1Database, token: string): Promise<ShareJoinRow | null> {
	// Joined to the object so the recipient's page can state the size before anything is sent, as the
	// ticket requires, without a second query.
	try {
		return await db
			.prepare(
				`SELECT s.*, o.object_key, o.path, o.size_bytes, o.content_hash, o.host_id
				 FROM shares s
				 JOIN objects o ON o.id = s.object_id
				 WHERE s.token = ?`,
			)
			.bind(token)
			.first<ShareJoinRow>();
	} catch {
		// Includes "no such table" on a deployment whose migration has not been applied. Returning null turns
		// that into the same clean refusal a wrong token gets, instead of a 500 carrying a stack trace and the
		// failing SQL to whoever holds the link. The `/api/status` check is what tells the operator the real
		// cause; a recipient cannot act on it and should not be shown it.
		return null;
	}
}

/** What the recipient is told before any bytes move. Never includes the object key or the machine. */
function publicShareView(row: ShareJoinRow): Record<string, unknown> {
	return {
		token: row.token,
		// The filename is the last path segment, not the full source path: the recipient has no business
		// learning the directory layout of a machine they were not given access to.
		filename: row.path.split('/').pop() || row.path,
		sizeBytes: row.size_bytes,
		expiresAt: row.expires_at,
		needsPassword: Boolean(row.password_hash),
	};
}

/** The operator's list: what each share points at, and when it dies. */
function operatorShareView(row: ShareJoinRow): Record<string, unknown> {
	return {
		token: row.token,
		hostId: row.host_id,
		path: row.path,
		sizeBytes: row.size_bytes,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
		hasPassword: Boolean(row.password_hash),
		useCount: row.use_count,
		lastUsedAt: row.last_used_at,
		// Precomputed so the interface does not have to decide what "expired" means.
		active: !row.revoked_at && Date.now() < Date.parse(row.expires_at),
	};
}

/**
 * A stored file as the interface reads it.
 *
 * The storage key is included deliberately, unlike in a share view: this is the operator's own listing, on
 * the authenticated side, and the key is what identifies the row if it ever needs looking up directly. A
 * share view withholds it because the recipient has no business with it.
 */
function objectView(row: ObjectRow): Record<string, unknown> {
	return {
		id: row.id,
		hostId: row.host_id,
		path: row.path,
		sizeBytes: row.size_bytes,
		contentHash: row.content_hash,
		// Whole seconds, as the machine reports. Null when the machine did not report one, which is different
		// from zero and must not be rendered as 1970.
		mtime: row.mtime,
		createdAt: row.created_at,
		important: Number(row.important ?? 0) === 1,
		superseded: row.superseded_by !== null,
		// Lets the interface offer a download or a share without a second request to find out whether the file
		// is reachable. False for a superseded version, whose bytes may since have been reclaimed.
		live: row.superseded_by === null && row.deleted_at === null,
	};
}

async function createShare(env: Env, request: Request, baseUrl: string): Promise<Response> {
	const body = (await request.json()) as { objectId?: number; seconds?: number; password?: unknown };

	const objectId = Number(body.objectId);
	if (!Number.isInteger(objectId) || objectId <= 0) throw new HttpError(400, 'objectId must be the id of a stored file');

	const row = await env.DB.prepare('SELECT id, size_bytes FROM objects WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL')
		.bind(objectId)
		.first<{ id: number; size_bytes: number }>();
	if (!row) throw new HttpError(404, 'no live stored file with that id');

	const lifetimeProblem = shareLifetimeProblem(body.seconds === undefined ? undefined : Number(body.seconds));
	if (lifetimeProblem) throw new HttpError(400, lifetimeProblem);

	// A password of "" would create a share that reads as protected while being open to anyone. That check
	// lives at creation, where it is a real boundary, rather than only at verification where it is not.
	let password: { salt: string; hash: string; iterations: number } | null = null;
	if (body.password !== undefined && body.password !== null) {
		const problem = sharePasswordProblem(body.password);
		if (problem) throw new HttpError(400, problem);
		password = await hashSharePassword(String(body.password));
	}

	const token = newShareToken();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + resolveLifetime(body.seconds === undefined ? undefined : Number(body.seconds)) * 1000);

	await env.DB.prepare(
		`INSERT INTO shares (token, object_id, password_salt, password_hash, password_iterations, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			token,
			objectId,
			password?.salt ?? null,
			password?.hash ?? null,
			password?.iterations ?? null,
			expiresAt.toISOString(),
			now.toISOString(),
		)
		.run();

	return json({
		ok: true,
		share: {
			token,
			// The link is built from the request's own origin, so it works on a custom domain rather than
			// naming a storage hostname or a hard-coded deployment address.
			url: `${baseUrl}${PUBLIC_SHARE_PREFIX}${token}`,
			expiresAt: expiresAt.toISOString(),
			hasPassword: password !== null,
		},
	});
}

/**
 * Serves a share to a recipient who has no account and no other access.
 *
 * The password is checked **here**, before any byte of the file is produced. That is the whole reason the
 * link is issued by this Worker rather than by storage: a check anywhere else is bypassed by going to
 * storage directly, and a refusal that happens after the first bytes have been sent is not a refusal.
 */
async function serveShare(env: Env, request: Request, token: string, baseUrl: string): Promise<Response> {
	const row = await shareByToken(env.DB, token);
	if (!row) {
		// The same shape as an expired or cancelled link, so a wrong token cannot be distinguished from a
		// dead one by probing.
		return json({ ok: false, error: 'this link is not valid', reason: 'unknown' }, 404);
	}

	// A password may arrive as a query parameter or an explicit header. The header is preferred so the
	// password does not end up in a URL that gets logged or shared; the query form exists because a plain
	// browser download cannot set a header.
	const supplied = request.headers.get('x-share-password') ?? new URL(request.url).searchParams.get('password');

	const decision = await describeShare(row, supplied);
	if (!decision.usable) {
		// `needsPassword` is not a failure — the recipient is being asked for one thing, not told no — so it
		// is answered with the metadata they need to decide, and no content.
		const status = decision.needsPassword ? 401 : 410;
		return json({ ok: false, error: decision.message, reason: decision.reason, file: publicShareView(row) }, status);
	}

	const object = await env.BUCKET.get(row.object_key);
	if (!object) {
		// The record says the file should exist and the bucket disagrees. That is a real fault worth naming
		// rather than dressing up as a missing share.
		return json({ ok: false, error: 'the stored file is missing', reason: 'gone' }, 410);
	}

	// Bookkeeping only: a lost update here costs a count, not correctness, so it needs no atomicity.
	await env.DB.prepare('UPDATE shares SET use_count = use_count + 1, last_used_at = ? WHERE token = ?')
		.bind(new Date().toISOString(), row.token)
		.run();

	const filename = row.path.split('/').pop() || 'download';

	// Streamed, not buffered: the per-file limit is far larger than this runtime's memory, so reading the
	// object into a variable here would defeat the entire streaming pipeline that stored it.
	return new Response(object.body, {
		status: 200,
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(object.size),
			// The size is stated before the download starts, and the filename is quoted so a name with a space
			// or a semicolon cannot break the header.
			'content-disposition': `attachment; filename="${filename.replace(/["\\]/g, '_')}"`,
			'cache-control': 'no-store',
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Storage budget
// ---------------------------------------------------------------------------------------------

interface StorageUsage {
	/** Bytes in live objects — rows that are neither superseded nor soft-deleted. */
	liveBytes: number;
	/** Bytes retained by superseded or soft-deleted rows that have not been collected yet. */
	retainedBytes: number;
	/** Live + retained: what R2 is actually holding, which is what the 10 GB ceiling applies to. */
	totalBytes: number;
	objectCount: number;
	budgetBytes: number;
	remainingBytes: number;
	usedFraction: number;
	/**
	 * True when the store is full and every remaining file is protected, so new files are being refused and
	 * nothing may be reclaimed. The interface needs this distinctly from simply being full: only this case is
	 * resolved by unmarking a file.
	 */
	saturatedByImportant: boolean;
	/** Bytes that are protected from eviction. */
	importantBytes: number;
}

/**
 * Every object the bucket holds, in any state, with its protection flag.
 *
 * Superseded and soft-deleted objects are included because they still occupy storage and are still
 * charged — a figure counting only live objects could pass the ceiling while the real total was over it.
 * `object_flags` is joined rather than a column on `objects`, because adding a column is the one migration
 * change that cannot be applied twice (see migration 0003).
 */
async function storageObjects(db: D1Database): Promise<BudgetObject[]> {
	const { results } = await db
		.prepare(
			`SELECT o.id                AS id,
			        o.size_bytes        AS size,
			        CASE WHEN f.object_id IS NULL THEN 0 ELSE 1 END AS important,
			        CASE WHEN o.superseded_by IS NULL THEN 0 ELSE 1 END AS superseded,
			        CASE WHEN o.deleted_at IS NULL THEN 0 ELSE 1 END AS deleted,
			        o.created_at        AS created_at
			 FROM objects o
			 LEFT JOIN object_flags f ON f.object_id = o.id`,
		)
		.all<{ id: number; size: number; important: number; superseded: number; deleted: number; created_at: string }>();

	return (results ?? []).map((row) => ({
		id: Number(row.id),
		size: Number(row.size ?? 0),
		important: Number(row.important) === 1,
		superseded: Number(row.superseded) === 1,
		deleted: Number(row.deleted) === 1,
		createdAt: String(row.created_at),
	}));
}

/**
 * Measures what the store is holding, and reports the budget state.
 *
 * The totals and the used fraction come from `planAdmission` rather than being computed here as well. They
 * were computed here originally; having the same arithmetic in two places means the number the operator
 * sees and the number the policy acts on can disagree, and the one that is wrong is invisible until the
 * ceiling is crossed.
 */
async function measureStorage(db: D1Database): Promise<StorageUsage> {
	const objects = await storageObjects(db);
	const plan = planAdmission({ ceilingBytes: STORAGE_BUDGET_BYTES, newSize: 0, objects });

	const liveBytes = objects.filter((o) => !o.superseded && !o.deleted).reduce((total, o) => total + o.size, 0);
	const importantBytes = objects.filter((o) => o.important).reduce((total, o) => total + o.size, 0);

	return {
		liveBytes,
		retainedBytes: plan.heldBytes - liveBytes,
		totalBytes: plan.heldBytes,
		objectCount: objects.length,
		budgetBytes: STORAGE_BUDGET_BYTES,
		remainingBytes: Math.max(0, STORAGE_BUDGET_BYTES - plan.heldBytes),
		usedFraction: plan.usedFraction,
		// Saturation is a property of what is held, not of a particular incoming file, so it is asked as
		// "would the smallest possible file fit, and if not, is it because everything left is protected".
		saturatedByImportant: planAdmission({ ceilingBytes: STORAGE_BUDGET_BYTES, newSize: 1, objects }).saturatedByImportant,
		importantBytes,
	};
}

/**
 * Decides whether one more file of `size` bytes fits, before anything is transferred.
 *
 * Called before an upload rather than after, so a file that cannot fit is refused instead of being
 * read from the host and then discarded. Nothing calls this yet — the ingest path is not built — and
 * that is exactly why it exists now: the alternative is discovering the ceiling in production.
 */
async function checkFileBudget(db: D1Database, size: number): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!Number.isFinite(size) || size < 0) return { ok: false, reason: 'file size is not a valid non-negative number' };
	if (size > MAX_FILE_BYTES) {
		return { ok: false, reason: `file is ${size} bytes, above the ${MAX_FILE_BYTES} byte per-file limit` };
	}
	const usage = await measureStorage(db);
	if (usage.totalBytes + size > STORAGE_BUDGET_BYTES) {
		return {
			ok: false,
			reason: `storing ${size} bytes would take the bucket to ${usage.totalBytes + size} of a ${STORAGE_BUDGET_BYTES} byte budget; ${usage.remainingBytes} bytes remain`,
		};
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------

/**
 * The host view handed to the UI.
 *
 * Ciphertext never leaves the Worker. What the UI receives instead is a short stable fingerprint, so
 * it can say "a password is stored" — and notice when that changes — without being able to recover
 * it. This is a presentation boundary; the real boundary is that D1 only ever holds ciphertext.
 */
async function publicHost(row: HostRow) {
	return {
		id: row.id,
		label: row.label,
		address: row.address,
		port: row.port,
		username: row.username,
		hostKeyFingerprint: row.host_key_fingerprint,
		enabled: row.enabled === 1,
		hasPassword: row.password_enc !== null,
		passwordFingerprint: await credentialFingerprint(row.password_enc),
		hasPrivateKey: row.private_key_enc !== null,
		privateKeyFingerprint: await credentialFingerprint(row.private_key_enc),
		hasPrivateKeyPassphrase: row.private_key_pass_enc !== null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function publicRule(row: SourceRuleRow) {
	return {
		id: row.id,
		scope: row.host_id === null ? 'global' : 'host',
		hostId: row.host_id,
		pattern: row.pattern,
		isExclude: row.is_exclude === 1,
		note: row.note,
		enabled: row.enabled === 1,
	};
}

async function upsertHost(env: Env, body: Record<string, unknown>): Promise<Response> {
	const masterKey = requireMasterKey(env);

	const address = String(body.address ?? '').trim();
	const username = String(body.username ?? '').trim();
	const label = String(body.label ?? '').trim() || address;
	const port = Number(body.port ?? 22);

	if (!address) throw new HttpError(400, 'address is required');
	if (!username) throw new HttpError(400, 'username is required');
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'port must be an integer between 1 and 65535');

	// The id doubles as the AES-GCM additional data for the encrypted columns, so it is fixed at
	// creation and never rewritten: changing it would silently orphan every stored credential.
	const id = body.id ? slugify(String(body.id)) : slugify(label || address);
	if (!id) throw new HttpError(400, 'could not derive a usable id; supply one explicitly');

	const existing = await getHost(env.DB, id);
	const timestamp = nowIso();

	// The host ceiling applies to CREATING a host, not to updating one. Checking the total on every
	// write would make the 50th host uneditable — the operator could no longer rotate its password.
	if (!existing) {
		const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM hosts').first<{ n: number }>();
		const count = Number(countRow?.n ?? 0);
		if (count >= MAX_HOSTS) {
			throw new HttpError(400, `this deployment is designed for at most ${MAX_HOSTS} hosts and already has ${count}; delete one first`);
		}
	}

	// Only encrypt what was supplied. An omitted field means "keep what is stored", which is exactly
	// what lets the UI edit a host without ever handling the existing credential.
	const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : null;
	const privateKey = typeof body.privateKey === 'string' && body.privateKey.length > 0 ? body.privateKey : null;
	const privateKeyPassphrase =
		typeof body.privateKeyPassphrase === 'string' && body.privateKeyPassphrase.length > 0 ? body.privateKeyPassphrase : null;

	const passwordEnc = password ? await encryptField(masterKey, id, 'password', password) : (existing?.password_enc ?? null);
	const privateKeyEnc = privateKey ? await encryptField(masterKey, id, 'private_key', privateKey) : (existing?.private_key_enc ?? null);
	const privateKeyPassEnc = privateKeyPassphrase
		? await encryptField(masterKey, id, 'private_key_passphrase', privateKeyPassphrase)
		: (existing?.private_key_pass_enc ?? null);

	// One statement, so no atomicity is required. Repeating it with the same id updates in place.
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, password_enc, private_key_enc, private_key_pass_enc,
		                    host_key_fingerprint, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET
		   label = excluded.label,
		   address = excluded.address,
		   port = excluded.port,
		   username = excluded.username,
		   password_enc = excluded.password_enc,
		   private_key_enc = excluded.private_key_enc,
		   private_key_pass_enc = excluded.private_key_pass_enc,
		   enabled = excluded.enabled,
		   updated_at = excluded.updated_at`,
	)
		.bind(
			id,
			label,
			address,
			port,
			username,
			passwordEnc,
			privateKeyEnc,
			privateKeyPassEnc,
			existing?.host_key_fingerprint ?? null,
			body.enabled === false ? 0 : 1,
			existing?.created_at ?? timestamp,
			timestamp,
		)
		.run();

	const saved = await getHost(env.DB, id);
	return json({ ok: true, host: saved ? await publicHost(saved) : null });
}

// ---------------------------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------------------------

/**
 * Builds SSH options for a stored host, decrypting at the last possible moment.
 *
 * The plaintext exists only for the duration of this call. It is never logged, never returned, and
 * never written anywhere. Because the host id is bound into the ciphertext as additional data, a
 * credential copied from another row fails here instead of authenticating as the wrong machine.
 */
async function connectOptionsFor(env: Env, row: HostRow) {
	const masterKey = requireMasterKey(env);

	let password: string | undefined;
	let privateKey: { pem: string; passphrase?: string } | undefined;

	if (row.password_enc) password = await decryptField(masterKey, row.id, 'password', row.password_enc);
	if (row.private_key_enc) {
		const pem = await decryptField(masterKey, row.id, 'private_key', row.private_key_enc);
		const passphrase = row.private_key_pass_enc
			? await decryptField(masterKey, row.id, 'private_key_passphrase', row.private_key_pass_enc)
			: undefined;
		privateKey = { pem, passphrase };
	}

	if (!password && !privateKey) throw new HttpError(400, `host ${row.id} has no stored credential`);

	return {
		hostname: row.address,
		port: row.port,
		username: row.username,
		password,
		privateKey,
		// `cipher` is a preference LIST, not a single value: Wrangler's bundler does no type checking,
		// so passing a bare string compiles cleanly and then fails at KEXINIT construction with
		// "names.join is not a function". That mistake was made once and found only against a real
		// host, which is why the shape is spelled out here.
		//
		// AES-GCM first because it is WebCrypto-backed. aes-ctr is the fallback so a host without GCM
		// still works; chacha20-poly1305 is deliberately absent because it would be assembled in pure
		// JS and is the likeliest way to exhaust the CPU budget (see decision D24).
		algorithms: { cipher: ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'] },
		timeoutMs: 20_000,
	};
}

/**
 * A machine's self-identification, degrading gracefully when the remote cannot run commands.
 *
 * The commands are a fixed set chosen here. Nothing is assembled from user input, which is what keeps
 * this from becoming the arbitrary-command surface that an earlier diagnostic route turned into.
 */
async function identifyRemote(remote: RemoteHost, row: HostRow) {
	if (!remote.exec) {
		return { uname: 'not available for this remote', whoami: row.username, hostname: row.address, disk: null };
	}
	const attempt = async (command: string, fallback: string): Promise<string> => {
		try {
			return (await remote.exec!(command)).trim() || fallback;
		} catch {
			return fallback;
		}
	};
	return {
		uname: await attempt('uname -a', 'unknown'),
		whoami: await attempt('whoami', row.username),
		hostname: await attempt('hostname', row.address),
		disk: null,
	};
}

/**
 * Connects to a machine, identifies it, and reports how each applicable rule resolves against its real
 * filesystem.
 *
 * Read-only throughout: it runs `uname`, `whoami`, `hostname`, and lists directories. Nothing on the
 * machine is written, renamed or deleted.
 *
 * The connection goes through the {@link RemoteHost} port rather than being opened here, so rule
 * resolution can be exercised without a machine. Rules themselves are resolved by {@link resolveRules},
 * which owns the three-way outcome (matched, nothing matched, could not be resolved) — the distinction
 * an operator actually needs.
 */
async function testHost(env: Env, id: string): Promise<Response> {
	const row = await getHost(env.DB, id);
	if (!row) throw new HttpError(404, `no host with id ${id}`);

	const stages: { stage: string; ms: number }[] = [];
	const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
		const t0 = Date.now();
		try {
			return await fn();
		} finally {
			stages.push({ stage, ms: Date.now() - t0 });
		}
	};

	const rules = await rulesForHost(env.DB, id);

	// A substituted remote, when one is provided, so rule resolution is testable without a machine.
	// Production has no such binding and therefore always takes the SSH path below.
	if (env.TEST_REMOTE) {
		const facts = await timed('identify', () => identifyRemote(env.TEST_REMOTE!, row));
		const evaluations = await timed('resolve rules', () => resolveRules(env.TEST_REMOTE!, rules));
		return json({
			ok: true,
			host: await publicHost(row),
			facts,
			rules: rules.map(publicRule),
			evaluations,
			stages,
			substituted: true,
		});
	}

	// Decryption happens before the timer starts: the measured stage should be the connection, not the
	// fast local key work, and this keeps the plaintext alive for the shortest span possible.
	const options = await connectOptionsFor(env, row);
	const { remote, close } = await timed('ssh connect + auth', () => connectRemote(options));

	try {
		const facts = await timed('identify', () => identifyRemote(remote, row));
		const evaluations = await timed('resolve rules', () => resolveRules(remote, rules));

		return json({ ok: true, host: await publicHost(row), facts, rules: rules.map(publicRule), evaluations, stages });
	} finally {
		await close();
	}
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

async function createRule(env: Env, body: Record<string, unknown>): Promise<Response> {
	const pattern = String(body.pattern ?? '').trim();
	if (!pattern) throw new HttpError(400, 'pattern is required');
	if (!pattern.startsWith('/')) throw new HttpError(400, 'pattern must be an absolute path, for example /var/log/*.log');

	const hostId = body.hostId === null || body.hostId === undefined || body.hostId === '' ? null : slugify(String(body.hostId));
	if (hostId !== null && !(await getHost(env.DB, hostId))) throw new HttpError(400, `no host with id ${hostId}`);

	// One INSERT is one statement, so it needs no atomicity. A repeated pattern would add a duplicate
	// row — harmless for evaluation, but noise — so an identical existing rule is returned instead.
	const existing = await env.DB.prepare('SELECT * FROM source_rules WHERE pattern = ? AND is_exclude = ? AND host_id IS ?')
		.bind(pattern, body.isExclude === true ? 1 : 0, hostId)
		.first<SourceRuleRow>();
	if (existing) return json({ ok: true, id: existing.id, deduplicated: true });

	const result = await env.DB.prepare(
		'INSERT INTO source_rules (host_id, pattern, is_exclude, note, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
	)
		.bind(hostId, pattern, body.isExclude === true ? 1 : 0, body.note ? String(body.note) : null, nowIso())
		.run();

	return json({ ok: true, id: result.meta.last_row_id, deduplicated: false });
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		try {
			// --- authentication ---------------------------------------------------------------
			// Auth routes come first, and the guard below comes before anything that touches a stored
			// credential. The interface itself stays public so there is somewhere to sign in.
			if (path.startsWith('/api/auth/')) return await handleAuth(path, request, env);

			// Before any route that would touch a table, check the tables exist. Without this a missing
			// migration surfaces as a 500 whose body carries a stack trace and the failing SQL — internal
			// detail handed to an anonymous caller, saying nothing useful about what to do. An unapplied
			// migration is a configuration state, not a crash, and it is answered as one.
			//
			// `/api/status` and the schema bootstrap are exempt: the first is how the state is discovered, and
			// the second is how it is fixed.
			if (path.startsWith('/api/') && path !== '/api/status' && path !== '/api/admin/apply-schema') {
				const state = await schemaReady(env);
				if (!state.ready) {
					return json(
						{
							ok: false,
							error:
								'the database is missing tables this deployment needs, so nothing can be read or written yet. Apply the schema first.',
							missing: state.missing,
							hint: 'POST /api/admin/apply-schema',
						},
						503,
					);
				}
			}

			// The scheduler's entry point. It accepts the derived scheduler credential and NOT a session,
			// so the two are genuinely distinct: revoking one does not disable the other. Collection
			// itself arrives with ticket 08; this exists now because a credential nobody can present is
			// not evidence that the distinction works.
			// A share link is deliberately reachable without signing in: the recipient has no account and must
			// not need one. This is the one place where an unauthenticated request can obtain file bytes, and
			// what bounds it is that a token grants exactly one file and is checked here rather than at storage.
			if (path.startsWith(PUBLIC_SHARE_PREFIX)) {
				const token = decodeURIComponent(path.slice(PUBLIC_SHARE_PREFIX.length));
				if (!token) throw new HttpError(404, 'no share token given');
				return await serveShare(env, request, token, new URL(request.url).origin);
			}

			if (path === '/api/collect' && method === 'POST') {
				if (!(await isScheduler(env, request))) {
					throw new HttpError(401, 'this endpoint takes the scheduler credential');
				}
				return json({
					ok: true,
					accepted: true,
					collectionImplemented: false,
					note: 'the scheduler credential is recognised; running a collection arrives with ticket 08',
				});
			}

			if (path.startsWith('/api/') && !isPublicApi(path)) {
				if (!(await isSignedIn(env, request))) {
					// A single refusal for every protected route, whether or not the route exists. Saying
					// "not found" for an unknown one and "unauthorised" for a known one would let a stranger
					// map the API by probing it.
					throw new HttpError(401, 'sign in to use this');
				}
			}

			if (path === '/' && method === 'GET') {
				// The server picks the initial locale from Accept-Language so the first paint is already
				// in the reader's language; the client can then switch instantly without a reload.
				// `?lang=` overrides it, which is what makes a locale linkable.
				const requested = url.searchParams.get('lang');
				const locale = isLocale(requested) ? requested : pickLocale(request.headers.get('accept-language'));
				return new Response(renderIndexPage(locale), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Language' },
				});
			}

			/**
 * The answer to "is this deployment usable yet", reachable without signing in.
 *
 * Public because a fresh deployment has no tables and therefore nowhere to store a password, so the
 * interface must be able to report that state before anyone can authenticate. It deliberately exposes
 * nothing sensitive: whether a password is set, whether storage is bound, and which tables are
 * present. Routes that touch a stored credential are all behind the session check.
 */
if (path === '/api/status' && method === 'GET') {
				const schema = await schemaStatus(env).catch((err) => ({ ready: false, missing: [`error: ${(err as Error).message}`] }));
				// Host count is included because the ceiling is only useful if it is visible: an
				// operator who cannot see "49 of 50" discovers the limit by being refused.
				const hosts = await env.DB.prepare('SELECT COUNT(*) AS n FROM hosts')
					.first<{ n: number }>()
					.catch(() => null);
				return json({
					ok: true,
					worker: 'linkbin',
					schema,
					masterKeySet: Boolean(env.SSH_MASTER_KEY),
					r2Bound: Boolean(env.BUCKET),
					hosts: { count: Number(hosts?.n ?? 0), max: MAX_HOSTS },
					limits: { maxFileBytes: MAX_FILE_BYTES, storageBudgetBytes: STORAGE_BUDGET_BYTES },
				});
			}

			if (path === '/api/shares' && method === 'POST') {
				return await createShare(env, request, new URL(request.url).origin);
			}

			if (path === '/api/shares' && method === 'GET') {
				const { results } = await env.DB.prepare(
					`SELECT s.*, o.object_key, o.path, o.size_bytes, o.content_hash, o.host_id
					 FROM shares s
					 JOIN objects o ON o.id = s.object_id
					 ORDER BY s.created_at DESC`,
				).all<ShareJoinRow>();
				return json({ ok: true, shares: (results ?? []).map(operatorShareView) });
			}

			if (path === '/api/shares/revoke' && method === 'POST') {
				const body = (await request.json()) as { token?: string };
				const token = String(body.token ?? '');
				if (!token) throw new HttpError(400, 'token is required');

				// Revoking is a timestamp rather than a delete, so the recipient is told the link was cancelled
				// rather than being shown a missing one, and the operator's list keeps the history.
				const result = await env.DB.prepare('UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
					.bind(nowIso(), token)
					.run();
				if (!result.meta.changes) throw new HttpError(404, 'no active share with that token');
				return json({ ok: true, revoked: token });
			}

			if (path === '/api/runs' && method === 'GET') {
				// Bounded on purpose. A run list is read to answer "what happened lately", so it is the recent
				// ones; an unbounded read would grow until it stopped fitting in a response.
				const hostFilter = new URL(request.url).searchParams.get('host');
				const runs = await env.DB.prepare(
					`SELECT * FROM collection_runs ${hostFilter ? 'WHERE host_id = ?' : ''} ORDER BY started_at DESC LIMIT 50`,
				)
					.bind(...(hostFilter ? [hostFilter] : []))
					.all<RunRow>();

				// Issue counts are fetched once and joined in memory rather than as a subquery per run: D1 allows
				// 1000 queries per invocation, and a per-run count would spend one per run for a number that one
				// read provides.
				const ids = (runs.results ?? []).map((r) => r.id);
				let issues: IssueRow[] = [];
				if (ids.length) {
					const placeholders = ids.map(() => '?').join(',');
					const rows = await env.DB.prepare(`SELECT * FROM collection_issues WHERE run_id IN (${placeholders})`)
						.bind(...ids)
						.all<IssueRow>();
					issues = rows.results ?? [];
				}

				return json({ ok: true, runs: summarizeRuns(runs.results ?? [], issues) });
			}

			if (path === '/api/runs/detail' && method === 'GET') {
				const params = new URL(request.url).searchParams;
				const id = Number(params.get('id'));
				if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id must be the id of a run');

				const row = await env.DB.prepare('SELECT * FROM collection_runs WHERE id = ?').bind(id).first<RunRow>();
				if (!row) throw new HttpError(404, 'no run with that id');

				// Ordered by creation so an interrupted run's issues read in the order they happened.
				const issues = await env.DB.prepare('SELECT * FROM collection_issues WHERE run_id = ? ORDER BY created_at, id')
					.bind(id)
					.all<IssueRow>();

				return json({ ok: true, run: runDetail(row, issues.results ?? []) });
			}

			if (path === '/api/issues' && method === 'GET') {
				// How many issues one read returns. A cap rather than a page parameter: this exists to answer
				// "what is going wrong lately", and an operator reading thousands of rows is not doing that.
				const hostFilter = new URL(request.url).searchParams.get('host');
				const rows = hostFilter
					? await env.DB.prepare('SELECT * FROM collection_issues WHERE host_id = ? ORDER BY created_at DESC, id DESC LIMIT 200')
							.bind(hostFilter)
							.all<IssueRow>()
					: await env.DB
							.prepare('SELECT * FROM collection_issues ORDER BY created_at DESC, id DESC LIMIT 200')
							.all<IssueRow>();

				const issues = hostFilter
					? issuesForHost(rows.results ?? [], hostFilter)
					: (rows.results ?? []).map(toIssueDetail);

				return json({ ok: true, ...(hostFilter ? { hostId: hostFilter } : {}), issues });
			}

			if (path === '/api/objects' && method === 'GET') {
				const params = new URL(request.url).searchParams;
				const filter: BrowseFilter = {
					hostId: params.get('host') ?? undefined,
					pattern: params.get('pattern') ?? undefined,
					search: params.get('q') ?? undefined,
					includeSuperseded: params.get('history') === '1',
					sort: (params.get('sort') as BrowseSort) ?? undefined,
					limit: params.get('limit') ? Number(params.get('limit')) : undefined,
				};

				const query = buildObjectQuery(filter);
				const rows = await env.DB.prepare(query.sql).bind(...query.params).all<ObjectRow>();
				// The count is a second bounded query rather than a window function, which would repeat the total
				// on every row. The interface needs it to say "showing 50 of 214" rather than leaving a truncated
				// list looking like the whole answer.
				const total = await env.DB.prepare(query.countSql)
					.bind(...query.countParams)
					.first<{ n: number }>();

				return json({
					ok: true,
					objects: (rows.results ?? []).map(objectView),
					total: Number(total?.n ?? 0),
					limit: query.limit,
				});
			}

			if (path === '/api/objects/importance' && method === 'POST') {
				const body = (await request.json()) as { id?: number; important?: boolean };
				const id = Number(body.id);
				if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id must be the id of a stored file');

				const exists = await env.DB.prepare('SELECT id FROM objects WHERE id = ?').bind(id).first<{ id: number }>();
				if (!exists) throw new HttpError(404, 'no stored file with that id');

				if (body.important) {
					// `INSERT OR REPLACE` rather than an update: presence of the row IS the flag, so marking twice
					// is not an error and needs no read first.
					await env.DB.prepare('INSERT OR REPLACE INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)')
						.bind(id, nowIso())
						.run();
				} else {
					await env.DB.prepare('DELETE FROM object_flags WHERE object_id = ?').bind(id).run();
				}

				return json({ ok: true, id, important: body.important === true });
			}

			if (path === '/api/usage' && method === 'GET') {
				// The per-file limit travels with the totals: both are numbers the operator has to plan around,
				// and a limit that is only enforced is one they discover by having a file refused.
				return json({ ok: true, usage: { ...(await measureStorage(env.DB)), maxFileBytes: MAX_FILE_BYTES } });
			}

			// Generates a candidate master key. It cannot install the key itself — a secret is
			// deployment configuration, not runtime state — but it means the operator never has to
			// invent key material by hand.
			if (path === '/api/master-key' && method === 'GET') {
				let currentBytes = 0;
				if (env.SSH_MASTER_KEY) {
					try {
						currentBytes = atob(env.SSH_MASTER_KEY.trim()).length;
					} catch {
						currentBytes = -1;
					}
				}
				return json({
					generated: generateMasterKey(),
					currentKeyStatus:
						currentBytes === 0
							? 'not set'
							: currentBytes === 32
								? 'set and well formed (32 bytes)'
								: `set but INVALID: decodes to ${currentBytes} bytes, expected 32`,
					install: 'Set it as a Secret named SSH_MASTER_KEY, or: wrangler secret put SSH_MASTER_KEY',
					warning:
						'Generating a new key does NOT re-encrypt anything. Replacing SSH_MASTER_KEY makes every stored credential unreadable.',
				});
			}

			if (path === '/api/admin/apply-schema' && method === 'POST') {
				return await applySchema(env);
			}

			if (path === '/api/hosts' && method === 'GET') {
				const rows = await listHosts(env.DB);
				return json({ ok: true, hosts: await Promise.all(rows.map(publicHost)) });
			}

			if (path === '/api/hosts' && method === 'POST') {
				return await upsertHost(env, (await request.json()) as Record<string, unknown>);
			}

			if (path === '/api/hosts/delete' && method === 'POST') {
				const body = (await request.json()) as { id?: string };
				const id = slugify(String(body.id ?? ''));
				if (!id) throw new HttpError(400, 'id is required');
				await env.DB.prepare('DELETE FROM hosts WHERE id = ?').bind(id).run();
				return json({ ok: true, deleted: id });
			}

			if (path === '/api/hosts/test' && method === 'POST') {
				const body = (await request.json()) as { id?: string };
				const id = slugify(String(body.id ?? ''));
				if (!id) throw new HttpError(400, 'id is required');
				return await testHost(env, id);
			}

			if (path === '/api/rules' && method === 'GET') {
				const hostId = url.searchParams.get('hostId');
				const { results } = hostId
					? await env.DB.prepare('SELECT * FROM source_rules WHERE host_id IS NULL OR host_id = ? ORDER BY host_id, is_exclude, pattern')
							.bind(slugify(hostId))
							.all<SourceRuleRow>()
					: await env.DB.prepare('SELECT * FROM source_rules ORDER BY host_id, is_exclude, pattern').all<SourceRuleRow>();
				return json({ ok: true, rules: (results ?? []).map(publicRule) });
			}

			if (path === '/api/rules' && method === 'POST') {
				return await createRule(env, (await request.json()) as Record<string, unknown>);
			}

			if (path === '/api/rules/delete' && method === 'POST') {
				const body = (await request.json()) as { id?: number };
				if (typeof body.id !== 'number') throw new HttpError(400, 'numeric id is required');
				await env.DB.prepare('DELETE FROM source_rules WHERE id = ?').bind(body.id).run();
				return json({ ok: true, deleted: body.id });
			}

			// The /probe* routes were REMOVED here. They existed only to answer whether a Worker can
			// read a file over SSH, that verdict is recorded (PASS, see STATE.md D36), and they were an
			// unauthenticated remote-command and arbitrary-file-read surface: with no PROBE_* set they
			// fell back to the first stored host carrying a credential, so adding any host would have
			// re-created a live exposure for anyone who could reach the Worker (D41). Do not reintroduce
			// them; a diagnostic that needs a host credential belongs behind the auth gap in D35.

			return json({ error: 'not found', path, routes: ['/', '/api/status', '/api/hosts', '/api/rules', '/api/usage', '/api/admin/apply-schema'] }, 404);
		} catch (err) {
			const e = err as Error;
			const status = e instanceof HttpError ? e.status : 500;
			// Errors reach the operator, but never carry decrypted material: messages that could are
			// built only from the host id and the field name. The stack is included because this
			// Worker is deployed with no type checking in the build, so a shape mistake in a
			// dependency call surfaces only here — and a stack turns that from guesswork into a line
			// number. (This is exactly how a bare-string `algorithms.cipher` was found.)
			return json({ ok: false, error: e.message, name: e.name, status, stack: e.stack }, status);
		}
	},
} satisfies ExportedHandler<Env>;
