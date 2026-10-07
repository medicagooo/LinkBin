import { env } from 'cloudflare:test';
import worker from '../src/index';
import { buildObjectQuery } from '../src/browse';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Audit C — adversarial review of database query construction.
 *
 * ## What this file is for
 *
 * Every test here is written so that it FAILS if the property it names is violated. A vulnerability is
 * claimed only where a test actually fails; where a test passes, the hypothesis it attacks is disproved and
 * the test remains as the regression guard for that disproof.
 *
 * The hypotheses, in the order they appear below:
 *
 *   1. `buildObjectQuery` can be made to change the *structure* of the statement rather than only a bound
 *      value — in particular the `where.replace(...)` column rewriting and the sorting lookup.
 *   2. Somewhere in `src/index.ts` a request value is interpolated into a SQL string instead of bound.
 *   3. The `/api/runs` `IN (?,?,?)` clause built with `ids.map(() => '?')` is unsafe (empty or enormous).
 *   4. A crafted `host` / `q` provokes an error whose body leaks schema or data.
 *   5. A LIKE pattern reaches SQLite unescaped, so `%` or `_` silently changes the semantics.
 *   6. A read returns an unbounded number of rows.
 *
 * ## How "is this value interpolated?" is answered mechanically
 *
 * Reading the source and believing it is not evidence. {@link recordingDb} wraps the real `D1Database`
 * binding in a `Proxy` that records the exact SQL text handed to `db.prepare(...)` — the text *before*
 * binding, which is precisely where an interpolated value would be visible. Requests are then made with
 * hostile payloads in every parameter, and the recorded statement text is searched for the payload.
 *
 * ## Platform facts these tests lean on (Cloudflare D1 documentation, retrieved 2026-11-08)
 *
 *   - "Maximum bound parameters per query: 100" — https://developers.cloudflare.com/d1/platform/limits/
 *   - "Maximum characters (bytes) in a `LIKE` or `GLOB` pattern: 50 bytes" — same page. The offline
 *     harness enforces the same ceiling: the boundary measured below is 50 bytes, exactly.
 *   - D1 error messages carry the failing SQL on production ("D1_EXEC_ERROR: Error in line 1: <statement>:
 *     sql error: near ... at offset 0") — https://developers.cloudflare.com/d1/observability/debug-d1/
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long interface password';

let token = '';

/**
 * Calls the Worker's own `fetch`. `overrides` replaces bindings for one call, which is how the recording
 * database is injected without touching `src/`.
 */
function call(path: string, init?: RequestInit, overrides: Record<string, unknown> = {}): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY, ...overrides } as never, {} as never);
}

function asOperator(path: string, overrides: Record<string, unknown> = {}): Promise<Response> {
	return call(path, { headers: { cookie: `linkbin_session=${token}` } }, overrides);
}

function postJson(path: string, body: unknown, overrides: Record<string, unknown> = {}): Promise<Response> {
	return call(
		path,
		{ method: 'POST', headers: { 'content-type': 'application/json', cookie: `linkbin_session=${token}` }, body: JSON.stringify(body) },
		overrides,
	);
}

/**
 * The real D1 binding, with every SQL string passed to `prepare()` recorded into `sqls`.
 *
 * A `Proxy` rather than a fake: the statements still run against the simulated database, so a request
 * behaves exactly as it does in production while its statement text is captured.
 */
function recordingDb(sqls: string[]): Record<string, unknown> {
	const target = env.DB as unknown as Record<string, unknown>;
	const db = new Proxy(target, {
		get(bound, prop) {
			if (prop === 'prepare') {
				return (sql: string) => {
					sqls.push(sql);
					return (bound.prepare as (s: string) => unknown)(sql);
				};
			}
			const value = bound[prop];
			return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(bound) : value;
		},
	});
	return { DB: db };
}

async function countOf(table: string): Promise<number> {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
	return Number(row?.n ?? 0);
}

