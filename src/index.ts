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

import { connect as sshConnect } from 'edgeport/ssh';
import { connect as sftpConnect } from 'edgeport/sftp';
import { credentialFingerprint, decryptField, encryptField, generateMasterKey } from './crypto';
import { getHost, listHosts, nowIso, rulesForHost, slugify, type HostRow, type SourceRuleRow } from './db';
import { LOCALES, pickLocale, renderIndexPage, type Locale } from './ui';
import { statementsOf } from './sql';
// Wrangler's default bundling treats `.sql` as a `Text` module, so these are plain strings at
// runtime. Importing the migration files keeps the CLI path and the in-Worker path on one schema.
// A new migration must be added here AND to the list below, or a CLI-less deployment would never
// apply it.
import initSchemaSql from '../migrations/0001_init.sql';
import usageIndexSql from '../migrations/0002_usage_index.sql';
import receiptsSql from '../migrations/0003_receipts_importance_and_sources.sql';

interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	/**
	 * Base64 32-byte AES-GCM key. The ONLY secret this Worker needs. Everything else sensitive lives
	 * encrypted in D1.
	 */
	SSH_MASTER_KEY: string;
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

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
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

/**
 * Every migration a CLI-less deployment has to apply, in order.
 *
 * This list is the in-Worker equivalent of `wrangler d1 migrations apply`. It has to be extended
 * whenever a migration file is added, which is the one maintenance cost of not having a CLI attached
 * to a release. `applySchema` reports what it applied so a missing entry is visible rather than
 * silent.
 *
 * **Every statement in every migration must be idempotent, and that is a constraint on the migration
 * file rather than something this code compensates for.** `CREATE ... IF NOT EXISTS` is naturally
 * repeatable; `ALTER TABLE ... ADD COLUMN` is not, and the database has no `ADD COLUMN IF NOT
 * EXISTS`. An earlier draft learned this by failing its own "safe to run again" test. Prefer a new
 * table over a new column on an existing one.
 */
const SCHEMA_MIGRATIONS: { name: string; sql: string }[] = [
	{ name: '0001_init', sql: initSchemaSql },
	{ name: '0002_usage_index', sql: usageIndexSql },
	{ name: '0003_receipts_importance_and_sources', sql: receiptsSql },
];

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
 * Reports whether the schema is present, so the UI can tell the operator what to do next.
 *
 * Indexes are checked alongside tables: a table can exist from an older deployment while a later
 * migration never ran, and that is precisely the state this returns `ready: false` for.
 */
async function schemaStatus(env: Env): Promise<{ ready: boolean; missing: string[] }> {
	const required = [
		// tables
		'hosts',
		'source_rules',
		'objects',
		'multipart_sessions',
		'collection_runs',
		'collection_issues',
		'object_sources',
		// indexes the product depends on for correctness or for a bounded read
		'idx_objects_usage',
		'idx_objects_eviction',
		'idx_runs_host_started',
	];
	const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all<{ name: string }>();
	const present = new Set((results ?? []).map((r) => r.name));
	return { ready: required.every((t) => present.has(t)), missing: required.filter((t) => !present.has(t)) };
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
}

/**
 * Measures what the store is actually holding.
 *
 * `liveBytes` is what a consumer can reach; `totalBytes` is what the bucket holds, and R2 charges
 * for the bucket. The budget therefore has to be judged on the total, or superseded objects would
 * let the store grow past 10 GB while every visible number still looked healthy.
 *
 * One aggregate query, not a scan: D1 allows 1000 queries per Worker invocation and the row ceiling
 * is what matters here, not the row count.
 */
