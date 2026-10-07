import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Reclaiming room through the interface, against a real database and a real bucket.
 *
 * The policy and the execution are tested in `budget.test.ts` and `evict.test.ts`. What only an integration test
 * shows is that the two are wired to each other: that the row the policy chose is the row whose BYTES were
 * removed, that the removal is visible to the listing and to the budget afterwards, and that a protected file
 * survives a request that asked for it to be sacrificed.
 *
 * ## Two sizes, deliberately different
 *
 * The **stored** files are recorded as GiB while holding a few real bytes: the budget arithmetic reads
 * `size_bytes` and the deletions act on the object key, so the two are independent, and a test that wrote 10 GB
 * to reach a boundary would not run.
 *
 * The **requested** size stays under the 100 MB per-file cap, because that cap applies to what is being admitted
 * and is refused before any reclaiming is considered. An earlier version of these tests asked for 2 GiB and got a
 * perfectly correct 400 — the fixture was wrong, not the route.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';
const CEILING = 10 * 1024 * 1024 * 1024;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
/** Above the stored ceiling, so a store can be made full with three rows rather than ten thousand. */
const BIG = 4 * GiB;
/**
 * A file size that fills most of the ceiling, so a second one overflows it.
 *
 * The tests need the store to be genuinely FULL before reclaiming is even considered — `planAdmission` admits
 * anything that fits and evicts nothing, so a fixture below the ceiling tests the no-op path and looks like a
 * broken route. Two earlier versions of these tests used 8 GiB of a 10 GiB ceiling and asserted evictions that
 * correctly never happened. `expectFull` below is what stops that being possible again.
 */
const NEARLY_ALL = 6 * GiB;

/**
 * Asserts the store really is at or over its ceiling before a reclaim is attempted.
 *
 * Called in every test that expects an eviction, because the failure mode is silent: a fixture that leaves room
 * makes the route correctly do nothing, and the assertion that follows looks like a bug in the code rather than
 * in the setup.
 */
async function expectFull(): Promise<void> {
	const u = await usage();
	if (u.totalBytes <= CEILING) {
		throw new Error(`the fixture is not full: ${u.totalBytes} held of a ${CEILING} ceiling, so nothing would be reclaimed`);
	}
}

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
	for (const table of ['derived_objects', 'derived_rules', 'object_sources', 'object_reclaims', 'object_flags', 'shares', 'objects', 'auth_attempts', 'auth_secret']) {
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

/** A stored file: a row claiming `claimedBytes`, and real bytes in the bucket. */
async function addFile(name: string, claimedBytes: number, at: string, important = false): Promise<number> {
	const key = `objects/h1${name}`;
	await env.BUCKET.put(key, new TextEncoder().encode('real bytes'));
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', ?, ?, ?, 'hash', ?)`,
	)
		.bind(name, key, claimedBytes, at)
		.run();
	const id = Number(result.meta.last_row_id);
	if (important) {
		await env.DB.prepare('INSERT OR REPLACE INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)')
			.bind(id, at)
			.run();
	}
	return id;
}

async function usage(): Promise<{ totalBytes: number; remainingBytes: number; saturatedByImportant: boolean; maxFileBytes: number }> {
	const res = await call('/api/usage', { headers: { cookie } });
	if (res.status !== 200) throw new Error(`usage answered ${res.status}`);
	return ((await res.json()) as { usage: never }).usage;
}

type Reclaim = {
	ok: boolean;
	admitted: boolean;
	evicted: number[];
	evictedCount: number;
	freedBytes: number;
	saturatedByImportant: boolean;
	error?: string;
	before: { totalBytes: number };
	after: { totalBytes: number };
};

async function reclaim(sizeBytes: unknown): Promise<{ status: number; body: Reclaim }> {
	const res = await post('/api/usage/reclaim', { sizeBytes }, cookie);
	return { status: res.status, body: (await res.json()) as Reclaim };
}

async function bytesPresent(id: number): Promise<boolean> {
	const row = await env.DB.prepare('SELECT object_key FROM objects WHERE id = ?').bind(id).first<{ object_key: string }>();
	if (!row) return false;
	return (await env.BUCKET.head(row.object_key)) !== null;
}

async function deletedAt(id: number): Promise<string | null> {
	const row = await env.DB.prepare('SELECT deleted_at FROM objects WHERE id = ?').bind(id).first<{ deleted_at: string | null }>();
	return row?.deleted_at ?? null;
}

