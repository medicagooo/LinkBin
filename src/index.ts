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
 * Collection, sharing, scheduling and declarative merges are wired below. Physical-byte accounting,
 * writer leases and recoverable version publication live in `storage.ts`; collection uses `collect.ts`
 * and `collect-store.ts`. Remote SSH/throughput verification remains a separate operational step.
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
import { MAX_FILE_BYTES, STORAGE_BUDGET_BYTES, measureStorage, checkFileBudget, reclaimFor, reclaimVersion, publishVersion, withStorageWriter } from './storage';
import { collectFrom } from './collect';
import { closeRun, collectionPorts, cursorFor, openRun } from './collect-store';
import { abandonStaleSessions } from './multipart';
import { buildObjectQuery, type BrowseFilter, type BrowseSort, type ObjectRow } from './browse';
import { issuesForHost, runDetail, summarizeRuns, toIssueDetail, type IssueRow, type RunRow } from './receipts';
import { downloadFile, FileProblem, manageFiles, serveDirectLink } from './files';
import { readSharePassword, sharePasswordPage } from './share-page';
import { parseCursor, planRun, freshness } from './schedule';
import {
	mergeSignature,
	parseStoredRule,
	planMergeSources,
	previewDerived,
	ruleDefinitionProblem,
	runDerived,
	specMatches,
	type DerivedRuleDefinition,
	type DerivedRunOutcome,
	type MergeSourceSpec,
	type StoredObject,
} from './derived';
import type { MergeRule, MergeRuleRef } from './merge';
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
	PBKDF2_ITERATIONS,
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

/**
 * How long one collection invocation may spend before it must leave.
 *
 * **A conservative default, not a measured figure.** The platform's per-invocation ceiling is far higher,
 * and the run stops well below it because the time after stopping is what writing a resume cursor costs.
 * The number to use is a consequence of the throughput measurement (ticket 04), which has not run: until it
 * has, a value that is safely too small is the right one, because a run that stops early resumes whereas one
 * that is killed mid-write leaves a half-recorded file.
 */
const DEFAULT_RUN_BUDGET_MS = 5 * 60 * 1000;

/**
 * The freshness the schedule is meant to achieve, so "is it keeping up" has something to compare against.
 *
 * **25 minutes is the midpoint of the spec's 15–30 minute target**, and the first value written here was 40 —
 * which was not from the spec at all but from my own earlier paraphrase of it as "a few tens of minutes". The
 * difference matters because this figure is what the interface compares the worst machine against: at 40, a
 * machine 35 minutes stale would be reported as healthy while the spec calls it late. Reading the requirement
 * rather than the summary of it is what corrected it.
 *
 * It is a figure rather than prose because `freshness` reports the WORST staleness across machines, and a worst
 * case is only meaningful next to a target — "worst is 3000 seconds" answers nothing on its own.
 */
const FRESHNESS_TARGET_MS = 25 * 60 * 1000;

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

/**
 * A stored cursor position as an offset, or 0 when it cannot be trusted.
 *
 * Strict on purpose. The value comes from a JSON document this project wrote, but it has crossed a database and a
 * release boundary, and the two ways of being wrong are not symmetric: resuming from 0 re-reads files and stores
 * nothing, because the content hash decides, while resuming from a value that is too HIGH skips files that were
 * never read and loses them silently.
 *
 * So a value that is not an exact non-negative integer is refused rather than rounded. `Math.trunc("1.5")` is `1`,
 * which looks usable and drops a file; `parseInt("12abc")` is `12`, which does the same for a corrupt string.
 */
export function cursorPosition(stored: string | null | undefined): number {
	if (stored === null || stored === undefined) return 0;
	if (!/^\d+$/.test(stored)) return 0;
	const value = Number(stored);
	return Number.isSafeInteger(value) ? value : 0;
}

const SESSION_COOKIE = 'linkbin_session';

/**
 * The origin a scheduled invocation addresses itself to.
 *
 * Never resolved by DNS: the request is handed straight to `this.fetch`, so no network call and no loopback are
 * involved, and the host is arbitrary. It is a full URL only because a Request needs one, and a fixed value
 * keeps scheduled logs comparable between runs.
 */
const APP_ORIGIN = 'https://linkbin.internal';

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

/**
 * The key session tokens are signed with.
 *
 * It refuses when the deployment has no master key rather than substituting a stand-in, and that change came
 * from an adversarial audit. The stand-in was a constant published in this repository, so a deployment that
 * had somehow lost its secret would not merely fail — it would accept a session minted by **anyone who read
 * the source**, and the share routes would then be openable by a stranger. Failing closed turns a silent
 * catastrophe into a visible misconfiguration.
 *
 * The message names the fix rather than the symptom, because the person reading it is the operator.
 */
function signingKey(env: Env): string {
	if (!env.SSH_MASTER_KEY) {
		throw new HttpError(
			503,
			'this deployment has no SSH_MASTER_KEY set, so sessions cannot be signed and nothing can be authenticated. Set it as a Worker secret.',
		);
	}
	return env.SSH_MASTER_KEY;
}

interface AuthRow {
	salt: string;
	hash: string;
	iterations: number;
	changed_at: string;
	sessions_revoked_at: string;
}

/**
 * The operator's password row, or null when there is not one yet.
 *
 * Returns null when the TABLE is absent as well, and that is the point. `handleAuth` reads this before it
 * looks at which auth route was asked for, so on a deployment whose schema is unapplied the driver's message
 * — `no such table: auth_secret` — reached the response body before any route could decline politely. An
 * adversarial audit caught it on `/api/auth/setup`, the one route deliberately reachable with no tables.
 *
 * Returning null here makes the absence indistinguishable from "no password set yet", which is correct for
 * every route that only READS this row: they answer "no password is set" rather than leaking a driver error.
 * The setup route, which writes, detects the missing table itself and says what to do about it.
 */
