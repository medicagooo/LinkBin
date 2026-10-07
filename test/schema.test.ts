import { env } from 'cloudflare:test';
import worker from '../src/index';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The schema bootstrap, exercised through the Worker's request/response edge.
 *
 * The Worker's own `fetch` handler is called directly rather than through a real network: there is
 * no network in these tests, and a plain `fetch()` to a synthetic host resolves to nothing. Calling
 * the handler with a `Request` is the same entry point the platform invokes, so the behaviour under
 * test is the deployed behaviour.
 *
 * These assert on the real database rather than on the bootstrap's own summary: a route that
 * cheerfully reports "13 statements applied" while creating nothing would pass a test that trusted
 * the report, and that is exactly the class of bug this file exists to catch.
 */

const BASE = 'https://linkbin.test';

/** Calls the Worker the way the platform does. */
function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), env as never, {} as never);
}

async function schemaObjects(): Promise<string[]> {
	const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all<{
		name: string;
	}>();
	return (results ?? []).map((r) => r.name);
}

async function applySchema(): Promise<{ status: number; body: any }> {
	const res = await call('/api/admin/apply-schema', { method: 'POST' });
	return { status: res.status, body: await res.json() };
}

describe('schema bootstrap', () => {
	beforeAll(async () => {
		const { status, body } = await applySchema();
		// Surface the route's own explanation on failure; a bare status code hides the cause, and this
		// assertion is the first thing that runs.
		expect(status, `apply-schema failed: ${JSON.stringify(body)}`).toBe(200);
	});

	it('creates the tables the product needs', async () => {
		const names = await schemaObjects();
		for (const table of ['hosts', 'source_rules', 'objects', 'multipart_sessions']) {
			expect(names, `missing table ${table}`).toContain(table);
		}
	});

	it('creates the receipts tables, so a run and its problems have somewhere to live', async () => {
		const names = await schemaObjects();
		expect(names).toContain('collection_runs');
		expect(names).toContain('collection_issues');
	});

	it('creates the index the storage-budget measurement depends on', async () => {
		const names = await schemaObjects();
		expect(names).toContain('idx_objects_usage');
	});

	it('is safe to run again: a second application changes nothing and still succeeds', async () => {
		const before = (await schemaObjects()).sort();
		const second = await applySchema();
		expect(second.status, `second apply failed: ${JSON.stringify(second.body)}`).toBe(200);
		expect((await schemaObjects()).sort()).toEqual(before);
	});

	it('reports the objects it actually created rather than a made-up count', async () => {
		const { body } = await applySchema();
		expect(body.ok).toBe(true);
		expect(body.objects).toContain('collection_runs');
		expect(body.objects).toContain('objects');
	});

	it('reports whether the schema is present, and names what is missing when it is not', async () => {
		const res = await call('/api/status');
		const body: any = await res.json();
		expect(body.schema.ready).toBe(true);
		expect(body.schema.missing).toEqual([]);
	});
});

describe('objects can be marked important', () => {
	beforeAll(async () => {
		await applySchema();
	});

	it('is not important until it is marked, so protection is opted into rather than accidental', async () => {
		await env.DB.prepare(
			`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
			 VALUES ('imp-a', 'a', 'host.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		).run();

		await env.DB.prepare(
			`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
			 VALUES ('imp-a', '/etc/a', 'k/a', 10, 'hash-a', '2026-01-01T00:00:00Z')`,
		).run();

		const flagged = await env.DB.prepare('SELECT * FROM object_flags').all();
		expect(flagged.results?.length).toBe(0);
	});

	it('can be set and cleared again', async () => {
		const row = await env.DB.prepare('SELECT id FROM objects WHERE object_key = ?').bind('k/a').first<{ id: number }>();
		expect(row?.id).toBeTypeOf('number');

		// Presence of a row is the flag, so setting it twice must not fail and clearing it removes it.
		await env.DB.prepare('INSERT OR REPLACE INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)')
			.bind(row!.id, '2026-01-01T00:00:00Z')
			.run();
		let flagged = await env.DB.prepare('SELECT * FROM object_flags WHERE object_id = ?').bind(row!.id).first();
		expect(flagged).not.toBeNull();

		await env.DB.prepare('INSERT OR REPLACE INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)')
			.bind(row!.id, '2026-01-01T00:00:00Z')
			.run();
		flagged = await env.DB.prepare('SELECT * FROM object_flags WHERE object_id = ?').bind(row!.id).first();
		expect(flagged).not.toBeNull();

		await env.DB.prepare('DELETE FROM object_flags WHERE object_id = ?').bind(row!.id).run();
		flagged = await env.DB.prepare('SELECT * FROM object_flags WHERE object_id = ?').bind(row!.id).first();
		expect(flagged).toBeNull();
	});
});

describe('stored objects are traceable to what produced them', () => {
	beforeAll(async () => {
		await applySchema();
	});

	it('records a derivation for a derived object', async () => {
		// A derived object is one whose content came from other objects rather than from a machine.
		// Which objects it came from has to be recorded, or "is this still current" is unanswerable.
		await env.DB.prepare(
			`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
			 VALUES ('imp-a', '/merged.yaml', 'k/merged', 42, 'hash-merged', '2026-01-01T00:00:00Z')`,
		).run();
		const target = await env.DB.prepare('SELECT id FROM objects WHERE object_key = ?').bind('k/merged').first<{ id: number }>();
		expect(target?.id).toBeTypeOf('number');

		await env.DB.prepare(
			`INSERT INTO object_sources (object_id, source_object_id, source_hash)
			 VALUES (?, 1, 'hash-a')`,
		)
			.bind(target!.id)
			.run();

		const sources = await env.DB.prepare('SELECT * FROM object_sources WHERE object_id = ?').bind(target!.id).all();
		expect(sources.results?.length).toBe(1);
	});
});
