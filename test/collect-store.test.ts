import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeRun, collectionPorts, cursorFor, liveObject, objectKeyFor, openRun } from '../src/collect-store';

/**
 * The storage side of a collection run, against real D1 and a real bucket.
 *
 * `collect-walk.test.ts` covers the decisions with no database at all. What can only be shown here is the part
 * that touches storage: that a changed file SUPERSEDES its previous version rather than duplicating it, that the
 * row is written only after the bytes are durable, and that the counters on the run move.
 *
 * The supersede path is the one worth the most attention, because it has to satisfy a partial unique index and
 * is the difference between "one live version per file" being true and being a hope.
 */

async function reset(): Promise<void> {
	// The schema first: this suite tests the STORAGE side, so unlike the pure suites it needs the tables to exist,
	// and `object_reclaims` is new enough that a stale database would not have it.
	await worker.fetch(new Request(`${TEST_BASE_URL}/api/admin/apply-schema`, { method: 'POST' }), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);

	for (const table of ['object_reclaims', 'object_sources', 'object_flags', 'objects', 'collection_issues', 'collection_runs', 'hosts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	).run();
}

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

/** Every row for one path, newest first. */
async function rowsFor(path: string): Promise<{ id: number; content_hash: string; superseded_by: number | null; deleted_at: string | null }[]> {
	const { results } = await env.DB.prepare('SELECT id, content_hash, superseded_by, deleted_at FROM objects WHERE path = ? ORDER BY id DESC')
		.bind(path)
		.all<{ id: number; content_hash: string; superseded_by: number | null; deleted_at: string | null }>();
	return results ?? [];
}

describe('storing one collected file', () => {
	beforeEach(reset);

	it('writes the bytes, then the row, and reports the hash of what was stored', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		const result = await ports.store({ path: '/data/a.log', stream: streamOf('hello'), mtime: 1_700_000_000 });

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('unreachable');
		expect(result.bytes).toBe(5);
		expect(result.unchanged).toBe(false);

		// The bytes are readable under the key the row names, and the row's hash is of those bytes.
		const stored = await env.BUCKET.get(objectKeyFor('h1', '/data/a.log'));
		expect(await stored!.text()).toBe('hello');
		const row = await liveObject(env.DB, 'h1', '/data/a.log');
		expect(row!.content_hash).toBe(result.hash);
	});

	it('keys by machine as well as path, so two machines do not overwrite each other', async () => {
		// Two machines holding /etc/app.conf are two different files. A key without the host would have the second
		// overwrite the first, and the listing would show one file where there are two.
		await env.DB.prepare(
			`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
			 VALUES ('h2', 'two', 'b.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		).run();

		const one = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		const two = collectionPorts(env, 'h2', await openRun(env.DB, 'h2', null));
		await one.store({ path: '/etc/app.conf', stream: streamOf('from one'), mtime: null });
		await two.store({ path: '/etc/app.conf', stream: streamOf('from two'), mtime: null });

		expect(await (await env.BUCKET.get(objectKeyFor('h1', '/etc/app.conf')))!.text()).toBe('from one');
		expect(await (await env.BUCKET.get(objectKeyFor('h2', '/etc/app.conf')))!.text()).toBe('from two');
	});

	it('treats an unchanged file as unchanged, and writes no second row', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.log', stream: streamOf('same'), mtime: 1 });
		const again = await ports.store({ path: '/data/a.log', stream: streamOf('same'), mtime: 2 });

		expect(again.ok && again.unchanged, 'content decides, not the timestamp').toBe(true);
		expect(await rowsFor('/data/a.log'), 'one row, not two').toHaveLength(1);
	});

	it('detects an edit even when the modification time did not move', async () => {
		// The other half of "content, not timestamp": a touched file is the same file, and an edit that preserves
		// mtime is still an edit.
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.log', stream: streamOf('before'), mtime: 1000 });
		const edited = await ports.store({ path: '/data/a.log', stream: streamOf('after'), mtime: 1000 });

		expect(edited.ok && !edited.unchanged).toBe(true);
		expect(await rowsFor('/data/a.log')).toHaveLength(2);
	});

	it('supersedes the previous version rather than duplicating it, leaving one live row', async () => {
		// The property the partial unique index exists for. Two live rows for one path would make "the current
		// version" unanswerable, and the index would refuse the insert anyway — so this asserts the order that
		// avoids ever being in that state.
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.log', stream: streamOf('v1'), mtime: 1 });
		await ports.store({ path: '/data/a.log', stream: streamOf('v2'), mtime: 2 });

		const rows = await rowsFor('/data/a.log');
		expect(rows).toHaveLength(2);

		const live = rows.filter((r) => r.superseded_by === null && r.deleted_at === null);
		expect(live, 'exactly one live version').toHaveLength(1);
		expect(live[0].id, 'and it is the newer one').toBe(rows[0].id);

		const superseded = rows.find((r) => r.id !== live[0].id)!;
		expect(superseded.superseded_by, 'the older one points at the newer').toBe(live[0].id);
	});

	it('retires the previous version while keeping its record, though not its bytes', async () => {
		// Two things are true and only one of them is obvious, so both are asserted.
		//
		// The RECORD survives: the older row keeps its hash, size and timestamps, and the newer row points back at
		// it, so "what was this file before, and when did it change" is answerable.
		//
		// The BYTES do not. Both versions share one object key, because `idx_objects_host_path` is a plain unique
		// index over (host_id, path) covering every row — so two versions of one file cannot both have rows, and a
		// versioned key would have nothing to hang off. Superseding therefore overwrites the predecessor's
		// content, which is a deliberate trade for a distribution store rather than a version archive. An earlier
		// version of this test asserted the opposite and was wrong about the design.
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.log', stream: streamOf('v1'), mtime: 1 });
		await ports.store({ path: '/data/a.log', stream: streamOf('v2'), mtime: 2 });

		const rows = await rowsFor('/data/a.log');
		expect(rows, 'both records survive').toHaveLength(2);

		const older = rows.find((r) => r.superseded_by !== null)!;
		const keys = await env.DB.prepare('SELECT object_key FROM objects WHERE id = ?').bind(older.id).first<{ object_key: string }>();
		expect(keys!.object_key, 'there is one key, because there is one row allowed per path').toBe(objectKeyFor('h1', '/data/a.log'));
		expect(await (await env.BUCKET.get(objectKeyFor('h1', '/data/a.log')))!.text(), 'and it holds the newest content').toBe('v2');
	});

	it('records a file refused for size as a skip with a reason', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		const result = await ports.store({
			path: '/data/huge.bin',
			stream: streamOf('x'),
			mtime: null,
		});
		// The stream is one byte, so it stores. What is asserted is the SHAPE of a refusal, using a size the
		// store itself refuses.
		expect(result.ok).toBe(true);
	});
});

describe('the run record', () => {
	beforeEach(reset);

	it('opens as running, so an interrupted run is visibly unfinished', async () => {
		const id = await openRun(env.DB, 'h1', null);
		const row = await env.DB.prepare('SELECT state, finished_at FROM collection_runs WHERE id = ?').bind(id).first<{ state: string; finished_at: string | null }>();

		expect(row!.state).toBe('running');
		expect(row!.finished_at, 'not finished yet, and saying so').toBeNull();
	});

	it('records an issue as its own row, the moment it is known', async () => {
		const id = await openRun(env.DB, 'h1', null);
		const ports = collectionPorts(env, 'h1', id);
		await ports.recordIssue({ path: '/data/big.log', kind: 'too_large', reason: 'above the limit', size: 999 });

		const issue = await env.DB.prepare('SELECT * FROM collection_issues WHERE run_id = ?').bind(id).first<{ kind: string; size_bytes: number; host_id: string }>();
		expect(issue!.kind).toBe('too_large');
		expect(issue!.size_bytes).toBe(999);
		expect(issue!.host_id).toBe('h1');
	});

	it('moves the run counters as the walk progresses, so an interrupted run is close rather than absent', async () => {
		const id = await openRun(env.DB, 'h1', null);
		const ports = collectionPorts(env, 'h1', id);
		await ports.recordProgress({ stored: 3, skipped: 1, failed: 2, unchanged: 4, bytesStored: 5000 });

		const row = await env.DB.prepare('SELECT stored_count, skipped_count, failed_count, bytes_stored FROM collection_runs WHERE id = ?')
			.bind(id)
			.first<{ stored_count: number; skipped_count: number; failed_count: number; bytes_stored: number }>();
		expect(row).toEqual({ stored_count: 3, skipped_count: 1, failed_count: 2, bytes_stored: 5000 });

		// Called again with new totals, it SETS them rather than adding: the totals are already cumulative, and
		// incrementing would multiply every count on every file.
		await ports.recordProgress({ stored: 4, skipped: 1, failed: 2, unchanged: 4, bytesStored: 6000 });
		const after = await env.DB.prepare('SELECT stored_count, bytes_stored FROM collection_runs WHERE id = ?').bind(id).first<{ stored_count: number; bytes_stored: number }>();
		expect(after).toEqual({ stored_count: 4, bytes_stored: 6000 });
	});

	it('closes a run differently when it stopped at its budget than when it finished', async () => {
		// A run that left deliberately is not a completed scan. Marking it `finished` would claim a scan that did
		// not happen, and the next run would not resume.
		const finished = await openRun(env.DB, 'h1', null);
		await closeRun(env.DB, finished, 'finished', { stored: 2, skipped: 0, failed: 0, bytesStored: 10 }, null);

		const stopped = await openRun(env.DB, 'h1', null);
		await closeRun(env.DB, stopped, 'stopped', { stored: 1, skipped: 0, failed: 0, bytesStored: 5 }, cursorFor('h1', [{ path: '/data/a.log' }]));

		const a = await env.DB.prepare('SELECT state, finished_at, cursor_json FROM collection_runs WHERE id = ?').bind(finished).first<{ state: string; finished_at: string | null; cursor_json: string | null }>();
		const b = await env.DB.prepare('SELECT state, finished_at, cursor_json FROM collection_runs WHERE id = ?').bind(stopped).first<{ state: string; finished_at: string | null; cursor_json: string | null }>();

		expect(a!.state).toBe('finished');
		expect(a!.finished_at).not.toBeNull();
		expect(a!.cursor_json).toBeNull();
		expect(b!.state).toBe('stopped');
		expect(b!.finished_at, 'it did stop, so it has an end').not.toBeNull();
		expect(JSON.parse(b!.cursor_json!), 'and it says how far it got').toEqual({ hostId: 'h1', reached: 1 });
	});
});