describe('the store refusing new files', () => {
	beforeEach(reset);

	it('evicts the oldest unprotected file, and reclaims both the bytes and the record', async () => {
		const oldest = await addFile('/data/old.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z');
		const newer = await addFile('/data/new.txt', NEARLY_ALL, '2026-02-01T00:00:00.000Z');

		// 12 GiB held against a 10 GiB ceiling, and 50 MiB wanted: the oldest single file covers it many times over.
		await expectFull();
		const { status, body } = await reclaim(50 * MiB);

		expect(status).toBe(200);
		expect(body.admitted).toBe(true);
		expect(body.evicted, 'the oldest, and only the oldest').toEqual([oldest]);
		expect(body.freedBytes).toBe(NEARLY_ALL);

		// BOTH halves reclaimed. Marking the record without removing the bytes would leave capacity charged
		// against a budget that believes it was freed, which is the failure the step order exists to avoid.
		expect(await bytesPresent(oldest), 'the bytes were removed').toBe(false);
		expect(await deletedAt(oldest), 'the record was marked rather than deleted').not.toBeNull();
		expect(await bytesPresent(newer), 'the newer file is untouched').toBe(true);
		expect(await deletedAt(newer)).toBeNull();

		// The record survives, because the row is what makes "this file existed and was removed" answerable.
		const row = await env.DB.prepare('SELECT id FROM objects WHERE id = ?').bind(oldest).first();
		expect(row, 'the row is kept').not.toBeNull();

		// And the budget sees the space as free. Without the reclaimed mark the store would report itself full
		// forever after the first eviction — space freed and the figure never noticing.
		expect(body.after.totalBytes).toBe(NEARLY_ALL);
	});

	it('reclaims nothing when the file already fits', async () => {
		const only = await addFile('/data/one.txt', 1 * MiB, '2026-01-01T00:00:00.000Z');

		const { status, body } = await reclaim(1 * MiB);

		expect(status).toBe(200);
		expect(body.evicted).toEqual([]);
		expect(body.freedBytes).toBe(0);
		expect(await bytesPresent(only), 'nothing was touched').toBe(true);
	});

	it('never evicts a file marked important, even when it is the oldest and the only candidate', async () => {
		// The property this whole ticket is built around. Failing closed is the choice: refusing new files is
		// visible and recoverable, and deleting a protected file is neither.
		const protectedOldest = await addFile('/data/keep.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z', true);
		await addFile('/data/keep2.txt', NEARLY_ALL, '2026-02-01T00:00:00.000Z', true);

		// 12 GiB held, all of it protected, and 50 MiB wanted.
		await expectFull();
		const { status, body } = await reclaim(50 * MiB);

		expect(status, 'a refusal, not a deletion').toBe(409);
		expect(body.admitted).toBe(false);
		expect(body.evicted).toEqual([]);
		expect(body.saturatedByImportant, 'and it says why, because unmarking is the fix').toBe(true);

		expect(await bytesPresent(protectedOldest), 'the protected file still has its bytes').toBe(true);
		expect(await deletedAt(protectedOldest), 'and is still live').toBeNull();
	});

	it('takes the unprotected files and leaves the protected one', async () => {
		const protectedOld = await addFile('/data/keep.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z', true);
		const spare = await addFile('/data/spare.txt', NEARLY_ALL, '2026-02-01T00:00:00.000Z');

		// 12 GiB held, 50 MiB wanted. Taking the spare covers it, and the protected file was never a candidate
		// however old it is.
		await expectFull();
		const { status, body } = await reclaim(50 * MiB);

		expect(status).toBe(200);
		expect(body.evicted).toEqual([spare]);
		expect(await bytesPresent(protectedOld), 'the protected file was never touched').toBe(true);
		expect(await bytesPresent(spare)).toBe(false);
	});

	it('refuses without deleting when reclaiming could not have helped', async () => {
		const file = await addFile('/data/keep.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z', true);
		await addFile('/data/keep2.txt', NEARLY_ALL, '2026-02-01T00:00:00.000Z');
		await expectFull();

		// Larger than the whole budget, so no amount of reclaiming admits it. Deleting would lose data for a file
		// that is refused either way.
		const { status, body } = await reclaim(CEILING + 1);

		expect(status).toBe(400);
		expect(await bytesPresent(file), 'nothing was deleted for a file that can never be admitted').toBe(true);
	});

	it('refuses a file above the per-file limit before reclaiming anything', async () => {
		// The per-file cap is checked first on purpose: it cannot be solved by making room, so reclaiming for it
		// would delete files for a file that is refused regardless.
		const file = await addFile('/data/one.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z');
		await addFile('/data/two.txt', NEARLY_ALL, '2026-02-01T00:00:00.000Z');
		await expectFull();

		const { status } = await reclaim(200 * MiB);

		expect(status).toBe(400);
		expect(await bytesPresent(file), 'nothing was deleted for a file that can never be admitted').toBe(true);
	});

	it('reports the per-file limit and the budget rather than only enforcing them', async () => {
		const u = await usage();
		expect(u.maxFileBytes).toBe(100 * 1024 * 1024);
		expect(u.totalBytes).toBe(0);
	});

	it('counts what is retained, not only what is live', async () => {
		// A superseded version still occupies the bucket and is still charged. A figure counting only live objects
		// could pass the ceiling while the real total was over it.
		const old = await addFile('/data/config.yaml.old', 5 * GiB, '2026-01-01T00:00:00.000Z');
		const replacement = await addFile('/data/config.yaml', 1 * GiB, '2026-02-01T00:00:00.000Z');
		await env.DB.prepare('UPDATE objects SET superseded_by = ? WHERE id = ?').bind(replacement, old).run();

		expect((await usage()).totalBytes, 'both versions count').toBe(6 * GiB);
	});

	it('requires a session, because it deletes', async () => {
		const file = await addFile('/data/one.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z');

		const anonymous = await post('/api/usage/reclaim', { sizeBytes: 50 * MiB });
		expect(anonymous.status).toBe(401);
		expect(await bytesPresent(file), 'and it deleted nothing').toBe(true);
	});

	it('rejects a nonsense size rather than treating it as zero', async () => {
		const file = await addFile('/data/one.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z');
		for (const size of [-1, 'abc', Number.NaN]) {
			const { status } = await reclaim(size);
			expect(status, `size ${String(size)} must be refused`).toBe(400);
		}
		expect(await bytesPresent(file), 'and nothing was deleted').toBe(true);
	});

	it('makes an evicted file report itself as no longer stored in the listing', async () => {
		// The two features have to agree. Eviction removes the bytes and keeps the row, so the browse view has to
		// stop offering a download; otherwise the operator sees a file listed as available whose every click fails.
		//
		// This is the wiring that makes the previous round's availability check more than a safety net: it now has
		// a real producer.
		const oldest = await addFile('/data/old.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z');
		await addFile('/data/new.txt', NEARLY_ALL, '2026-02-01T00:00:00.000Z');
		await expectFull();

		await reclaim(50 * MiB);

		// Asserted through the route that would actually serve a download, rather than through the listing:
		// `buildObjectQuery` excludes deleted files UNCONDITIONALLY — "a deleted file has no bytes to serve, so
		// listing it would offer a download that cannot happen" — and an evicted file is exactly that. So the
		// correct behaviour is that it disappears from the list, and asking `?verify=1` about a row that is not
		// there would test nothing.
		const res = await call('/api/objects?history=1', { headers: { cookie } });
		const listing = (await res.json()) as { objects: { id: number }[] };
		expect(listing.objects.some((o) => o.id === oldest), 'an evicted file is not offered as downloadable').toBe(false);

		// The ROW is still there, which is what makes "this file existed and was removed to make room" answerable.
		const row = await env.DB.prepare('SELECT id, deleted_at FROM objects WHERE id = ?').bind(oldest).first<{ id: number; deleted_at: string | null }>();
		expect(row, 'the record outlives the bytes').not.toBeNull();
		expect(row!.deleted_at).not.toBeNull();
	});

	it('does not count an evicted file against the budget after the fact', async () => {
		// The check that the reclaim loop actually moves the number the policy reads. Counting a reclaimed row
		// would have the store report itself full forever after one eviction.
		const oldest = await addFile('/data/old.txt', NEARLY_ALL, '2026-01-01T00:00:00.000Z');
		const kept = await addFile('/data/new.txt', NEARLY_ALL, '2026-02-01T00:00:00.000Z');
		await expectFull();

		await reclaim(50 * MiB);

		expect((await usage()).totalBytes, 'only the surviving file is held').toBe(NEARLY_ALL);
		expect(await bytesPresent(kept)).toBe(true);
		expect(await bytesPresent(oldest)).toBe(false);
	});

	it('keeps a soft-deleted file charged, because its bytes are still there', async () => {
		// The distinction the reclaims table exists for, asserted from the outside. A soft-deleted row has been
		// asked to go but nothing removed it, so it still occupies the bucket and must still be counted.
		// Excluding it would report room that does not exist.
		const soft = await addFile('/data/soft.txt', 2 * GiB, '2026-01-01T00:00:00.000Z');
		await env.DB.prepare("UPDATE objects SET deleted_at = '2026-03-01T00:00:00.000Z' WHERE id = ?").bind(soft).run();

		expect(await bytesPresent(soft), 'the bytes are still in the bucket').toBe(true);
		expect((await usage()).totalBytes, 'so it is still charged').toBe(2 * GiB);
	});
});