async function authRow(env: Env): Promise<AuthRow | null> {
	try {
		return await env.DB.prepare('SELECT salt, hash, iterations, changed_at, sessions_revoked_at FROM auth_secret WHERE id = 1').first<AuthRow>();
	} catch {
		return null;
	}
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

/**
 * Failed attempts from EVERYONE within the window.
 *
 * The backstop behind the per-caller limit, and it cannot be escaped by changing identity. See
 * MAX_GLOBAL_ATTEMPTS: the per-caller limit alone lets an attacker through when the platform supplies no
 * caller address, or when they can vary it.
 */
async function recentFailuresAnywhere(env: Env): Promise<number> {
	const { windowSeconds } = attemptLimits();
	const since = new Date((Math.floor(Date.now() / 1000) - windowSeconds) * 1000).toISOString();
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE succeeded = 0 AND at >= ?')
		.bind(since)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** Whether either limit has been reached, and which one, so the refusal can say something useful. */
async function refusalFor(env: Env, remote: string): Promise<string | null> {
	const { max, maxGlobal } = attemptLimits();
	if ((await recentFailuresAnywhere(env)) >= maxGlobal) {
		return 'too many failed attempts from anyone in the last few minutes; wait and try again';
	}
	if ((await recentFailures(env, remote)) >= max) {
		return 'too many failed attempts; wait a few minutes and try again';
	}
	return null;
}

/**
 * The caller's address, as far as this deployment can tell.
 *
 * **Only the Cloudflare-set header is trusted.** An adversarial audit showed the previous version falling back
 * to `x-forwarded-for`, which Cloudflare documents as *client-supplied* and appended to rather than replaced —
 * so the rate-limit bucket key was chosen by the caller, and rotating one character in a header reset the
 * count. A rate limit an attacker can reset is not a rate limit.
 *
 * When Cloudflare has not set the header the caller is unknown, and that is recorded as such. The global
 * ceiling above is what protects that case, rather than pooling every unknown caller into the per-caller
 * bucket — which itself locked the operator out.
 */
function callerAddress(request: Request): string {
	return request.headers.get('cf-connecting-ip') ?? 'unknown-caller';
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

		// The insert is the FIRST statement that needs the table to exist, and it is attempted here rather than
		// guarded earlier so that the refusal names the actual remedy. A deployment whose schema is unapplied
		// reaches this route by design — it is exempt from the schema guard so a first visitor can bootstrap —
		// and used to answer with a raw `no such table: auth_secret` from the driver. An adversarial audit
		// proved it, along with the second case below.
		try {
			await env.DB.prepare(
				'INSERT INTO auth_secret (id, salt, hash, iterations, changed_at, sessions_revoked_at, created_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
			)
				.bind(salt, hash, PBKDF2_ITERATIONS, now, now, now)
				.run();
		} catch (err) {
			const message = (err as Error).message ?? '';
			if (/no such table/i.test(message)) {
				throw new HttpError(503, 'the database has no tables yet, so there is nowhere to store a password. Apply the schema first.');
			}
			// Two setups racing: both read "no password yet", and the primary key refuses the loser. That is a
			// clean conflict rather than a fault — the winner's password stands and the loser was simply too
			// late — so it answers as one instead of surfacing a constraint error as a 500.
			if (/UNIQUE constraint failed/i.test(message)) {
				throw new HttpError(409, 'a password was set by another request a moment ago; sign in with it instead');
			}
			throw err;
		}

		return json({ ok: true, configured: true });
	}

	if (path === '/api/auth/login' && request.method === 'POST') {
		if (!row) throw new HttpError(409, 'no password is set yet');

		const remote = callerAddress(request);
		const refusal = await refusalFor(env, remote);
		if (refusal) throw new HttpError(429, refusal);

		const body = (await request.json()) as { password?: string };
		const candidate = String(body.password ?? '');
		const hash = await hashPassword(candidate, row.salt, Number(row.iterations));
		const ok = timingSafeEqual(hash, row.hash);

		// Checked again after the work, because a caller who has just crossed the ceiling should still be
		// recorded — and because the pre-check cannot know how many others have failed meanwhile.
		if (!ok) {
			await recordAttempt(env, false, remote);
			const late = await refusalFor(env, remote);
			if (late) throw new HttpError(429, late);
			throw new HttpError(401, 'that password is not correct');
		}

		await recordAttempt(env, true, remote);

		const token = await signSession(signingKey(env), Date.now(), newNonce());
		return json({ ok: true, expiresInSeconds: sessionMaxAgeSeconds() }, 200, {
			'set-cookie': sessionCookieHeader(token, sessionMaxAgeSeconds()),
		});
	}

	// Sign-out is server-enforced: the floor moves past this token, so it stops working immediately
	// rather than only being forgotten by whatever was holding it.
	//
	// **It now requires the session it is ending**, and that is a fix from an adversarial audit rather than a
	// nicety. The floor is a single global value, so an unauthenticated caller could move it and end the
	// operator's session — repeatably, with no credential and no limit. Anyone who could reach the Worker
	// could therefore keep the only account permanently signed out. The project had already learned this shape
	// once, in the rate limiter: a global switch a stranger can move is a denial of service against the single
	// operator. Someone with no session has nothing to sign out of, so refusing is also the honest answer.
	if (path === '/api/auth/logout' && request.method === 'POST') {
		if (!row) throw new HttpError(409, 'no password is set yet');
		if (!(await isSignedIn(env, request))) throw new HttpError(401, 'sign in first');
		await env.DB.prepare('UPDATE auth_secret SET sessions_revoked_at = ? WHERE id = 1').bind(nowIso()).run();
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
			.bind(salt, hash, PBKDF2_ITERATIONS, now, now)
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
				`SELECT s.*, o.object_key, o.path, o.size_bytes, o.content_hash, o.host_id, o.deleted_at, o.superseded_by
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

/**
 * The name a recipient sees for the file.
 *
 * Trailing separators are stripped **before** splitting, and that order is a fix from an adversarial audit.
 * A stored path ending in a separator — `/srv/private/dumps/` — splits to an empty last segment, so the
 * fallback handed the recipient the **entire source path**, which is exactly the directory layout the share
 * view exists to withhold.
 */
function filenameOf(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	if (!trimmed) return 'download';
	const last = trimmed.split('/').pop();
	return last && last.length > 0 ? last : 'download';
}

/** What the recipient is told before any bytes move. Never includes the object key or the machine. */
function publicShareView(row: ShareJoinRow): Record<string, unknown> {
	return {
		token: row.token,
		// The file name, never the source path: the recipient has no business learning the directory layout of
		// a machine they were not given access to.
		filename: filenameOf(row.path),
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
/**
 * One stored file, as the interface needs it.
 *
 * `verified` is the answer to "are the bytes still in the bucket", and it is optional because it costs a
 * storage lookup. `undefined` therefore means "not asked", which is a third state and not the same as `false`:
 * rendering an unchecked file as "gone" would be a lie about a file that is present.
 */
function objectView(row: ObjectRow, verified?: boolean): Record<string, unknown> {
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
		// Set only when the caller asked for verification: whether the row's bytes are actually in the bucket.
		// `undefined` means "not checked", which is different from `false` and must not be rendered as "gone".
		...(verified === undefined ? {} : { bytesPresent: verified }),
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
	if (!['GET', 'HEAD', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, POST' } });
	const row = await shareByToken(env.DB, token);
    if (row && ((row as any).deleted_at || (row as any).superseded_by)) return json({ ok: false, error: 'this file is no longer stored' }, 410);
	if (!row) {
		// The same shape as an expired or cancelled link, so a wrong token cannot be distinguished from a
		// dead one by probing.
		return json({ ok: false, error: 'this link is not valid', reason: 'unknown' }, 404);
	}

	// A password may arrive as a query parameter or an explicit header. The header is preferred so the
	// password does not end up in a URL that gets logged or shared; the query form exists because a plain
	// browser download cannot set a header.
	const supplied = request.method === 'POST' ? await readSharePassword(request)
    : request.headers.get('x-share-password') ?? new URL(request.url).searchParams.get('password');
  const browser = request.headers.get('accept')?.includes('text/html') || request.method === 'POST';

	// Guessing is limited on this path too, and the absence of that was an adversarial finding: the route
	// verifies with a 100,000-iteration PBKDF2 — the runtime ceiling, see `PBKDF2_ITERATIONS` — and had no counter,
	// no delay and no lockout, while the share
	// password may be short and a live token is distinguishable from an unknown one. A link is meant to be
	// handed to somebody, so the password is the only thing between a misdirected link and the file.
	//
	// Counted per caller, so one recipient mistyping does not refuse another — and the ceiling is shared, so
	// rotating addresses does not buy unlimited guesses.
	const remote = callerAddress(request);
	const refusal = await refusalFor(env, remote);
	if (refusal) throw new HttpError(429, refusal);

	const decision = await describeShare(row, supplied);
	if (!decision.usable) {
		// A wrong password is a failed attempt; a missing one is not, because nothing was guessed.
		if (decision.reason === 'password_incorrect') {
			await recordAttempt(env, false, remote);
			const late = await refusalFor(env, remote);
			if (late) throw new HttpError(429, late);
		}

		// `needsPassword` is not a failure — the recipient is being asked for one thing, not told no — so it
		// is answered with the metadata they need to decide, and no content.
		const status = decision.needsPassword ? 401 : 410;
    if (decision.needsPassword && browser && request.method !== 'HEAD') {
      return sharePasswordPage(token, filenameOf(row.path), decision.reason === 'password_incorrect');
    }
		return json({ ok: false, error: decision.message, reason: decision.reason, file: publicShareView(row) }, status);
	}

	const download = await downloadFile(env.BUCKET, row.object_key, row.path, request.method === 'HEAD');
  if (!download.ok) return download;

	// Bookkeeping only: a lost update here costs a count, not correctness, so it needs no atomicity.
	if (request.method !== 'HEAD') await env.DB.prepare('UPDATE shares SET use_count = use_count + 1, last_used_at = ? WHERE token = ?')
		.bind(new Date().toISOString(), row.token)
		.run();

	return download;
}

// ---------------------------------------------------------------------------------------------
// Storage budget
// ---------------------------------------------------------------------------------------------

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
		const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM hosts WHERE id NOT IN ('@derived', '@uploads')").first<{ n: number }>();
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
	/**
	 * The trigger that makes collection happen without anyone asking.
	 *
	 * Without this, the feature only ever runs when an operator presses a button, which is not what it is for: the
	 * point of collecting on a schedule is that nobody has to remember. `triggers.crons` in `wrangler.jsonc`
	 * schedules this; the criterion it satisfies is "collection runs on a schedule without any human action".
	 *
	 * IT CALLS THE SAME ROUTE THE INTERFACE CALLS, rather than reimplementing the work. A second entry point that
	 * walks machines itself would be a second place for the rotation, the budget, the cursor and the run record to
	 * drift out of agreement — and the two would differ precisely in the unattended case, which is the one nobody
	 * is watching. The credential presented is the scheduler's own token, derived from the master key, so the route
	 * sees a genuine scheduler call and not a privileged bypass.
	 *
	 * A FAILURE IS LOGGED AND SWALLOWED, deliberately. A cron trigger has no caller to answer, so throwing would
	 * only produce a retry of work the route has already recorded as an issue — and the route already answers 200
	 * with `run: false` when there is nothing to do, which is not an error. What must NOT happen is a scheduled
	 * invocation dying silently, so the outcome is written to the log either way.
	 */
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		const started = Date.now();

		try {
			// `signingKey` refuses when no master key is configured, and that must not be swallowed here: a
			// deployment with no secret cannot authenticate anything, and a scheduled run that quietly did nothing
			// would look identical to one that found nothing to collect.
			const token = await scheduleToken(signingKey(env));
			const request = new Request(`${APP_ORIGIN}/api/collect`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			});

			const response = await this.fetch(request, env);
			const body = await response.text();

			console.log(
				JSON.stringify({
					at: 'scheduled',
					cron: controller.cron,
					status: response.status,
					ms: Date.now() - started,
					// Truncated rather than logged whole: the response carries counts, not payloads, and an
					// unbounded log line is a cost with no benefit.
					body: body.length > 600 ? `${body.slice(0, 600)}…` : body,
				}),
			);
		} catch (err) {
			console.log(
				JSON.stringify({
					at: 'scheduled-failed',
					cron: controller.cron,
					ms: Date.now() - started,
					message: (err as Error).message,
				}),
			);
		}
	},

	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		try {
			// --- schema, before anything reads a table -----------------------------------------
			// This comes FIRST, ahead of the auth routes, and the ordering is a fix rather than a preference.
			//
			// The guard was originally placed after `/api/auth/*`, reasoning that those routes must be reachable
			// so a first visitor can set a password. That left them unguarded, and the defect was found by
			// auditing the live deployment: `/api/auth/state` — a route EVERY first visitor hits — returned 500
			// with a stack trace and the failing SQL, because it reads `auth_secret` and the table did not exist.
			//
			// The exemption is the narrow one the bootstrap genuinely needs: setup must work on an empty
			// database, because that is how the tables get created. Everything else in the auth group reads a
			// table and is refused cleanly instead.
			//
			// `/api/status` is exempt because it is how the state is discovered, and apply-schema because it is
			// how it is fixed.
			if (
				path.startsWith('/api/') &&
				path !== '/api/status' &&
				path !== '/api/admin/apply-schema' &&
				path !== '/api/auth/setup'
			) {
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

			// --- authentication ---------------------------------------------------------------
			// The interface itself stays public so there is somewhere to sign in.
			if (path.startsWith('/api/auth/')) return await handleAuth(path, request, env);

			// The scheduler's entry point. It accepts the derived scheduler credential and NOT a session,
			// so the two are genuinely distinct: revoking one does not disable the other. Collection
			// itself arrives with ticket 08; this exists now because a credential nobody can present is
			// not evidence that the distinction works.
			// A share link is deliberately reachable without signing in: the recipient has no account and must
			// not need one. This is the one place where an unauthenticated request can obtain file bytes, and
			// what bounds it is that a token grants exactly one file and is checked here rather than at storage.
      if (path.startsWith('/d/')) {
        const token = path.slice(3);
        if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return json({ ok: false, error: 'this link is not valid' }, 404);
        return await serveDirectLink(env, request, token);
      }
			if (path.startsWith(PUBLIC_SHARE_PREFIX)) {
				// A token that does not survive decoding is treated as a wrong token rather than as a fault.
				// `decodeURIComponent` throws on a malformed escape — `/s/%` reached the error handler and
				// produced a 500 — and a malformed token is exactly what a wrong token is. The audit found
				// this; the giveaway was a crash on input that a recipient could type by accident.
				let token: string;
				try {
					token = decodeURIComponent(path.slice(PUBLIC_SHARE_PREFIX.length));
				} catch {
					token = '';
				}
				if (!token) return json({ ok: false, error: 'this link is not valid', reason: 'unknown' }, 404);
				return await serveShare(env, request, token, new URL(request.url).origin);
			}

			if (path === '/api/collect' && method === 'POST') {
				// Two ways in, and they are deliberately different credentials. The scheduler has no session and
				// presents a derived token; the operator has a session and asks from the interface. Accepting
				// either here is not a weakening of the distinction — that distinction is about which credential
				// works on the MANAGEMENT API, where the scheduler token is still refused.
				const byScheduler = await isScheduler(env, request);
				if (!byScheduler && !(await isSignedIn(env, request))) {
					throw new HttpError(401, 'this endpoint takes the scheduler credential or a signed-in operator');
				}

				// The decision layer decides which machine runs and from where. What it cannot yet do is the
				// collection itself, which needs a machine; saying so is better than reporting a run that never
				// happened.
				// `last_completed_at`, not `last_succeeded_at`, and the distinction is not pedantic. A run that
				// finishes with files it could not handle HAS completed: the machine was reached and scanned.
				// Counting only runs with zero failures would report a machine whose runs each had one
				// problematic file as "never collected" — false, and it would send someone to investigate a
				// connection that is working. Failures are reported through the run's own counts, which is where
				// a reader looks for them.
				const machines = await env.DB.prepare(
					`SELECT h.id AS id,
					        h.enabled AS enabled,
					        MAX(r.started_at) AS last_started_at,
					        MAX(CASE WHEN r.state = 'finished' THEN r.finished_at END) AS last_completed_at
					 FROM hosts h
					 LEFT JOIN collection_runs r ON r.host_id = h.id
					 GROUP BY h.id`,
				).all<{ id: string; enabled: number; last_started_at: string | null; last_completed_at: string | null }>();

				const now = Date.now();
				const startedAt = now;
				let plan = planRun({
					machines: (machines.results ?? []).map((m) => ({
						id: m.id,
						enabled: Number(m.enabled) === 1,
						lastStartedAt: m.last_started_at,
						lastSucceededAt: m.last_completed_at,
						lastOutcome: null,
					})),
					cursor: null,
					now,
					startedAt,
					// The wall-clock budget. The platform ceiling is far above this; the figure itself is a
					// constant to be set from the throughput measurement, which has not run, so it is the
					// conservative default the schedule module documents rather than a measured value.
					budgetMs: DEFAULT_RUN_BUDGET_MS,
				});

				// Nothing to run: say so rather than opening a connection to record nothing. This is the answer the
				// route gave for everything until now, and it is still the right answer when the schedule declines —
				// but `collectionImplemented` is now TRUE, because collection exists and this particular request
				// simply had nothing to do. Leaving it false would tell a caller that the code cannot collect,
				// which stopped being true, and `run: false` already says this request did nothing.
				if (!plan.run || !plan.machineId) {
					return json({
						ok: true,
						accepted: true,
						by: byScheduler ? 'scheduler' : 'operator',
						run: false,
						reason: plan.reason ?? null,
						notes: plan.notes,
						// The distinction matters for the same reason it did before: `run: false` means nothing was
						// collected, and a caller must not believe a machine was updated.
						machineId: plan.machineId ?? null,
						resumeFrom: plan.resumeFrom ?? null,
						collectionImplemented: true,
					});
				}

                // Rotation chooses a host first; resume reads its latest run, including deliberate stops.
                const latest = await env.DB.prepare('SELECT state, cursor_json FROM collection_runs WHERE host_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
                    .bind(plan.machineId).first<{ state: string; cursor_json: string | null }>();
                if (latest && latest.state !== 'finished') {
                    const cursor = parseCursor(latest.cursor_json);
                    if (cursor?.hostId === plan.machineId) plan.resumeFrom = cursor.position;
                    else if (latest.cursor_json) plan.notes.push('the stored cursor is unreadable or belongs to another machine; starting from the beginning');
                } else if (!latest) {
                    const foreign = await env.DB.prepare("SELECT id FROM collection_runs WHERE host_id != ? AND state IN ('running', 'stopped') AND cursor_json IS NOT NULL LIMIT 1").bind(plan.machineId).first();
                    if (foreign) plan.notes.push('another machine has a stored cursor; this machine starts from the beginning');
                }
				const hostRow = await getHost(env.DB, plan.machineId);
				if (!hostRow) throw new HttpError(409, 'the chosen machine is no longer stored');

				if (hostRow.enabled !== 1) throw new HttpError(409, 'the chosen machine is disabled');

				// BEFORE the run, not after it. The only uploads that can still be live belong to an invocation that
				// has already ended, because a run for this machine is not concurrent with itself — so this is the
				// one moment at which "abandoned" is certain rather than a guess. Doing it here also means a file
				// that keeps failing cannot accumulate parts run after run, which is a slow leak: each attempt adds
				// parts, none are released, and the store fills with uploads nothing will ever complete.
				const cleaned = await abandonStaleSessions(env.DB, env.BUCKET, hostRow.id);

				// THE RUN ROW IS OPENED BEFORE ANYTHING ELSE HAPPENS, so an invocation killed mid-collection leaves
				// a run that is visibly unfinished rather than no run at all. Everything after this point either
				// closes it or leaves it `running` for the next invocation to see.
				const runId = await openRun(env.DB, hostRow.id, plan.resumeFrom ? cursorFor(hostRow.id, cursorPosition(plan.resumeFrom), new Date(startedAt).toISOString()) : null);

				const deadline = Date.now() + DEFAULT_RUN_BUDGET_MS;
				const api = collectionPorts(env, hostRow.id, runId, { deadline });

				// The substituted remote is a TEST-ONLY binding. Production never sets it, so the SSH path below is
				// the only one a deployment can take — and this is what makes the whole pipeline exercisable
				// through the HTTP edge with no machine, which is how ticket 05 is verified.
				let remote: RemoteHost | null = env.TEST_REMOTE ?? null;
				let close = async (): Promise<void> => {};

				if (!remote) {
					try {
						const options = await connectOptionsFor(env, hostRow);
						const connected = await connectRemote(options);
						remote = connected.remote;
						close = connected.close;
					} catch (err) {
						// A machine that cannot be reached is RECORDED and the run is closed, rather than throwing:
						// an unreachable machine must not abort anything else, and the reason belongs in the
						// receipt where the operator will look for it.
						await api.recordIssue({ path: null, kind: 'unreachable', reason: `could not reach ${hostRow.id}: ${(err as Error).message}`, size: null });
						const refused = { stored: 0, skipped: 0, failed: 1, unchanged: 0, bytesStored: 0 };
						await closeRun(env.DB, runId, 'finished', refused, null);
						// `run: true` even though nothing was collected, because a run WAS started and recorded — the
						// field answers "did the schedule pick a machine", not "did it succeed". `connected: false`
						// and the error carry the rest, and every field a caller might read is present so the
						// response has one shape rather than three.
						return json({
							ok: true,
							accepted: true,
							by: byScheduler ? 'scheduler' : 'operator',
							run: true,
							runId,
							machineId: hostRow.id,
							resumeFrom: plan.resumeFrom ?? null,
							connected: false,
							stoppedEarly: false,
							// The plan's notes are carried even on this path, and that is a fix rather than tidiness:
							// they include the explanation of what happened to a stored cursor — "the cursor belongs
							// to another machine, so this one starts from the beginning". Dropping them here made an
							// ignored cursor indistinguishable from a cursor that was never written, which is the
							// exact confusion the note exists to prevent.
							notes: plan.notes,
							totals: refused,
							collectionImplemented: true,
							error: (err as Error).message,
						}, 200);
					}
				}

				let totals = { stored: 0, skipped: 0, failed: 0, unchanged: 0, bytesStored: 0 };
				let outcomes: { path: string }[] = [];
				let stoppedEarly = false;

				try {
					const rules = await rulesForHost(env.DB, hostRow.id);
					const result = await collectFrom(remote, {
						rules,
						canStore: api.canStore,
						store: api.store,
						recordIssue: api.recordIssue,
						recordProgress: api.recordProgress,
						deadline,
						// THE CURSOR IS FED BACK IN, which is what makes it a resume point rather than a receipt. The
						// value is the file count a previous run reached; the walk skips that many and continues.
						//
						// ONLY AN EXACT NON-NEGATIVE INTEGER RESUMES. Anything else reads as "start from the
						// beginning", the direction whose worst case is re-reading rather than losing a file — and
						// that distinction is why this does not truncate: `Math.trunc("1.5")` is `1`, which SKIPS a
						// file that was never read. The two failures are not symmetric, so a doubtful value must not
						// be rounded into a usable-looking one.
						resumeFrom: cursorPosition(plan.resumeFrom),
					});
					totals = result.totals;
					outcomes = result.outcomes;
					stoppedEarly = result.stoppedEarly;

					// `stopped` rather than `finished` when the budget ran out: marking it finished would claim a
					// scan that did not happen, and the next run would not resume from the cursor.
					await closeRun(env.DB, runId, stoppedEarly ? 'stopped' : 'finished', totals, stoppedEarly ? cursorFor(hostRow.id, result.resumed, new Date(startedAt).toISOString()) : null);
				} catch (err) {
					// The run row is deliberately LEFT as `running`. The next invocation reads it as an unfinished
					// run and its cursor, which is exactly what it is — and closing it as `finished` here would
					// hide a failure that nobody has been told about yet.
					await api.recordIssue({ path: null, kind: 'run_failed', reason: (err as Error).message || 'the run did not finish', size: null });
					return json({ ok: false, accepted: true, run: true, runId, machineId: hostRow.id, totals, error: (err as Error).message }, 500);
				} finally {
					await close();
				}

				return json({
					ok: true,
					accepted: true,
					by: byScheduler ? 'scheduler' : 'operator',
					run: true,
					runId,
					machineId: hostRow.id,
					resumeFrom: plan.resumeFrom ?? null,
					stoppedEarly,
					totals,
					// The plan's notes are carried here for the same reason they are carried on the unreachable path:
					// they include the explanation of what happened to a stored cursor — "the cursor belongs to
					// another machine, so this one starts from the beginning". Without them an ignored cursor is
					// indistinguishable from one that was never written, on the path where the operator is most
					// likely to be looking.
					notes: plan.notes,
					// Reported so an operator can see that quota was released on their behalf, and so a cleanup that
					// could NOT release something is visible rather than silent.
					reclaimedSessions: cleaned.abandoned.length,
					unreleasedSessions: cleaned.failed.length,
					// The files themselves are not returned: this is a receipt, and a machine with a large directory
					// would make the response unbounded. The interface reads them from the run detail.
					collectionImplemented: true,
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

      // Upload publication releases its writer lease before dependent merges acquire theirs.
      if (path.startsWith('/api/files/') || path.startsWith('/api/file-links')) {
        const response = await manageFiles(env, request);
        if (response) {
          return response;
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
				const hosts = await env.DB.prepare("SELECT COUNT(*) AS n FROM hosts WHERE id NOT IN ('@derived', '@uploads')")
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
				// Bounded like every other listing. An adversarial audit found this one unbounded: nothing caps how
				// many shares can be created, so the response grew with use until it stopped fitting.
				const { results } = await env.DB.prepare(
					`SELECT s.*, o.object_key, o.path, o.size_bytes, o.content_hash, o.host_id
					 FROM shares s
					 JOIN objects o ON o.id = s.object_id
					 ORDER BY s.created_at DESC LIMIT 200`,
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

				// Ordered by creation so an interrupted run's issues read in the order they happened, and bounded
				// for the same reason `/api/issues` is: one run can produce an issue per file it could not handle,
				// so this grew with the machine's contents until it stopped fitting in a response.
				const issues = await env.DB.prepare(
					'SELECT * FROM collection_issues WHERE run_id = ? ORDER BY created_at, id LIMIT 200',
				)
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
					offset: params.get('offset') ? Number(params.get('offset')) : undefined,
				};

				const query = buildObjectQuery(filter);
				const rows = await env.DB.prepare(query.sql).bind(...query.params).all<ObjectRow>();
				// The count is a second bounded query rather than a window function, which would repeat the total
				// on every row. The interface needs it to say "showing 50 of 214" rather than leaving a truncated
				// list looking like the whole answer.
				const total = await env.DB.prepare(query.countSql)
					.bind(...query.countParams)
					.first<{ n: number }>();

				// `?verify=1` asks whether each row's bytes are actually still in the bucket, and the answer is what
				// lets the interface say "no longer available" instead of offering a download that cannot happen.
				//
				// The database row and the stored bytes can disagree: eviction reclaims bytes while deliberately
				// keeping the row, because the row is what makes "this file existed and was removed to make room"
				// answerable. Without this check the list would show evicted files as downloadable, and a click
				// would produce a 404 from the download route — a worse answer than saying so up front.
				//
				// Opt-in rather than always, because it costs one storage lookup per row: the ordinary listing does
				// not need it, and making every browse pay for it would slow the page for a state most rows are not
				// in. Bounded by the page size, which is already capped.
				const verify = params.get('verify') === '1';
				const objects = (rows.results ?? []).map((row) => objectView(row, verify ? false : undefined));

				if (verify) {
					// Filled in after the fact rather than inside the map, so the lookups can run together instead of
					// one after another: a page of 50 files would otherwise be 50 sequential round trips.
					const heads = await Promise.all((rows.results ?? []).map((row) => env.BUCKET.head(row.object_key)));
					heads.forEach((head, index) => {
						objects[index].bytesPresent = head !== null;
					});
				}

				return json({
					ok: true,
					objects,
					total: Number(total?.n ?? 0),
					limit: query.limit,
					// Echoed so the interface can ask for the next page without tracking it, and so a caller can
					// tell a clamped request from one that was honoured.
					offset: query.offset,
					// Said out loud, because "nothing matched" and "your search was too long to evaluate" look
					// identical in an empty list and lead to opposite next steps.
					termTooLong: query.termTooLong,
				});
			}

			if (path === '/api/objects/importance' && method === 'POST') {
				const body = (await request.json()) as { id?: number; important?: boolean };
				const id = Number(body.id);
				if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id must be the id of a stored file');

				const exists = await env.DB.prepare('SELECT id FROM objects WHERE id = ?').bind(id).first<{ id: number }>();
				if (!exists) throw new HttpError(404, 'no stored file with that id');

                await withStorageWriter(env, async () => {
                    if (body.important) await env.DB.prepare('INSERT OR REPLACE INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)').bind(id, nowIso()).run();
                    else await env.DB.prepare('DELETE FROM object_flags WHERE object_id = ?').bind(id).run();
                });

				return json({ ok: true, id, important: body.important === true });
			}

			if (path === '/api/usage' && method === 'GET') {
				// The per-file limit travels with the totals: both are numbers the operator has to plan around,
				// and a limit that is only enforced is one they discover by having a file refused.
				return json({ ok: true, usage: { ...(await measureStorage(env.DB, env.BUCKET)), maxFileBytes: MAX_FILE_BYTES } });
			}

			// How stale each machine is, and the worst case across all of them.
			//
			// `freshness` was written early, tested with four cases, and had no caller — the same shape as the gates
			// found in the last two rounds, and the fifth instance of it in this project. What it answers are the two
			// things an operator cannot otherwise know: WHEN each machine was last collected successfully, and
			// whether the schedule is achieving the freshness it is supposed to. The second is the one worth having,
			// because a target of "a few tens of minutes" is an assumption until something measures it.
			//
			// The worst case is reported rather than an average, and a machine that has never succeeded reports
			// `null` rather than zero. `freshness` makes both choices and documents why; this route supplies inputs.
			if (path === '/api/freshness' && method === 'GET') {
				const { results } = await env.DB.prepare(
					`SELECT h.id AS id,
					        MAX(CASE WHEN r.state = 'finished' THEN r.finished_at END) AS last_succeeded_at
					 FROM hosts h
					 LEFT JOIN collection_runs r ON r.host_id = h.id
					 WHERE h.id NOT IN ('@derived', '@uploads')
					 GROUP BY h.id
					 ORDER BY h.id`,
				).all<{ id: string; last_succeeded_at: string | null }>();

				// The most recent run per machine, for the outcome. Read separately and joined in memory rather than
				// as a correlated subquery per machine: D1 allows 1000 queries per invocation, and this spends one
				// for a number a single read provides — the same reasoning as the issue counts on `/api/runs`.
				const { results: latest } = await env.DB.prepare(
					`SELECT r.host_id AS host_id, r.state, r.stored_count, r.skipped_count, r.failed_count, r.started_at
					 FROM collection_runs r
					 WHERE r.started_at = (SELECT MAX(started_at) FROM collection_runs WHERE host_id = r.host_id)
					 ORDER BY r.host_id`,
				).all<{ host_id: string; state: string; stored_count: number; skipped_count: number; failed_count: number; started_at: string }>();

				const latestByHost = new Map((latest ?? []).map((row) => [row.host_id, row]));
				const report = freshness(
					(results ?? []).map((row) => {
						const run = latestByHost.get(row.id);
						return {
							id: row.id,
							enabled: true,
							lastStartedAt: run?.started_at ?? null,
							lastSucceededAt: row.last_succeeded_at,
							lastOutcome: run
								? {
										state: run.state,
										stored: Number(run.stored_count),
										skipped: Number(run.skipped_count),
										failed: Number(run.failed_count),
									}
								: null,
						};
					}),
					Date.now(),
				);

				return json({
					// Spread so the entries are a plain array over the wire, with the summary figures beside them.
					machines: [...report],
					worstSeconds: report.worstSeconds,
					neverCount: report.neverCount,
					// Named so the interface can say "against a target of N minutes" rather than comparing against a
					// number nothing states.
					targetSeconds: FRESHNESS_TARGET_MS / 1000,
				});
			}
			// Makes room for a file of a given size, by evicting the oldest unprotected stored files.
			//
			// A route rather than only an internal step, for two reasons. The collection pipeline is not built, so
			// without this nothing would ever call the eviction code and the policy would be unreviewable in
			// practice. And an operator facing a full store needs a way to act — "make room for the next file"
			// is a legitimate request on its own.
			//
			// It is a POST, and destructive, so it takes a session like every other management route. What it
			// cannot do is delete a protected file: `mayEvict` has no exceptions, and `makeRoomFor` re-checks the
			// plan's targets against it rather than trusting the plan.
			if (path === '/api/usage/reclaim' && method === 'POST') {
				const body = (await request.json().catch(() => ({}))) as { sizeBytes?: number };

				// Checked as a TYPE rather than coerced, which is a fix from this route's own test. `Number(undefined
				// ?? 0)` is 0 and passes every numeric check, and a body of `{"sizeBytes": null}` or a JSON string
				// arrives as `undefined` after parsing — so a malformed request became a perfectly valid request for
				// zero bytes, which reports success and reclaims nothing. That reads as a no-op rather than as the
				// mistake it is.
				if (body.sizeBytes !== undefined && typeof body.sizeBytes !== 'number') {
					throw new HttpError(400, 'sizeBytes must be a number');
				}
				const size = body.sizeBytes ?? 0;
				if (!Number.isFinite(size) || size < 0) throw new HttpError(400, 'sizeBytes must be a non-negative number');

				const before = await measureStorage(env.DB, env.BUCKET);
				if (size > MAX_FILE_BYTES) {
					throw new HttpError(400, `that file is ${size} bytes, above the ${MAX_FILE_BYTES} byte per-file limit, so no amount of reclaiming would admit it`);
				}
				if (size > STORAGE_BUDGET_BYTES) {
					// Refused before touching anything: reclaiming everything would still not make room, so doing it
					// would delete files for a file that is refused either way.
					throw new HttpError(400, `that file is larger than the whole ${STORAGE_BUDGET_BYTES} byte budget, so it can never be admitted and nothing was reclaimed`);
				}

				const outcome = await withStorageWriter(env, () => reclaimFor(env.DB, env.BUCKET, size, nowIso()));
				const after = await measureStorage(env.DB, env.BUCKET);

				return json({
					ok: outcome.admitted,
					// Both figures, because the operator is being asked to accept deletions: what it was, what it is,
					// and how many files paid for it.
					before,
					after,
					admitted: outcome.admitted,
					evicted: outcome.evicted,
					evictedCount: outcome.evicted.length,
					freedBytes: outcome.freedBytes,
					saturatedByImportant: outcome.saturatedByImportant,
					...(outcome.problem === undefined ? {} : { error: outcome.problem }),
				}, outcome.admitted ? 200 : 409);
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
				await withStorageWriter(env, async () => {
                    // Keep metadata until every owned key has been reclaimed. A failed delete remains accounted.
                    const rows = await env.DB.prepare('SELECT id FROM objects WHERE host_id = ?').bind(id).all<{ id: number }>();
                    for (const row of rows.results ?? []) await reclaimVersion(env.DB, env.BUCKET, row.id, nowIso());
                    await env.DB.prepare('DELETE FROM hosts WHERE id = ?').bind(id).run();
                });
				return json({ ok: true, deleted: id });
			}

			if (path === '/api/hosts/test' && method === 'POST') {
				const body = (await request.json()) as { id?: string };
				const id = slugify(String(body.id ?? ''));
				if (!id) throw new HttpError(400, 'id is required');
				return await testHost(env, id);
			}

			if (path === '/api/rules' && method === 'GET') {
				// Bounded, like every other listing. An adversarial audit found this unbounded: rules are added one
				// row per accepted pattern with no cap, so the response grew with use. 500 is generous for a
				// deployment whose machine ceiling is 50, and still finite.
				const hostId = url.searchParams.get('hostId');
				const { results } = hostId
					? await env.DB.prepare(
							'SELECT * FROM source_rules WHERE host_id IS NULL OR host_id = ? ORDER BY host_id, is_exclude, pattern LIMIT 500',
						)
							.bind(slugify(hostId))
							.all<SourceRuleRow>()
					: await env.DB.prepare('SELECT * FROM source_rules ORDER BY host_id, is_exclude, pattern LIMIT 500').all<SourceRuleRow>();
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

			// ---------------------------------------------------------------------------------------------
			// Derived objects: merge rules, previews, and running them. Ticket 12.
			//
			// The engine in `merge.ts` is pure and the decisions live in `derived.ts`; this section is only the
			// part that needs a database and a bucket. It is the boundary the two modules were shaped around, so
			// what happens here is deliberately thin: read the rows, hand them to a decision, write what it says.
			// ---------------------------------------------------------------------------------------------

			if (path === '/api/derived' && method === 'GET') {
				const { results } = await env.DB.prepare(
					'SELECT id, output_name, rule_json, signature, created_at, updated_at FROM derived_rules ORDER BY output_name LIMIT 200',
				).all<{ id: string; output_name: string; rule_json: string; signature: string; created_at: string; updated_at: string }>();

				const rules = (results ?? []).map((row) => {
					try {
						const record = parseStoredRule(row);
						return { ...record, stored: true as const };
					} catch (err) {
						// A rule whose text cannot be parsed is reported as broken rather than dropped from the
						// list: an unlisted rule is one the operator cannot see, and therefore cannot repair.
						return { id: row.id, outputName: row.output_name, problem: (err as Error).message, stored: false as const };
					}
				});

				return json({ ok: true, rules });
			}

			if (path === '/api/derived' && method === 'POST') {
				const body = (await request.json()) as Partial<DerivedRuleDefinition>;
				const definition = definitionFrom(body);

				const problem = await ruleProblemAgainstStored(env, definition);
				if (problem) throw new HttpError(400, problem);

				const now = nowIso();
				const existing = await env.DB.prepare('SELECT id FROM derived_rules WHERE output_name = ?')
					.bind(definition.outputName)
					.first<{ id: string }>();

				// Redefining is an update, not a second rule: two rules writing one output name would produce two
				// objects claiming the same identity, and "which is current" would have no answer. The unique index
				// on output_name enforces the same thing, so this is the readable path to the same guarantee.
				const id = existing?.id ?? crypto.randomUUID();
				const signature = mergeSignature(definition, []);

				await env.DB.prepare(
					`INSERT INTO derived_rules (id, output_name, rule_json, signature, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT (id) DO UPDATE SET
					   output_name = excluded.output_name,
					   rule_json = excluded.rule_json,
					   signature = excluded.signature,
					   updated_at = excluded.updated_at`,
				)
					.bind(id, definition.outputName, JSON.stringify(definition), signature, now, now)
					.run();

				return json({ ok: true, id, rule: { id, ...definition, signature, createdAt: now, updatedAt: now } });
			}

			if (path === '/api/derived/delete' && method === 'POST') {
				const body = (await request.json()) as { id?: string };
				if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'an id is required');
				// The recorded result is deliberately left in place. It is a stored file like any other and deleting
				// a rule is not a request to delete data; the interface says the object is no longer maintained.
				await env.DB.prepare('DELETE FROM derived_rules WHERE id = ?').bind(body.id).run();
				return json({ ok: true, deleted: body.id });
			}

			if ((path === '/api/derived/preview' || path === '/api/derived/run') && method === 'POST') {
				const body = (await request.json()) as Partial<DerivedRuleDefinition> & { id?: string };

				// A saved rule can be previewed or run by id; an unsaved one is previewed from the definition in the
				// request, which is what lets the operator see what a rule would do before committing to it.
				let definition: DerivedRuleDefinition;
				let ruleId: string | null = null;
				if (typeof body.id === 'string' && body.id) {
					const row = await env.DB.prepare(
						'SELECT id, output_name, rule_json, signature, created_at, updated_at FROM derived_rules WHERE id = ?',
					)
						.bind(body.id)
						.first<{ id: string; output_name: string; rule_json: string; signature: string; created_at: string; updated_at: string }>();
					if (!row) throw new HttpError(404, 'no rule with that id');
					const record = parseStoredRule(row);
					definition = {
						outputName: record.outputName,
						combination: record.combination,
						sources: record.sources,
						...(record.order === undefined ? {} : { order: record.order }),
						...(record.nameFromSource === undefined ? {} : { nameFromSource: record.nameFromSource }),
					};
					ruleId = record.id;
				} else {
					definition = definitionFrom(body);
					const problem = await ruleProblemAgainstStored(env, definition);
					if (problem) throw new HttpError(400, problem);
				}

                const execute = async () => {
                    const selection = await loadMergeSelection(env, definition);
                    const read = await readMergeContents(env, selection.objects);
                    if (read.problem) return json({ ok: false, error: read.problem, notes: [], outputName: definition.outputName }, 409);
                    if (path === '/api/derived/preview') return json({ ok: true, preview: previewDerived(definition, selection.objects, read.contents) });
                    const outcome = runDerived(definition, selection.objects, read.contents);
                    if (!outcome.ok || outcome.content === undefined) return json({ ok: false, error: outcome.problem, notes: outcome.notes, outputName: outcome.outputName }, 409);
                    const stored = await storeDerivedObject(env, definition, outcome, selection, ruleId);
                    return json({ ok: true, ...stored });
                };
                return path === '/api/derived/run' ? await withStorageWriter(env, execute) : await execute();
			}

/**
 * The machine id a derived object is filed under.
 *
 * Derived objects need a `host_id` because the column is `NOT NULL REFERENCES hosts (id)`, and they come from no
 * machine. A reserved row is created by migration 0004 rather than a real host being borrowed, so the sentinel
 * is visible and explainable: a derived object attributed to whichever machine happened to be first would make
 * "where did this file come from" answer a question that is not true.
 *
 * The leading `@` cannot collide with a real host id, which `slugify` produces from a hostname and therefore
 * never begins with.
 *
 * A **function** rather than a `const`, and that is deliberate rather than stylistic. This is defined below the
 * handler object that uses it, and a `const` sits in the temporal dead zone until its declaration is evaluated
 * — so the first request to run a merge failed with `Cannot access 'DERIVED_HOST_ID' before initialization`.
 * Function declarations are hoisted, so the ordering cannot matter.
 */
function derivedHostId(): string {
	return '@derived';
}

/** SHA-256 of some bytes, as lowercase hex. Used for a derived object's content hash. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The merge rule from a request body, refused rather than coerced.
 *
 * The engine's `MergeRule` is trusted input — it comes from the operator's own saved rule — so this is the one
 * place a request becomes one, and anything unrecognised is dropped here rather than travelling further in a
 * shape nothing validates.
 */
function definitionFrom(body: Partial<DerivedRuleDefinition>): DerivedRuleDefinition {
	const sources = Array.isArray(body.sources)
		? body.sources
		: [];

	const definition: DerivedRuleDefinition = {
		outputName: String(body.outputName ?? '').trim(),
		combination: body.combination as MergeRule['combination'],
		sources,
	};
	// Preserve supplied fields for definition-time validation; silently dropping malformed options
	// would save/run a different rule than the operator submitted.
	if (body.order !== undefined) definition.order = body.order;
	if (body.nameFromSource !== undefined) {
		definition.nameFromSource = body.nameFromSource;
	}
	return definition;
}

/** The cycle check, against the rules actually stored rather than a list the caller supplied. */
async function ruleProblemAgainstStored(env: Env, definition: DerivedRuleDefinition): Promise<string | null> {
	const { results } = await env.DB.prepare('SELECT output_name, rule_json FROM derived_rules').all<{
		output_name: string;
		rule_json: string;
	}>();

	const existing: MergeRuleRef[] = [];
	for (const row of results ?? []) {
		try {
			const record = parseStoredRule({ id: '', rule_json: row.rule_json, signature: '', created_at: '', updated_at: '' });
			existing.push({ outputName: record.outputName, uses: record.sources.filter(spec => spec.hostId === undefined || spec.hostId === derivedHostId()).map(spec => spec.pattern) });
		} catch {
			// A stored rule that cannot be parsed cannot participate in a cycle, and refusing every new rule
			// because an old one is corrupt would make the corruption unrecoverable through the interface.
		}
	}

	return ruleDefinitionProblem(definition, existing);
}

/**
 * The stored objects a rule takes, and the ids of objects that are themselves derived.
 *
 * Selection includes all live candidates; a fixed prefix could produce a silently partial output.
 * Own-output ids are excluded, while other derived outputs can feed dependency-ordered rules.
 * Aggregate input bytes are checked before text materialization by readMergeContents.
 */
async function loadMergeSelection(
	env: Env,
	definition: DerivedRuleDefinition,
): Promise<{ objects: StoredObject[]; derivedIds: Set<number> }> {
	const [objects, derived] = await Promise.all([
		env.DB.prepare(
			`SELECT o.id AS id, o.host_id AS host_id, o.path AS path, o.object_key AS object_key,
			        o.size_bytes AS size_bytes, o.content_hash AS content_hash
			 FROM objects o
			 WHERE o.deleted_at IS NULL AND o.superseded_by IS NULL
			 ORDER BY o.host_id, o.path`,
		).all<{ id: number; host_id: string; path: string; object_key: string; size_bytes: number; content_hash: string }>(),
		env.DB.prepare('SELECT d.object_id FROM derived_objects d JOIN objects o ON o.id = d.object_id WHERE o.deleted_at IS NULL AND o.superseded_by IS NULL').all<{ object_id: number }>(),
	]);

	const derivedIds = new Set((derived.results ?? []).map((row) => Number(row.object_id)));
	const stored: StoredObject[] = (objects.results ?? []).map((row) => ({
		id: Number(row.id),
		hostId: row.host_id,
		path: row.path,
		objectKey: row.object_key,
		sizeBytes: Number(row.size_bytes),
		contentHash: row.content_hash,
	}));

	const selfIds = new Set(stored.filter(object => object.hostId === derivedHostId() && object.path === `/${definition.outputName}`).map(object => object.id));
    return { objects: planMergeSources(definition, stored, selfIds), derivedIds };
}

/**
 * Reads the selected objects' text from the bucket.
 *
 * A source that cannot be read is a **refusal**, not an empty string. Substituting empty text would let a merge
 * succeed while silently dropping a file, and the result would look complete — the failure this whole feature
 * is built to avoid. The caller turns `problem` into a 409 and stores nothing.
 */
async function readMergeContents(
	env: Env,
	objects: StoredObject[],
): Promise<{ contents: Map<number, string>; problem?: string }> {
	const contents = new Map<number, string>();
    const MERGE_INPUT_BYTES = 8 * 1024 * 1024;
    if (objects.reduce((sum, object) => sum + object.sizeBytes, 0) > MERGE_INPUT_BYTES) {
        return { contents, problem: 'the merge inputs exceed the 8 MiB in-memory text merge limit' };
    }
    let readBytes = 0;
	const unreadable: string[] = [];

	for (const object of objects) {
		const stored = await env.BUCKET.get(object.objectKey);
		if (!stored) {
			unreadable.push(`${object.hostId}:${object.path}`);
			continue;
		}
		readBytes += stored.size;
        if (readBytes > MERGE_INPUT_BYTES) return { contents, problem: 'the merge inputs exceed the 8 MiB in-memory text merge limit' };
        contents.set(object.id, await stored.text());
	}

	if (unreadable.length > 0) {
		return {
			contents,
			problem: `these sources could not be read from storage, so nothing was produced: ${unreadable.join(', ')}`,
		};
	}
	return { contents };
}

/**
 * Writes a successful merge as an object like any other.
 *
 * Three things make the result usable rather than merely present:
 *
 *   - It is marked **important**, because the budget never evicts an important object and a derived object whose
 *     sources were evicted could never be rebuilt. The result is the one thing here that cannot be regenerated
 *     from what is left.
 *   - It records the sources and each one's hash in `object_sources`, which is what makes the interface able to
 *     say what it came from, and what makes "is this current" answerable later.
 *   - It records the signature **as built**. Recomputing it later from the sources is impossible once they are
 *     gone, and a stale result must stay recognisable as stale rather than becoming indistinguishable from a
 *     current one.
 */
async function storeDerivedObject(
	env: Env,
	definition: DerivedRuleDefinition,
	outcome: DerivedRunOutcome,
	selection: { objects: StoredObject[]; derivedIds: Set<number> },
	ruleId: string | null,
): Promise<Record<string, unknown>> {
	const content = outcome.content ?? '';
	const bytes = new TextEncoder().encode(content);
	const hash = await sha256Hex(bytes);

	const now = nowIso();
	const hostId = derivedHostId();
	const objectKey = `derived/${crypto.randomUUID()}/${definition.outputName}`;
	const path = `/${definition.outputName}`;

    if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, 'the derived output exceeds the per-file limit');
    const admission = await checkFileBudget(env.DB, bytes.byteLength, env.BUCKET);
    if (!admission.ok) throw new HttpError(409, admission.reason);
    await env.BUCKET.put(objectKey, bytes);
    const objectId = await publishVersion(env, { hostId, path, key: objectKey, bytes: bytes.byteLength, hash, mtime: null }, async id => {
        if (ruleId) await env.DB.prepare('INSERT INTO derived_objects (object_id, rule_id, rule_signature, built_at) VALUES (?, ?, ?, ?)')
            .bind(id, ruleId, outcome.signature, now).run();
        await env.DB.prepare('INSERT OR REPLACE INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)').bind(id, now).run();
        for (const source of selection.objects) await env.DB.prepare('INSERT INTO object_sources (object_id, source_object_id, source_hash) VALUES (?, ?, ?)')
            .bind(id, source.id, source.contentHash).run();
    });

	return {
		objectId,
		outputName: definition.outputName,
		bytes: bytes.byteLength,
		contentHash: hash,
		signature: outcome.signature,
		// Reported rather than implied: an interrupted write is the one outcome a caller has to be told about,
		// because the interface would otherwise show a result whose provenance is missing.
		sourcesRecorded: selection.objects.length,
		notes: outcome.notes,
	};
}

			if (path === '/api/derived/status' && method === 'GET') {
				// Whether each stored result is still current, and what it was built from.
				//
				// This is the answer to a question the schema deliberately made decidable: the signature is
				// recomputed from the rule and the sources as they are NOW, and compared against the signature
				// recorded when the result was BUILT. Any difference means the result no longer matches its inputs
				// — the rule changed, a source's content changed, or a source appeared or disappeared — and the
				// three are not distinguished because the useful fact is the same in all three cases: rebuild.
				//
				// The stored signature is what makes this answerable after the sources are gone. Recomputing from
				// the sources alone would make an evicted source indistinguishable from an unchanged one, so a
				// result whose inputs had been evicted would report itself current — the one wrong answer that
				// matters.
				const { results: ruleRows } = await env.DB.prepare(
					'SELECT id, output_name, rule_json, signature, created_at, updated_at FROM derived_rules ORDER BY output_name LIMIT 200',
				).all<{ id: string; output_name: string; rule_json: string; signature: string; created_at: string; updated_at: string }>();

				const { results: builtRows } = await env.DB.prepare(
					`SELECT d.object_id, d.rule_id, d.rule_signature, d.built_at, o.path, o.size_bytes, o.content_hash, o.deleted_at
					 FROM derived_objects d
					 JOIN objects o ON o.id = d.object_id
					 ORDER BY d.built_at DESC
					 LIMIT 500`,
				).all<{
					object_id: number;
					rule_id: string;
					rule_signature: string;
					built_at: string;
					path: string;
					size_bytes: number;
					content_hash: string;
					deleted_at: string | null;
				}>();

				const statuses = [];
				for (const row of ruleRows ?? []) {
					let record;
					try {
						record = parseStoredRule(row);
					} catch (err) {
						// A rule whose stored text will not parse is reported as broken rather than omitted, so it
						// stays visible enough to be repaired.
						statuses.push({ ruleId: row.id, outputName: row.output_name, problem: (err as Error).message, current: false });
						continue;
					}

					const definition: DerivedRuleDefinition = {
						outputName: record.outputName,
						combination: record.combination,
						sources: record.sources,
						...(record.order === undefined ? {} : { order: record.order }),
						...(record.nameFromSource === undefined ? {} : { nameFromSource: record.nameFromSource }),
					};

					// The newest result for this rule, which is the one the operator is being told about. A rule
					// can have an older tombstoned result from before a re-run; reporting on that one would answer
					// about a file nobody can download.
					const built = (builtRows ?? []).find((b) => b.rule_id === row.id && b.deleted_at === null) ?? null;

					const selection = await loadMergeSelection(env, definition);
					const nowSignature = mergeSignature(definition, selection.objects);
					const sources = await env.DB.prepare(
						`SELECT s.source_object_id, s.source_hash, o.path AS path, o.host_id AS host_id
						 FROM object_sources s
						 LEFT JOIN objects o ON o.id = s.source_object_id
						 WHERE s.object_id = ?
						 ORDER BY o.host_id, o.path
						 LIMIT 500`,
					)
						.bind(built?.object_id ?? -1)
						.all<{ source_object_id: number; source_hash: string; path: string | null; host_id: string | null }>();

					statuses.push({
						ruleId: row.id,
						outputName: record.outputName,
						// `null` rather than `false` when nothing has been built: "not built yet" and "built and now
						// stale" are different situations and lead to different actions.
						current: built === null ? null : built.rule_signature === nowSignature,
						builtAt: built?.built_at ?? null,
						objectId: built?.object_id ?? null,
						sizeBytes: built?.size_bytes ?? null,
						// Stated so the interface can say "3 of 3 sources still match" rather than only current/stale,
						// and so an operator can see WHICH source changed.
						sourceCount: selection.objects.length,
						sources: (sources.results ?? []).map((s) => ({
							objectId: s.source_object_id,
							path: s.path ?? '(no longer stored)',
							hostId: s.host_id ?? '(no longer stored)',
							hash: s.source_hash,
						})),
					});
				}

				return json({ ok: true, rules: statuses });
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
			const status = e instanceof HttpError || e instanceof FileProblem ? e.status : 500;

			// Errors reach the operator, but never carry decrypted material: messages that could are built only
			// from the host id and the field name.
			//
			// **The stack is logged, never returned.** It used to be included, and the reasoning was sound at
			// the time: this Worker is deployed with no type checking in the build, so a shape mistake in a
			// dependency call surfaces only here, and a stack turns that from guesswork into a line number —
			// which is exactly how a bare-string `algorithms.cipher` was found. What that reasoning missed is
			// that the response also goes to **anonymous callers**: an adversarial audit showed a 401 and a 500
			// handing out absolute source paths and line numbers to anyone who asked, including through a
			// malformed share link.
			//
			// `observability` is enabled in `wrangler.jsonc`, so the stack is still available to the operator
			// where it belongs — in the logs — and the caller gets a message they can act on instead.
			console.error(
				JSON.stringify({
					at: 'request-failed',
					path,
					method,
					status,
					name: e.name,
					message: e.message,
					stack: e.stack,
				}),
			);

			return json({ ok: false, error: e.message, name: e.name, status }, status);
		}
	},
} satisfies ExportedHandler<Env>;