async function bootstrap(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of [
		'shares',
		'object_sources',
		'object_flags',
		'objects',
		'collection_issues',
		'collection_runs',
		'source_rules',
		'hosts',
		'auth_secret',
		'auth_attempts',
	]) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	token = /linkbin_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];

	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
		        ('h2', 'two', 'b.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();
}

async function addObject(over: { host?: string; path: string; size?: number; at?: string }): Promise<number> {
	const host = over.host ?? 'h1';
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES (?, ?, ?, ?, 'hash', ?)`,
	)
		.bind(host, over.path, `objects/${host}${over.path}`, over.size ?? 100, over.at ?? '2026-01-01T00:00:00.000Z')
		.run();
	return Number(result.meta.last_row_id);
}

async function addRun(over: Record<string, unknown> = {}): Promise<number> {
	const row = {
		host_id: 'h1',
		state: 'finished',
		started_at: '2026-01-01T10:00:00.000Z',
		finished_at: '2026-01-01T10:02:00.000Z',
		stored_count: 1,
		skipped_count: 0,
		failed_count: 0,
		bytes_stored: 10,
		...over,
	};
	const result = await env.DB.prepare(
		`INSERT INTO collection_runs (host_id, state, started_at, finished_at, stored_count, skipped_count, failed_count, bytes_stored)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(row.host_id, row.state, row.started_at, row.finished_at, row.stored_count, row.skipped_count, row.failed_count, row.bytes_stored)
		.run();
	return Number(result.meta.last_row_id);
}

