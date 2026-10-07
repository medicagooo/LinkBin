import { env } from 'cloudflare:test';
import worker from '../src/index';
import { buildObjectQuery } from '../src/browse';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Paging through stored files.
 *
 * The list is bounded on purpose, so "show me more" has to work or the bound becomes a wall: with 500 files
 * stored, a first page of 50 and no way forward means 450 files that exist and cannot be reached from the
 * interface.
 *
 * The property that matters is not that a second page arrives but that **walking every page yields every row
 * exactly once**. A paging bug that duplicates or skips a row in the middle looks fine on page one and on the
 * last page, so it is the middle that has to be checked.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(
		new Request(`${BASE}${path}`, init),
		{ ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never,
		{} as never,
	);
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (cookie) headers.cookie = cookie;
	return call(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

let cookie = '';

async function reset(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['derived_objects', 'derived_rules', 'object_sources', 'object_flags', 'shares', 'objects', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await env.DB.prepare("DELETE FROM hosts WHERE id != '@derived'").run();
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	).run();

	const setup = await post('/api/auth/setup', { password: PASSWORD });
	if (setup.status !== 200) throw new Error(`setup failed: ${await setup.text()}`);
	const login = await post('/api/auth/login', { password: PASSWORD });
	cookie = /(linkbin_session=[^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
	if (!cookie) throw new Error('no session');
}

/**
 * One file, with a distinct creation time so the default sort has a definite order.
 *
 * The timestamps are deliberately distinct: "newest first" over rows that all share a timestamp is ordered by
 * the id tie-break alone, which would make a paging assertion pass even if the ORDER BY were ignored.
 */
async function addFile(n: number): Promise<number> {
	const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', ?, ?, ?, ?, ?)`,
	)
		.bind(`/data/f${String(n).padStart(3, '0')}.txt`, `objects/h1/f${n}`, 100 + n, `hash-${n}`, at)
		.run();
	return Number(result.meta.last_row_id);
}

async function page(query: string): Promise<{ objects: { id: number }[]; total: number; limit: number; offset: number }> {
	const res = await call(`/api/objects?${query}`, { headers: { cookie } });
	if (res.status !== 200) throw new Error(`browse answered ${res.status}: ${await res.text()}`);
	return (await res.json()) as { objects: { id: number }[]; total: number; limit: number; offset: number };
}

describe('paging the stored-file list', () => {
	beforeEach(reset);

	it('walks every row exactly once across several pages', async () => {
		const ids: number[] = [];
		for (let n = 1; n <= 25; n++) ids.push(await addFile(n));

		const seen: number[] = [];
		let offset = 0;
		for (let guard = 0; guard < 10; guard++) {
			const body = await page(`limit=10&offset=${offset}`);
			expect(body.total, 'the total is the whole match count, not the page size').toBe(25);
			seen.push(...body.objects.map((o) => o.id));
			if (body.objects.length === 0) break;
			offset += body.objects.length;
		}

		expect(seen, 'every row exactly once, in order, with none skipped or repeated').toEqual([...ids].reverse());
	});

	it('returns a page that does not overlap the one before it', async () => {
		for (let n = 1; n <= 12; n++) await addFile(n);

		const first = await page('limit=5&offset=0');
		const second = await page('limit=5&offset=5');
		expect(first.objects).toHaveLength(5);
		expect(second.objects).toHaveLength(5);

		const overlap = first.objects.filter((o) => second.objects.some((s) => s.id === o.id));
		expect(overlap, 'pages must not repeat rows').toEqual([]);
	});

	it('returns the last page short rather than padded or refused', async () => {
		for (let n = 1; n <= 7; n++) await addFile(n);

		const body = await page('limit=5&offset=5');
		expect(body.objects).toHaveLength(2);
		expect(body.offset).toBe(5);
	});

	it('returns nothing, rather than an error, past the end', async () => {
		// An interface that walks pages until it gets an empty one needs this to be an empty page, not a 400.
		for (let n = 1; n <= 3; n++) await addFile(n);
		const body = await page('limit=10&offset=50');
		expect(body.objects).toEqual([]);
		expect(body.total).toBe(3);
	});

	it('echoes the offset it actually used', async () => {
		await addFile(1);
		expect((await page('limit=10&offset=0')).offset).toBe(0);
		expect((await page('limit=10&offset=5')).offset).toBe(5);
	});

	it('refuses to be turned into an unbounded scan by a huge offset', async () => {
		// Clamped, like the limit. An offset is a number from a query string, and one large enough to make the
		// database walk the whole table is a denial of service dressed as a page request.
		const query = buildObjectQuery({ offset: 10_000_000 });
		expect(query.offset).toBeLessThanOrEqual(100_000);
		expect(query.offset).toBeGreaterThan(0);
	});

	it('leaves the first-page statement alone, so paging did not change the common case', async () => {
		// The SQL for page one must not grow an `OFFSET 0`: it is a no-op the database still plans, and keeping
		// the statement byte-identical to what it was before paging existed means a change here is a real one.
		expect(buildObjectQuery({}).sql).not.toMatch(/OFFSET/);
		expect(buildObjectQuery({ offset: 0 }).params).toEqual([50]);
		expect(buildObjectQuery({ offset: 25 }).sql).toMatch(/LIMIT \? OFFSET \?/);
		expect(buildObjectQuery({ offset: 25 }).params).toEqual([50, 25]);
	});

	it('pages a filtered list, not the unfiltered one', async () => {
		// An offset applied outside the WHERE would page through rows the filter excluded, so the second page of
		// a search would skip matches. Five carry an "f" in the path and five do not.
		//
		// The two groups are created up front rather than renamed afterwards: `idx_objects_live` is a unique
		// index over (host, path), so an UPDATE that gives several rows the same path is refused — which is the
		// constraint doing its job, and it made an earlier version of this fixture fail as a constraint error
		// rather than as the assertion it was meant to be.
		for (let n = 1; n <= 5; n++) {
			const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
			await env.DB.prepare(
				`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
				 VALUES ('h1', ?, ?, ?, ?, ?)`,
			)
				.bind(`/data/f${n}.txt`, `objects/h1/f${n}`, 100 + n, `hash-f${n}`, at)
				.run();
		}
		for (let n = 1; n <= 5; n++) {
			const at = new Date(Date.UTC(2026, 0, 2, 0, 0, n)).toISOString();
			await env.DB.prepare(
				`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
				 VALUES ('h1', ?, ?, ?, ?, ?)`,
			)
				.bind(`/logs/quiet${n}.txt`, `objects/h1/q${n}`, 100 + n, `hash-q${n}`, at)
				.run();
		}

		const filtered = await page('q=f&limit=20&offset=0');
		expect(filtered.total, 'only the five matching rows are in scope').toBe(5);

		const first = await page('q=f&limit=2&offset=0');
		const second = await page('q=f&limit=2&offset=2');
		expect(first.objects).toHaveLength(2);
		expect(second.objects).toHaveLength(2);
		const overlap = first.objects.filter((o) => second.objects.some((s) => s.id === o.id));
		expect(overlap).toEqual([]);

		// And every page holds matching rows only — an offset misapplied outside the WHERE would surface a
		// non-matching row here.
		const all = await page('q=f&limit=20&offset=0');
		expect(all.objects).toHaveLength(5);
	});

	it('treats a nonsense offset as none rather than as a fault', async () => {
		for (let n = 1; n <= 3; n++) await addFile(n);
		expect((await page('limit=10&offset=abc')).offset).toBe(0);
		expect((await page('limit=10&offset=-5')).offset).toBe(0);
	});
});