async function measureStorage(db: D1Database): Promise<StorageUsage> {
	const row = await db
		.prepare(
			`SELECT
			   COALESCE(SUM(CASE WHEN superseded_by IS NULL AND deleted_at IS NULL THEN size_bytes ELSE 0 END), 0) AS live_bytes,
			   COALESCE(SUM(CASE WHEN superseded_by IS NOT NULL OR deleted_at IS NOT NULL THEN size_bytes ELSE 0 END), 0) AS retained_bytes,
			   COALESCE(SUM(size_bytes), 0) AS total_bytes,
			   COUNT(*) AS object_count
			 FROM objects`,
		)
		.first<{ live_bytes: number; retained_bytes: number; total_bytes: number; object_count: number }>();

	const totalBytes = Number(row?.total_bytes ?? 0);
	return {
		liveBytes: Number(row?.live_bytes ?? 0),
		retainedBytes: Number(row?.retained_bytes ?? 0),
		totalBytes,
		objectCount: Number(row?.object_count ?? 0),
		budgetBytes: STORAGE_BUDGET_BYTES,
		remainingBytes: Math.max(0, STORAGE_BUDGET_BYTES - totalBytes),
		usedFraction: totalBytes / STORAGE_BUDGET_BYTES,
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

/** Minimal glob for one path segment: `*`, `?` and literals. */
function globToRegExp(pattern: string): RegExp {
	let out = '^';
	for (const ch of pattern) {
		if (ch === '*') out += '[^/]*';
		else if (ch === '?') out += '[^/]';
		else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`${out}$`);
}

/**
 * Connects to a host, identifies it, and checks each applicable rule against a real directory
 * listing where the rule permits it.
 *
 * Read-only throughout: `uname`, `whoami`, `hostname`, `df`, and SFTP `list`/`stat`. Nothing on the
 * target is written, renamed, or deleted.
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

	// Decryption happens before the timer starts: the measured stage should be the connection, not
	// the fast local key work, and this keeps the plaintext alive for the shortest span possible.
	const options = await connectOptionsFor(env, row);
	const ssh = await timed('ssh connect + auth', () => sshConnect(options));

	try {
		const facts = await timed('identify', async () => ({
			uname: await ssh.run('uname -a'),
			whoami: await ssh.run('whoami'),
			hostname: await ssh.run('hostname'),
			disk: await ssh.df('/').catch(() => null),
		}));

		const rules = await rulesForHost(env.DB, id);
		const evaluations: {
			pattern: string;
			scope: string;
			isExclude: boolean;
			status: string;
			matchCount?: number;
			matches?: string[];
			detail?: string;
		}[] = [];

		const sftp = await timed('sftp subsystem', () => sftpConnect({ session: ssh }));
		try {
			for (const rule of rules) {
				const base = {
					pattern: rule.pattern,
					scope: rule.host_id === null ? 'global' : 'host',
					isExclude: rule.is_exclude === 1,
				};
				const slash = rule.pattern.lastIndexOf('/');
				const dir = slash > 0 ? rule.pattern.slice(0, slash) : '/';
				const name = slash >= 0 ? rule.pattern.slice(slash + 1) : rule.pattern;

				// A wildcard in the directory part cannot be resolved by listing one directory. It is
				// reported honestly as needing the collection step rather than silently skipped.
				if (/[*?[]/.test(dir)) {
					evaluations.push({ ...base, status: 'needs_collection_step', detail: 'the directory part contains a wildcard' });
					continue;
				}

				try {
					const entries = await sftp.list(dir);
					const regex = globToRegExp(name);
					const matches = entries
						.filter((e) => !e.attrs.isDirectory && regex.test(e.filename))
						.map((e) => e.filename)
						.sort();
					evaluations.push({
						...base,
						status: 'ok',
						matchCount: matches.length,
						matches: matches.slice(0, 50),
						detail: `${matches.length} file(s) in ${dir}`,
					});
				} catch (err) {
					evaluations.push({ ...base, status: 'error', detail: (err as Error).message });
				}
			}
		} finally {
			await sftp.close();
		}

		return json({ ok: true, host: await publicHost(row), facts, rules: rules.map(publicRule), evaluations, stages });
	} finally {
		await ssh.close();
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

			if (path === '/api/usage' && method === 'GET') {
				return json({ ok: true, usage: await measureStorage(env.DB) });
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