async function addIssue(runId: number, over: Record<string, unknown> = {}): Promise<void> {
	const row = { host_id: 'h1', path: '/var/log/app.log', kind: 'error', reason: 'nope', size_bytes: null, created_at: '2026-01-01T10:01:00.000Z', ...over };
	await env.DB.prepare(
		`INSERT INTO collection_issues (run_id, host_id, path, kind, reason, size_bytes, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(runId, row.host_id, row.path, row.kind, row.reason, row.size_bytes, row.created_at)
		.run();
}

const PAYLOADS = ["' OR 1=1 --", "'; DROP TABLE objects; --", "' UNION SELECT id, path FROM objects --"];

// ---------------------------------------------------------------------------------------------
// Hypothesis 1 — a filter field changes the structure of the statement
// ---------------------------------------------------------------------------------------------

describe('hypothesis 1: buildObjectQuery, the filter object and the statement structure', () => {
	it('never puts a filter value into the statement text, including through the column rewrite', () => {
		// `where.replace(/\b(host_id|path|deleted_at|superseded_by)\b/g, 'o.$1')` runs over a string that
		// would already contain the user's values if anything were interpolated. Nothing is: the values are
		// the `?` parameters. This asserts the property rather than trusting the reading.
		const nasty = "1=1 OR o.host_id LIKE '%";
		const query = buildObjectQuery({ hostId: nasty, pattern: nasty, search: nasty, includeSuperseded: true });

		expect(query.sql, `statement text: ${query.sql}`).not.toContain('1=1');
		expect(query.countSql, `count statement text: ${query.countSql}`).not.toContain('1=1');
		expect(query.sql, `statement text: ${query.sql}`).not.toContain(nasty);
		// And the rewrite did its job on the constant clauses it was written for.
		expect(query.sql).toMatch(/o\.host_id = \?/);
		expect(query.sql).toMatch(/o\.deleted_at IS NULL/);
		expect(query.sql).not.toMatch(/[^.o]\bhost_id = \?/);
	});

	it('resolves an unrecognised sort to the default instead of interpolating it', () => {
		// The documented rule, and the one a value from a query string depends on.
		for (const sort of ['not-a-sort', 'created_at; DROP TABLE objects; --', '', 'NEWEST']) {
			const { sql } = buildObjectQuery({ sort: sort as never });
			expect(sql, `sort=${JSON.stringify(sort)} produced: ${sql}`).toMatch(/ORDER BY o\.created_at DESC, id DESC LIMIT \?/);
			expect(sql, `sort=${JSON.stringify(sort)} produced: ${sql}`).not.toMatch(/DROP TABLE|;/);
		}
	});

	it('does not let a sort naming an inherited Object.prototype member reach ORDER BY', () => {
		// `SORTS[filter.sort] ?? SORTS[DEFAULT_SORT]` falls back only when the lookup is null/undefined. A
		// plain object literal inherits from Object.prototype, so `SORTS['constructor']` is the `Object`
		// function — not undefined — and `??` keeps it, and the template literal then stringifies it into
		// the statement. A value from the query string therefore reaches the statement *text*.
		for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']) {
			const { sql } = buildObjectQuery({ sort: key as never });
			expect(sql, `sort=${key} produced: ${sql}`).not.toMatch(/native code|\[object Object\]/);
			expect(sql, `sort=${key} produced: ${sql}`).toMatch(/ORDER BY o\.(created_at DESC, id DESC|created_at ASC, id ASC|size_bytes|path)/);
		}
	});

	it('answers a nonsense sort with the page it documents, not with an error', async () => {
		await bootstrap();
		await addObject({ path: '/etc/config.yaml' });

		const res = await asOperator('/api/objects?sort=constructor');
		const text = await res.text();
		expect(res.status, `GET /api/objects?sort=constructor answered ${res.status} with: ${text}`).toBe(200);
	});

	it('leaks no internals in the body when the sort is nonsense', async () => {
		await bootstrap();
		await addObject({ path: '/etc/config.yaml' });

		const res = await asOperator('/api/objects?sort=constructor');
		const body = await res.text();
		expect(body, `body: ${body}`).not.toMatch(/stack|SQLITE|syntax error|src\/index/i);
	});

	it('leaves the database intact, so the broken sort is not an executed injection', async () => {
		await bootstrap();
		await addObject({ path: '/etc/config.yaml' });
		await addObject({ path: '/etc/other.yaml', at: '2026-02-01T00:00:00.000Z' });

		await asOperator('/api/objects?sort=constructor');

		// Surviving rows are how "the statement failed to parse" is told apart from "the statement ran and
		// did something". A syntax error cannot have executed anything.
		const after = (await (await asOperator('/api/objects')).json()) as any;
		expect(after.total, 'objects in the table after the crafted sort').toBe(2);
	});
});

// ---------------------------------------------------------------------------------------------
// Hypothesis 2 — a request value interpolated into a SQL string in src/index.ts
// ---------------------------------------------------------------------------------------------

describe('hypothesis 2: request values interpolated into SQL strings in the router', () => {
	beforeEach(bootstrap);

	it('never puts a request value into the statement text of any route it reaches', async () => {
		await addObject({ path: '/etc/config.yaml' });
		await addObject({ host: 'h2', path: '/etc/other.yaml' });
		const runId = await addRun();
		await addRun({ host_id: 'h2', started_at: '2026-01-02T10:00:00.000Z' });

		for (const payload of PAYLOADS) {
			const sqls: string[] = [];
			const overrides = recordingDb(sqls);
			const p = encodeURIComponent(payload);

			// Every query-string parameter that reaches a statement, with the payload in it.
			await asOperator(`/api/objects?host=${p}&q=${p}&pattern=${p}&sort=${p}&limit=2&history=1`, overrides);
			await asOperator(`/api/runs?host=${p}`, overrides);
			await asOperator(`/api/runs/detail?id=${encodeURIComponent('1' + payload)}`, overrides);
			await asOperator(`/api/issues?host=${p}`, overrides);
			await asOperator(`/api/rules?hostId=${p}`, overrides);
			// And the write paths that take a value in the body.
			await postJson('/api/shares/revoke', { token: payload }, overrides);
			await postJson('/api/rules', { pattern: payload, hostId: payload, note: payload }, overrides);
			await postJson('/api/hosts/delete', { id: payload }, overrides);
			await postJson('/api/objects/importance', { id: runId, important: true }, overrides);

			expect(sqls.length, `no statement was recorded for ${payload}`).toBeGreaterThan(0);
			for (const sql of sqls) {
				expect(sql, `statement text carried a request value: ${sql}`).not.toContain('OR 1=1');
				expect(sql, `statement text carried a request value: ${sql}`).not.toContain('DROP TABLE');
				expect(sql, `statement text carried a request value: ${sql}`).not.toContain('UNION SELECT');
				expect(sql, `statement text carried a request value: ${sql}`).not.toContain(payload);
			}
		}
	});

	it('has the documented constant statement shapes, so the conditional SQL is not value-driven', async () => {
		await addRun();
		const sqls: string[] = [];
		await asOperator('/api/runs?host=h1', recordingDb(sqls));
		await asOperator('/api/runs', recordingDb(sqls));

		// The two shapes `/api/runs` can take: the interpolation there is a fixed conditional clause, not a
		// value. Both appear, each with the value as a placeholder.
		expect(sqls.some((s) => s.includes('FROM collection_runs WHERE host_id = ? ORDER BY started_at DESC LIMIT 50')), `recorded: ${sqls.join(' | ')}`).toBe(true);
		expect(sqls.some((s) => s.includes('FROM collection_runs  ORDER BY started_at DESC LIMIT 50')), `recorded: ${sqls.join(' | ')}`).toBe(true);
	});

	it('a hostile host value selects nothing rather than everything', async () => {
		await addObject({ path: '/etc/config.yaml' });
		await addObject({ host: 'h2', path: '/etc/other.yaml' });
		await addRun();
		await addRun({ host_id: 'h2', started_at: '2026-01-02T10:00:00.000Z' });

		// The unfiltered reads see rows, so the zeros below mean the filter worked rather than the tables
		// being empty.
		expect(((await (await asOperator('/api/objects')).json()) as any).total).toBe(2);
		expect(((await (await asOperator('/api/runs')).json()) as any).runs.length).toBe(2);

		for (const payload of PAYLOADS) {
			const p = encodeURIComponent(payload);
			const objects = (await (await asOperator(`/api/objects?host=${p}&q=${p}`)).json()) as any;
			const runs = (await (await asOperator(`/api/runs?host=${p}`)).json()) as any;
			const issues = (await (await asOperator(`/api/issues?host=${p}`)).json()) as any;
			const rules = (await (await asOperator(`/api/rules?hostId=${p}`)).json()) as any;

			expect(objects.total, `objects for host=${payload}`).toBe(0);
			expect(runs.runs.length, `runs for host=${payload}`).toBe(0);
			expect(issues.issues.length, `issues for host=${payload}`).toBe(0);
			expect(rules.rules.length, `rules for hostId=${payload}`).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------------------------
// Hypothesis 3 — the /api/runs IN clause
// ---------------------------------------------------------------------------------------------

describe('hypothesis 3: the IN clause built from ids.map(() => "?")', () => {
	beforeEach(bootstrap);

	it('returns an empty list rather than an empty IN () when there are no runs', async () => {
		// `IN ()` is a syntax error, so the guard around the clause is what this pins down.
		const res = await asOperator('/api/runs');
		const body = (await res.json()) as any;
		expect(res.status).toBe(200);
		expect(body.runs).toEqual([]);
	});

	it('never asks for more runs than its own page bound, so the IN list cannot grow without limit', async () => {
		for (let i = 0; i < 60; i++) {
			await addRun({ started_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z` });
		}
		const body = (await (await asOperator('/api/runs')).json()) as any;
		// 50 rows is also the ceiling on how many bound parameters the issue query can be given: D1 allows
		// 100 per query, and the page bound leaves half of that unused.
		expect(body.runs.length, 'runs returned from 60 stored').toBe(50);
	});

	it('binds the run ids instead of pasting them into the statement', async () => {
		const ids = [await addRun(), await addRun({ started_at: '2026-01-02T10:00:00.000Z' }), await addRun({ started_at: '2026-01-03T10:00:00.000Z' })];
		const sqls: string[] = [];
		await asOperator('/api/runs', recordingDb(sqls));

		const inClause = sqls.find((s) => s.includes('run_id IN'));
		expect(inClause, `no IN statement was recorded; recorded: ${sqls.join(' | ')}`).toBeDefined();
		// One placeholder per id, and not one digit of an id in the text — a pasted id would be a number.
		expect(inClause).toBe(`SELECT * FROM collection_issues WHERE run_id IN (${ids.map(() => '?').join(',')})`);
		expect(inClause, `statement text: ${inClause}`).not.toMatch(/\d/);
	});

	it('is not reachable with a caller-controlled list: the ids come from the database', async () => {
		// Nothing feeds the IN list. `?host=` only ever replaces the bound value in the runs query, which is
		// asserted here by asking with a list-shaped "host" and still getting the empty result that bound
		// value deserves.
		await addRun();
		const body = (await (await asOperator(`/api/runs?host=${encodeURIComponent('1,2,3,4,5')}`)).json()) as any;
		expect(body.runs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// Hypothesis 4 — a crafted host or q producing a leaking error
// ---------------------------------------------------------------------------------------------

describe('hypothesis 4: a crafted host or q causing an error that leaks schema or data', () => {
	beforeEach(bootstrap);

	it('treats a NUL byte in any browse parameter as a value, not as a statement error', async () => {
		await addObject({ path: '/etc/config.yaml' });
		const queries = ['?host=a%00b', '?host=%00', '?q=%00', '?q=a%00b', '?pattern=%00', '?pattern=/etc%00', '?sort=%00', '?limit=%00'];

		for (const query of queries) {
			const res = await asOperator(`/api/objects${query}`);
			const text = await res.text();
			expect(res.status, `GET /api/objects${query} answered ${res.status} with: ${text}`).toBe(200);
			expect(text, `body for ${query}: ${text}`).not.toMatch(/SQLITE|syntax error|"stack"/i);
		}
	});

	it('still answers the last search term that fits the platform LIKE limit', async () => {
		// The `q` value becomes `%<q>%`, so 48 characters is exactly the 50-byte ceiling D1 documents.
		await addObject({ path: '/etc/config.yaml' });
		const res = await asOperator(`/api/objects?q=${encodeURIComponent('a'.repeat(48))}`);
		expect(res.status, `a 48-character search term answered ${res.status}`).toBe(200);
	});

	it('returns nothing rather than a 500 for a 49-character search term', async () => {
		// Measured boundary: 48 characters pass (pattern 50 bytes), 49 fail (pattern 51 bytes). The value is
		// a bound parameter, so nothing here is injection — but the LIKE pattern the Worker builds from
		// ordinary input exceeds the platform's documented ceiling, and every search term of 49 bytes or
		// more takes the objects page down with a 500 instead of returning no match.
		await addObject({ path: '/etc/config.yaml' });
		const res = await asOperator(`/api/objects?q=${encodeURIComponent('a'.repeat(49))}`);
		const text = await res.text();
		expect(res.status, `a 49-character search term answered ${res.status} with: ${text}`).toBe(200);
	});

	it('returns nothing rather than a 500 for a 50-character path pattern', async () => {
		// Same ceiling through the other parameter: `pattern=` has no `*`, so it gains one trailing `%`.
		await addObject({ path: '/etc/config.yaml' });
		const res = await asOperator(`/api/objects?pattern=${encodeURIComponent('/' + 'a'.repeat(49))}`);
		const text = await res.text();
		expect(res.status, `a 50-character path pattern answered ${res.status} with: ${text}`).toBe(200);
	});

	it('does not answer a failing browse request with a stack trace naming its own source files', async () => {
		await addObject({ path: '/etc/config.yaml' });
		const res = await asOperator(`/api/objects?q=${encodeURIComponent('a'.repeat(49))}`);
		const text = await res.text();
		expect(text, `body: ${text}`).not.toMatch(/"stack"|src\/index|src\/browse/i);
	});

	it('does not answer an unauthenticated browse request with a stack', async () => {
		const res = await call('/api/objects?host=x&q=y');
		const text = await res.text();
		expect(res.status, `unauthenticated browse answered ${res.status}`).toBe(401);
		expect(text, `401 body: ${text}`).not.toMatch(/"stack"|src\/index/i);
	});

	it('answers a malformed share token as a dead link, not with an internal error', async () => {
		// The token is decoded with `decodeURIComponent`, which throws on a malformed percent escape. The
		// route is unauthenticated, so whatever is in the body is readable by anyone.
		const res = await call('/s/%E0%A4%A');
		const text = await res.text();
		expect(res.status, `GET /s/%E0%A4%A answered ${res.status} with: ${text}`).toBe(404);
		expect(text, `body: ${text}`).not.toMatch(/"stack"|URI malformed|src\/index/);
	});
});

// ---------------------------------------------------------------------------------------------
// Hypothesis 5 — an unescaped LIKE pattern
// ---------------------------------------------------------------------------------------------

describe('hypothesis 5: LIKE patterns and the escaping of % and _', () => {
	beforeEach(bootstrap);

	it('escapes both wildcards and the escape character itself', () => {
		const { params } = buildObjectQuery({ search: 'a_b%c\\d' });
		const term = params.find((p) => String(p).includes('a'));
		expect(String(term), `bound search term: ${String(term)}`).toBe('%a\\_b\\%c\\\\d%');
	});

	it('a literal underscore is a character, not a single-character wildcard', async () => {
		await addObject({ path: '/var/log/a_b.log' });
		await addObject({ path: '/var/log/axb.log' });

		const body = (await (await asOperator(`/api/objects?q=${encodeURIComponent('a_b')}`)).json()) as any;
		// Unescaped, `_` matches any single character and this returns both rows.
		expect(body.total, `q=a_b matched: ${body.objects.map((o: any) => o.path).join(', ')}`).toBe(1);
		expect(body.objects[0].path).toBe('/var/log/a_b.log');
	});

	it('a literal percent in a pattern is a character, not a match-everything wildcard', async () => {
		await addObject({ path: '/data/100%done' });
		await addObject({ path: '/data/1000done' });

		const body = (await (await asOperator(`/api/objects?pattern=${encodeURIComponent('/data/100%')}`)).json()) as any;
		// Unescaped, `%` matches anything and `1000done` is returned too.
		expect(body.total, `pattern=/data/100% matched: ${body.objects.map((o: any) => o.path).join(', ')}`).toBe(1);
		expect(body.objects[0].path).toBe('/data/100%done');
	});

	it('a wildcard in a pattern is the only thing that widens the match', async () => {
		await addObject({ path: '/data/100%done' });
		await addObject({ path: '/data/1000done' });

		const body = (await (await asOperator(`/api/objects?pattern=${encodeURIComponent('/data/100*')}`)).json()) as any;
		expect(body.total, `pattern=/data/100* matched: ${body.objects.map((o: any) => o.path).join(', ')}`).toBe(2);
	});
});

// ---------------------------------------------------------------------------------------------
// Hypothesis 6 — unbounded reads
// ---------------------------------------------------------------------------------------------

describe('hypothesis 6: reads with no bound on how many rows come back', () => {
	beforeEach(bootstrap);

	it('bounds the share list, which the API lets grow without limit', async () => {
		const objectId = await addObject({ path: '/etc/config.yaml' });

		// Three shares through the real route, so the growth is a repeated ordinary request and not a
		// fixture artefact.
		for (let i = 0; i < 3; i++) {
			const res = await postJson('/api/shares', { objectId });
			expect(res.status, `creating share ${i}`).toBe(200);
		}
		// The rest seeded directly: one request per share is not what is under test here.
		const seeded = 250;
		for (let i = 3; i < seeded; i++) {
			await env.DB.prepare(
				`INSERT INTO shares (token, object_id, expires_at, created_at, use_count) VALUES (?, ?, '2027-01-01T00:00:00.000Z', ?, 0)`,
			)
				.bind(`seeded-token-${i}`, objectId, '2026-01-01T00:00:00.000Z')
				.run();
		}

		const stored = await countOf('shares');
		expect(stored, 'shares actually in the table').toBe(seeded);

		const body = (await (await asOperator('/api/shares')).json()) as any;
		// The read returned every stored row: there is no LIMIT, so the response grows with the table.
		expect(body.shares.length, `the share list returned ${body.shares.length} of ${stored} stored rows`).toBe(stored);
		expect(body.shares.length, 'the share list must bound its result set').toBeLessThan(stored);
	});

	it('bounds the rule list, which grows by one row per accepted rule', async () => {
		// Five rules through the real route, to show the table grows by repeating an ordinary request.
		for (let i = 0; i < 5; i++) {
			const res = await postJson('/api/rules', { pattern: `/var/log/rule-${i}/*.log` });
			expect(res.status, `creating rule ${i}`).toBe(200);
		}
		const seeded = 250;
		for (let i = 5; i < seeded; i++) {
			await env.DB.prepare('INSERT INTO source_rules (host_id, pattern, is_exclude, enabled, created_at) VALUES (NULL, ?, 0, 1, ?)')
				.bind(`/var/log/seeded-${i}/*.log`, '2026-01-01T00:00:00.000Z')
				.run();
		}

		const stored = await countOf('source_rules');
		expect(stored, 'rules actually in the table').toBe(seeded);

		const body = (await (await asOperator('/api/rules')).json()) as any;
		expect(body.rules.length, `the rule list returned ${body.rules.length} of ${stored} stored rows`).toBe(stored);
		expect(body.rules.length, 'the rule list must bound its result set').toBeLessThan(stored);
	});

	it('bounds one run’s issue list the way /api/issues bounds its own', async () => {
		// `/api/issues` caps itself at 200 for a stated reason; the detail read for a single run has no such
		// cap, so the same data read two ways has two different bounds.
		const runId = await addRun();
		const seeded = 300;
		for (let i = 0; i < seeded; i++) {
			await addIssue(runId, { path: `/var/log/f-${i}.log`, created_at: `2026-01-01T10:01:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` });
		}

		const detail = (await (await asOperator(`/api/runs/detail?id=${runId}`)).json()) as any;
		const flat = (await (await asOperator('/api/issues')).json()) as any;
		expect(flat.issues.length, 'the flat issue read is capped at 200').toBe(200);
		expect(detail.run.issues.length, `one run's issue list returned ${detail.run.issues.length} rows`).toBeLessThanOrEqual(200);
	});

	it('bounds how many object rows the usage calculation reads', async () => {
		// The usage response is bounded (totals), but the read behind it is not: `storageObjects` selects
		// every row of `objects` and `measureStorage` sums them in the Worker.
		const seeded = 300;
		for (let i = 0; i < seeded; i++) {
			await addObject({ path: `/bulk/f-${i}`, size: 1 });
		}
		expect(await countOf('objects')).toBe(seeded);

		const sqls: string[] = [];
		await asOperator('/api/usage', recordingDb(sqls));
		const usage = sqls.find((s) => s.includes('FROM objects o'));
		expect(usage, `no usage statement was recorded; recorded: ${sqls.join(' | ')}`).toBeDefined();
		expect(usage, `usage statement: ${usage}`).toMatch(/LIMIT/i);
	});
});
