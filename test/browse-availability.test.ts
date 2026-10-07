import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Whether a listed file can actually be downloaded.
 *
 * The row in the database and the bytes in the bucket can disagree, and when they do the row wins the listing:
 * eviction reclaims bytes while deliberately keeping the row, because the row is what makes "this file existed
 * and was removed to make room" answerable. So a list built from rows alone offers downloads that cannot
 * happen, and the click produces a 404 — a worse answer than saying so up front.
 *
 * The three states are the point, and there are three rather than two: not checked, present, and gone.
 * Collapsing "not checked" into "gone" would mark every file unavailable on an ordinary listing.
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
}

/** A row with its bytes actually stored. */
async function addPresent(path: string): Promise<number> {
	const key = `objects/h1${path}`;
	await env.BUCKET.put(key, new TextEncoder().encode('the stored bytes'));
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', ?, ?, 16, 'hash', '2026-01-01T00:00:00.000Z')`,
	)
		.bind(path, key)
		.run();
	return Number(result.meta.last_row_id);
}

/** A row whose bytes are NOT there — a record of a file that has been reclaimed. */
async function addEvicted(path: string): Promise<number> {
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', ?, ?, 16, 'hash', '2026-01-01T00:00:00.000Z')`,
	)
		.bind(path, `objects/h1${path}`)
		.run();
	return Number(result.meta.last_row_id);
}

/** A row at a chosen time, optionally with its bytes stored, so the ordering under test is deliberate. */
async function addAt(path: string, at: string, present: boolean): Promise<number> {
	const key = `objects/h1${path}`;
	if (present) await env.BUCKET.put(key, new TextEncoder().encode('the stored bytes'));
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', ?, ?, 16, 'hash', ?)`,
	)
		.bind(path, key, at)
		.run();
	return Number(result.meta.last_row_id);
}

type Listing = { objects: { id: number; bytesPresent?: boolean; live: boolean }[]; total: number };

async function browse(query: string): Promise<Listing> {
	const res = await call(`/api/objects?${query}`, { headers: { cookie } });
	if (res.status !== 200) throw new Error(`browse answered ${res.status}: ${await res.text()}`);
	return (await res.json()) as Listing;
}

describe('a file whose bytes were reclaimed', () => {
	beforeEach(reset);

	it('reports an evicted file as not present when asked to verify', async () => {
		const present = await addPresent('/data/here.txt');
		const evicted = await addEvicted('/data/gone.txt');

		const listing = await browse('verify=1');
		const byId = new Map(listing.objects.map((o) => [o.id, o]));

		expect(byId.get(present)?.bytesPresent, 'a stored file is present').toBe(true);
		expect(byId.get(evicted)?.bytesPresent, 'a file with no bytes is not present').toBe(false);
	});

	it('leaves the answer absent when verification was not asked for', async () => {
		// The distinction that matters: absent means "not checked". A listing that reported `false` here would
		// mark every file in the store as no longer stored — the opposite of the truth.
		const id = await addPresent('/data/here.txt');
		const listing = await browse('limit=10');

		const row = listing.objects.find((o) => o.id === id);
		expect(row).toBeDefined();
		expect('bytesPresent' in row!, 'unverified rows must not claim either answer').toBe(false);
	});

	it('still lists the evicted row, because the record outlives the bytes', async () => {
		// Deliberately kept in the list. Removing it would answer "was this ever collected" with silence, and
		// the row is what makes that question answerable after eviction.
		const evicted = await addEvicted('/data/gone.txt');
		const listing = await browse('verify=1');
		expect(listing.objects.some((o) => o.id === evicted)).toBe(true);
		expect(listing.total).toBe(1);
	});

	it('verifies every row on the page, not only the first', async () => {
		// A check applied to one row and not the rest would look right in a single-file test and be wrong for
		// every real store.
		const ids: number[] = [];
		for (let n = 0; n < 6; n++) ids.push(await addPresent(`/data/here${n}.txt`));
		ids.push(await addEvicted('/data/gone.txt'));

		const listing = await browse('verify=1&limit=10');
		expect(listing.objects).toHaveLength(7);
		expect(listing.objects.every((o) => o.bytesPresent !== undefined), 'every row carries an answer').toBe(true);

		const gone = listing.objects.filter((o) => o.bytesPresent === false);
		expect(gone.map((o) => o.id)).toEqual([ids[6]]);
	});

	it('verifies the right page when an offset is used', async () => {
		// Explicit timestamps rather than arrival order: the default sort is newest first, and two rows sharing a
		// timestamp are ordered by the id tie-break, so "the second one added" is not necessarily the second row.
		// An earlier version of this test asserted arrival order and failed with 12 vs 13 for exactly that reason.
		const first = await addAt('/data/a.txt', '2026-01-01T00:00:00.000Z', true);
		const second = await addAt('/data/b.txt', '2026-01-02T00:00:00.000Z', false);

		// Newest first: page one is b (evicted), page two is a (present).
		const pageOne = await browse('verify=1&limit=1&offset=0');
		expect(pageOne.objects[0].id).toBe(second);
		expect(pageOne.objects[0].bytesPresent, 'page one answers about its own row').toBe(false);

		const pageTwo = await browse('verify=1&limit=1&offset=1');
		expect(pageTwo.objects[0].id).toBe(first);
		expect(pageTwo.objects[0].bytesPresent).toBe(true);
	});
});
