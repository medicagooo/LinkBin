import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The derived-object routes: creating a rule, previewing it, running it, and the staleness question.
 *
 * These exercise the boundary the two pure modules were shaped around, so what is being checked is mostly that
 * the wiring passes the right rows and writes the right records — the decisions themselves are covered in
 * `derived.test.ts` and `merge.test.ts`.
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
	// Real machines only. The `@derived` sentinel is created by migration 0004 and deleting it would test a
	// state the product never has — the row exists on every deployment the moment the schema is applied.
	for (const table of ['derived_objects', 'derived_rules', 'object_sources', 'object_flags', 'shares', 'objects', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await env.DB.prepare("DELETE FROM hosts WHERE id != '@derived'").run();

	const setup = await post('/api/auth/setup', { password: PASSWORD });
	if (setup.status !== 200) throw new Error(`setup failed with ${setup.status}: ${await setup.text()}`);
	const login = await post('/api/auth/login', { password: PASSWORD });
	const setCookie = login.headers.get('set-cookie') ?? '';
	// The whole `linkbin_session=<token>` pair, not just the token: the `cookie` header is what the Worker reads,
	// and passing a bare token produces a 401 that looks like an authorisation bug rather than a fixture mistake.
	cookie = /(linkbin_session=[^;]+)/.exec(setCookie)?.[1] ?? '';
	if (!cookie) throw new Error(`sign-in produced no session (status ${login.status}, cookie ${setCookie})`);
}

/** A machine holding one or more files, stored in the bucket as well as the table. */
async function addHostWithFiles(hostId: string, files: { path: string; content: string }[]): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES (?, ?, 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	)
		.bind(hostId, hostId)
		.run();

	for (const file of files) {
		const bytes = new TextEncoder().encode(file.content);
		const key = `objects/${hostId}${file.path}`;
		await env.BUCKET.put(key, bytes);
		await env.DB.prepare(
			`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
			 VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
		)
			.bind(hostId, file.path, key, bytes.byteLength, `hash-${hostId}-${file.path}`)
			.run();
	}
}

describe('a merge rule through the interface', () => {
	beforeEach(reset);

	it('is created, listed, and updated in place rather than duplicated', async () => {
		const created = await post('/api/derived', { outputName: 'merged.yaml', combination: 'yaml-list-union', sources: [{ pattern: '/etc/*.yaml' }] }, cookie);
		expect(created.status).toBe(200);
		const first = (await created.json()) as { id: string };
		expect(first.id).toBeTruthy();

		// The same output name again is an edit, because two rules writing one name would give "which is current"
		// no answer.
		const again = await post('/api/derived', { outputName: 'merged.yaml', combination: 'concat', sources: [{ pattern: '/etc/*.yaml' }] }, cookie);
		expect(((await again.json()) as { id: string }).id).toBe(first.id);

		const listed = (await (await call('/api/derived', { headers: { cookie } })).json()) as { rules: { id: string; combination: string }[] };
		expect(listed.rules).toHaveLength(1);
		expect(listed.rules[0].combination).toBe('concat');
	});

	it('refuses a rule that would make a cycle, naming the rules involved', async () => {
		await post('/api/derived', { outputName: 'a.yaml', combination: 'concat', sources: [{ pattern: 'b.yaml' }] }, cookie);
		const cyclic = await post('/api/derived', { outputName: 'b.yaml', combination: 'concat', sources: [{ pattern: 'a.yaml' }] }, cookie);
		expect(cyclic.status).toBe(400);
		expect(await cyclic.text()).toMatch(/cycle/i);
	});

	it('refuses a rule with no sources and one with an unknown combination', async () => {
		expect((await post('/api/derived', { outputName: 'x.yaml', combination: 'concat', sources: [] }, cookie)).status).toBe(400);
		expect((await post('/api/derived', { outputName: 'x.yaml', combination: 'run-code', sources: [{ pattern: '/etc/*' }] }, cookie)).status).toBe(400);
	});

	it('requires a session', async () => {
		expect((await call('/api/derived')).status).toBe(401);
		expect((await post('/api/derived', { outputName: 'x.yaml', combination: 'concat', sources: [{ pattern: '/etc/*' }] })).status).toBe(401);
	});
});

describe('a preview before anything is stored', () => {
	beforeEach(reset);

	it('reports the sources it would take, per pattern, without storing a result', async () => {
		await addHostWithFiles('h1', [
			{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' },
			{ path: '/etc/app/b.yaml', content: 'proxies:\n  - name: q\n' },
		]);

		const res = await post(
			'/api/derived/preview',
			{ outputName: 'merged.yaml', combination: 'yaml-list-union', sources: [{ pattern: '/etc/app/*.yaml' }, { pattern: '/nowhere/*.yaml' }] },
			cookie,
		);
		expect(res.status).toBe(200);
		const preview = ((await res.json()) as { preview: { sourceCount: number; perPattern: { pattern: string; matched: number }[] } }).preview;

		expect(preview.sourceCount).toBe(2);
		// The pattern that matched nothing is named, because a structured merge that removed no duplicates and one
		// that did nothing look identical in the output.
		expect(preview.perPattern.find((p) => p.pattern === '/nowhere/*.yaml')?.matched).toBe(0);

		// Nothing was stored: a preview that wrote a result would not be a preview.
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM objects WHERE host_id = '@derived'").first<{ n: number }>();
		expect(Number(count?.n)).toBe(0);
	});

	it('says a rule matched nothing rather than reporting an empty success', async () => {
		const res = await post('/api/derived/preview', { outputName: 'merged.yaml', combination: 'concat', sources: [{ pattern: '/nowhere/*' }] }, cookie);
		const preview = ((await res.json()) as { preview: { ok: boolean; problem?: string } }).preview;
		expect(preview.ok).toBe(false);
		expect(preview.problem).toMatch(/no stored file matches/i);
	});
});

describe('running a merge', () => {
	beforeEach(reset);

	async function rule(sources: { pattern: string; hostId?: string }[], combination = 'yaml-list-union') {
		const res = await post('/api/derived', { outputName: 'merged.yaml', combination, sources }, cookie);
		return ((await res.json()) as { id: string }).id;
	}

	it('stores the result as an object, records its sources and their hashes, and marks it important', async () => {
		await addHostWithFiles('h1', [
			{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n    port: 1\n' },
			{ path: '/etc/app/b.yaml', content: 'proxies:\n  - name: p\n    port: 1\n  - name: q\n    port: 2\n' },
		]);
		const id = await rule([{ pattern: '/etc/app/*.yaml' }]);

		const res = await post('/api/derived/run', { id }, cookie);
		expect(res.status).toBe(200);
		const result = (await res.json()) as { objectId: number; sourcesRecorded: number; bytes: number; contentHash: string };
		expect(result.sourcesRecorded).toBe(2);
		expect(result.bytes).toBeGreaterThan(0);

		// Stored as a file like any other: the bytes are in the bucket and the row points at them.
		const row = await env.DB.prepare('SELECT object_key, content_hash FROM objects WHERE id = ?').bind(result.objectId).first<{ object_key: string; content_hash: string }>();
		const stored = await env.BUCKET.get(row!.object_key);
		expect(stored).not.toBeNull();
		const text = await stored!.text();
		expect(text).toContain('name: q');
		// The repeated entry is gone: this is a union, not a stack of whole documents.
		expect(text.match(/name: p/g)).toHaveLength(1);

		// IMPORTANT, because the budget never evicts an important object and a derived object whose sources were
		// evicted could never be rebuilt.
		const flag = await env.DB.prepare('SELECT important FROM object_flags WHERE object_id = ?').bind(result.objectId).first<{ important: number }>();
		expect(Number(flag?.important)).toBe(1);

		// The sources and their hashes, which is what makes "what was this built from" answerable.
		const links = await env.DB.prepare('SELECT source_hash FROM object_sources WHERE object_id = ? ORDER BY source_object_id').bind(result.objectId).all<{ source_hash: string }>();
		expect((links.results ?? []).map((l) => l.source_hash)).toEqual(['hash-h1-/etc/app/a.yaml', 'hash-h1-/etc/app/b.yaml']);

		// And the result is an ordinary object, so it browses and shares through the same path with no special case.
		const listed = (await (await call('/api/objects', { headers: { cookie } })).json()) as { objects: { id: number; path: string }[] };
		expect(listed.objects.some((o) => o.id === result.objectId)).toBe(true);
	});

	it('leaves the previous result in place when a re-run cannot read a source', async () => {
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		const id = await rule([{ pattern: '/etc/app/*.yaml' }]);

		const first = await post('/api/derived/run', { id }, cookie);
		expect(first.status).toBe(200);
		const firstResult = (await first.json()) as { objectId: number };

		// The row remains but its key points at nothing: a source reclaimed underneath us. Pointing the key
		// somewhere absent is how the unreadable case is reached reliably — deleting the bucket object alone did
		// NOT reproduce it here, and the source came back as an empty string instead, which is a different
		// refusal on a different path.
		await env.DB.prepare("UPDATE objects SET object_key = 'objects/gone.yaml' WHERE host_id = 'h1'").run();

		const second = await post('/api/derived/run', { id }, cookie);
		expect(second.status).toBe(409);
		expect(await second.text()).toMatch(/could not be read/i);

		// The previous result is untouched, which is the outcome that matters most because a silent replacement
		// with a partial file is the failure mode nobody notices.
		const still = await env.DB.prepare('SELECT content_hash FROM objects WHERE id = ?').bind(firstResult.objectId).first<{ content_hash: string }>();
		expect(still).not.toBeNull();
	});

	it('leaves the previous result in place when a source becomes empty', async () => {
		// The other way a source can stop contributing, and it takes a different path: the bytes ARE readable and
		// are empty, so the engine refuses because every source was empty. Both must preserve the previous result.
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		const id = await rule([{ pattern: '/etc/app/*.yaml' }]);

		const first = await post('/api/derived/run', { id }, cookie);
		expect(first.status).toBe(200);
		const firstResult = (await first.json()) as { objectId: number };

		await env.BUCKET.put('objects/h1/etc/app/a.yaml', new Uint8Array(0));

		const second = await post('/api/derived/run', { id }, cookie);
		expect(second.status).toBe(409);
		expect(await second.text()).toMatch(/empty/i);

		const still = await env.DB.prepare('SELECT content_hash FROM objects WHERE id = ?').bind(firstResult.objectId).first<{ content_hash: string }>();
		expect(still).not.toBeNull();
	});

	it('refuses when nothing matches, and stores nothing', async () => {
		const id = await rule([{ pattern: '/nowhere/*' }]);
		const res = await post('/api/derived/run', { id }, cookie);
		expect(res.status).toBe(409);

		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM objects WHERE host_id = '@derived'").first<{ n: number }>();
		expect(Number(count?.n)).toBe(0);
	});

	it('cannot take its own previous output as a source', async () => {
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		// The pattern is broad enough to match the derived object's own path `/merged.yaml`, so the exclusion of
		// the definition-time cycle check must use these same concrete source paths.
		const defined = await post('/api/derived', { outputName: 'merged.yaml', combination: 'concat', sources: [{ pattern: '/*.yaml' }, { pattern: '/etc/app/*.yaml' }] }, cookie);
		expect(defined.status).toBe(400);
		expect(await defined.text()).toMatch(/cycle/);
	});

	it('replaces its own previous result rather than accumulating a second one', async () => {
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		const id = await rule([{ pattern: '/etc/app/*.yaml' }]);

		await post('/api/derived/run', { id }, cookie);
		await post('/api/derived/run', { id }, cookie);

		// One output name means one file. A second run that left two objects under `/merged.yaml` would break the
		// uniqueness the whole object model rests on.
		const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM objects WHERE host_id = '@derived' AND deleted_at IS NULL").first<{ n: number }>();
		expect(Number(rows?.n), 'a re-run must not leave two results for one output name').toBe(1);
	});
});

describe('whether a stored result is still current', () => {
	beforeEach(reset);

	async function ruleAndRun(): Promise<{ id: string; objectId: number }> {
		const created = await post('/api/derived', { outputName: 'merged.yaml', combination: 'yaml-list-union', sources: [{ pattern: '/etc/app/*.yaml' }] }, cookie);
		const id = ((await created.json()) as { id: string }).id;
		const run = await post('/api/derived/run', { id }, cookie);
		expect(run.status).toBe(200);
		return { id, objectId: ((await run.json()) as { objectId: number }).objectId };
	}

	async function statusOf(): Promise<{ current: boolean | null; sourceCount: number; sources: { path: string }[] }> {
		const listed = (await (await call('/api/derived/status', { headers: { cookie } })).json()) as {
			rules: { current: boolean | null; sourceCount: number; sources: { path: string }[] }[];
		};
		return listed.rules[0];
	}

	it('reports a freshly built result as current, and names the sources it came from', async () => {
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		await ruleAndRun();

		const status = await statusOf();
		expect(status.current).toBe(true);
		expect(status.sourceCount).toBe(1);
		expect(status.sources.map((s) => s.path)).toEqual(['/etc/app/a.yaml']);
	});

	it('reports "not built yet" as null rather than as current or stale', async () => {
		// The three states lead to different actions — build it, leave it, rebuild it — so collapsing "never
		// built" into either of the others would make the interface say something untrue.
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		await post('/api/derived', { outputName: 'merged.yaml', combination: 'yaml-list-union', sources: [{ pattern: '/etc/app/*.yaml' }] }, cookie);

		expect((await statusOf()).current).toBeNull();
	});

	it('goes stale when a source changes content, and says so without rebuilding', async () => {
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		const { objectId } = await ruleAndRun();
		expect((await statusOf()).current).toBe(true);

		// The stored file changes. The derived result is now out of date, and nothing has run since.
		await addHostWithFiles('h1', [{ path: '/etc/app/b.yaml', content: 'proxies:\n  - name: q\n' }]).catch(() => undefined);
		await env.DB.prepare("UPDATE objects SET content_hash = 'changed' WHERE path = '/etc/app/a.yaml'").run();

		const status = await statusOf();
		expect(status.current, 'a changed source must make the result stale').toBe(false);
		expect(status.sourceCount).toBe(1);

		// Stale is a REPORT, not an action: the previously built object is untouched and still downloadable.
		const still = await env.DB.prepare('SELECT deleted_at FROM objects WHERE id = ?').bind(objectId).first<{ deleted_at: string | null }>();
		expect(still?.deleted_at).toBeNull();
	});

	it('goes stale when the rule itself changes', async () => {
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		const { id } = await ruleAndRun();

		// Same output name, different combination: the rule is edited in place, which changes what the result
		// should be without changing any source.
		await post('/api/derived', { outputName: 'merged.yaml', combination: 'concat', sources: [{ pattern: '/etc/app/*.yaml' }] }, cookie);
		void id;

		expect((await statusOf()).current, 'an edited rule must make its previous result stale').toBe(false);
	});

	it('goes stale when a source stops matching the pattern', async () => {
		await addHostWithFiles('h1', [{ path: '/etc/app/a.yaml', content: 'proxies:\n  - name: p\n' }]);
		await ruleAndRun();

		// The file is removed from the store. A result whose inputs have gone is stale, not current — which is
		// exactly the case that recomputing from the sources alone would get wrong.
		await env.DB.prepare("UPDATE objects SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE path = '/etc/app/a.yaml'").run();

		const status = await statusOf();
		expect(status.current, 'a result whose source is gone must not report itself current').toBe(false);
		expect(status.sourceCount).toBe(0);
		// The sources it WAS built from are still named, because "what did this come from" is a fact about the
		// past and stays true after the source is evicted.
		expect(status.sources.map((s) => s.path)).toEqual(['/etc/app/a.yaml']);
	});
});

describe('the machines list', () => {
	beforeEach(reset);

	it('does not offer the derived sentinel as a machine', async () => {
		// The sentinel exists because `objects.host_id` is `NOT NULL REFERENCES hosts (id)`. It is not a machine,
		// so it must not be offered as a target for collection.
		await addHostWithFiles('h1', [{ path: '/etc/a.txt', content: 'x' }]);
		const listed = (await (await call('/api/hosts', { headers: { cookie } })).json()) as { hosts: { id: string }[] };
		expect(listed.hosts.map((h) => h.id)).toEqual(['h1']);
	});
});
