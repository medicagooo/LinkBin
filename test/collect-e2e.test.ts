import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RemoteEntry, RemoteHost } from '../src/remote';

/**
 * A whole collection, through the HTTP edge, with a substituted remote.
 *
 * This is the test ticket 05 asks for by name, and the reason `TEST_REMOTE` exists. Nothing here needs a host, a
 * network or a credential, and what it proves is the thing no unit test can: that the pieces are wired to each
 * other — route to walk to storage to the interface the operator reads.
 *
 * The substitute is a machine whose files are declared in the test. It is not a mock of the collection logic;
 * it is a stand-in for the far end of an SSH connection, which is the only part that genuinely cannot be
 * simulated locally.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';

/** A machine with the given files per directory, reporting sizes and bytes as a real one would. */
function machine(dirs: Record<string, { name: string; content?: string; size?: number; mtime?: number; isDirectory?: boolean }[]>): RemoteHost {
	const find = (path: string) => {
		for (const [dir, entries] of Object.entries(dirs)) {
			for (const entry of entries) {
				if (`${dir}/${entry.name}` === path) return { dir, entry };
			}
		}
		return null;
	};

	return {
		async list(dir: string): Promise<RemoteEntry[]> {
			if (!(dir in dirs)) throw new Error(`cannot open directory '${dir}': No such file or directory`);
			return dirs[dir].map((f) => ({
				name: f.name,
				size: f.size ?? (f.content ?? '').length,
				mtime: f.mtime ?? 1_700_000_000,
				isDirectory: f.isDirectory ?? false,
			}));
		},
		async stat(path: string) {
			const found = find(path);
			// A file that is gone by the time it is asked about — a rotated log — which the walk must record
			// rather than crash on.
			if (!found) throw new Error(`cannot stat '${path}': No such file or directory`);
			const f = found.entry;
			return { size: f.size ?? (f.content ?? '').length, mtime: f.mtime ?? 1_700_000_000, isDirectory: f.isDirectory ?? false };
		},
		async read(path: string) {
			const found = find(path);
			if (!found || found.entry.content === undefined) throw new Error(`cannot open '${path}': No such file or directory`);
			const content = found.entry.content;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(content));
					controller.close();
				},
			});
		},
		async exec() {
			return 'FakeOS 1.0';
		},
	};
}

function call(path: string, init?: RequestInit, remote?: RemoteHost): Promise<Response> {
	const target: Record<string, unknown> = { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY };
	if (remote) target.TEST_REMOTE = remote;
	return worker.fetch(new Request(`${BASE}${path}`, init), target as never, {} as never);
}

let cookie = '';

async function reset(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['object_reclaims', 'object_sources', 'object_flags', 'objects', 'collection_issues', 'collection_runs', 'source_rules', 'shares', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await env.DB.prepare("DELETE FROM hosts WHERE id != '@derived'").run();

	// THE BUCKET TOO, and leaving this out caused a real misdiagnosis. Only the database was cleared, so objects
	// stored by earlier tests in this file stayed in the bucket — and since almost every test here stores to
	// `/var/log/a.log`, a later assertion about what is under that key was reading another test's residue. The
	// symptom looked exactly like the code writing an object with no row for it; the cause was the fixture.
	const left = await env.BUCKET.list({ prefix: 'objects/' });
	if (left.objects.length) await env.BUCKET.delete(left.objects.map((o) => o.key));

	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('web-01', 'web-01', 'web-01.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	).run();

	const setup = await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	if (setup.status !== 200) throw new Error(`setup failed: ${await setup.text()}`);
	const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	cookie = /(linkbin_session=[^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
}

async function addRule(pattern: string, isExclude = false): Promise<void> {
	await env.DB.prepare('INSERT INTO source_rules (host_id, pattern, is_exclude, enabled, created_at) VALUES (NULL, ?, ?, 1, ?)')
		.bind(pattern, isExclude ? 1 : 0, '2026-01-01T00:00:00.000Z')
		.run();
}

async function collect(remote?: RemoteHost): Promise<{ status: number; body: any }> {
	const res = await call('/api/collect', { method: 'POST', headers: { cookie } }, remote);
	return { status: res.status, body: await res.json() };
}

/** The stored row for one path, or null. */
async function stored(path: string): Promise<{ id: number; size_bytes: number; content_hash: string; mtime: number | null; object_key: string; superseded_by: number | null } | null> {
	return await env.DB.prepare('SELECT id, size_bytes, content_hash, mtime, object_key, superseded_by FROM objects WHERE host_id = ? AND path = ? AND deleted_at IS NULL AND superseded_by IS NULL')
		.bind('web-01', path)
		.first<{ id: number; size_bytes: number; content_hash: string; mtime: number | null; object_key: string; superseded_by: number | null }>();
}

async function issuesFor(runId: number): Promise<{ path: string | null; kind: string; reason: string }[]> {
	const { results } = await env.DB.prepare('SELECT path, kind, reason FROM collection_issues WHERE run_id = ? ORDER BY id').bind(runId).all<{ path: string | null; kind: string; reason: string }>();
	return results ?? [];
}

async function runRow(runId: number): Promise<{ state: string; stored_count: number; skipped_count: number; failed_count: number; finished_at: string | null }> {
	return (await env.DB.prepare('SELECT state, stored_count, skipped_count, failed_count, finished_at FROM collection_runs WHERE id = ?').bind(runId).first())!;
}

describe('a first collection', () => {
	beforeEach(reset);

	it('stores a matching file with its size, hash and modification time', async () => {
		await addRule('/var/log/*.log');
		const { status, body } = await collect(machine({ '/var/log': [{ name: 'app.log', content: 'hello world', mtime: 1_700_000_123 }] }));

		expect(status).toBe(200);
		expect(body.run).toBe(true);
		expect(body.totals.stored).toBe(1);
		expect(body.totals.bytesStored).toBe(11);

		const row = await stored('/var/log/app.log');
		expect(row, 'the file is recorded').not.toBeNull();
		expect(row!.size_bytes).toBe(11);
		expect(row!.content_hash, 'a real hash of the bytes').toMatch(/^[0-9a-f]{64}$/);
		expect(row!.mtime, 'in whole seconds, the unit the machine reports').toBe(1_700_000_123);
		expect(await (await env.BUCKET.get(row!.object_key))!.text()).toBe('hello world');
	});

	it('shows the stored file under the machine and path it came from, with both times', async () => {
		// The interface reads this, so the property is asserted through the route rather than from the table.
		//
		// TWO times, and the distinction is the point of the second one: `createdAt` is when this store took the
		// file, `mtime` is when the MACHINE last changed it. A file stored a month ago and unchanged since is
		// current; one stored an hour ago from a machine that has since rewritten it is not. Reporting only the
		// first would make every file look its age in the store rather than its age at the source.
		await addRule('/var/log/*.log');
		await collect(machine({ '/var/log': [{ name: 'app.log', content: 'x', mtime: 1_700_000_123 }] }));

		const listed = (await (await call('/api/objects', { headers: { cookie } })).json()) as {
			objects: { hostId: string; path: string; mtime: number | null; createdAt: string }[];
		};
		expect(listed.objects.map((o) => `${o.hostId}:${o.path}`)).toEqual(['web-01:/var/log/app.log']);
		expect(listed.objects[0].mtime, 'the machine\'s own time, in whole seconds').toBe(1_700_000_123);
		expect(Number.isFinite(Date.parse(listed.objects[0].createdAt)), 'and when this store took it').toBe(true);
	});

	it('stores nothing new on a second run, and reports that nothing changed', async () => {
		// An incremental scan. The second run must not duplicate, and must not record an issue either: not
		// changing is the normal case, and recording it would turn the issue list into a log of everything.
		await addRule('/var/log/*.log');
		const remote = machine({ '/var/log': [{ name: 'app.log', content: 'unchanged' }] });

		const first = await collect(remote);
		const second = await collect(remote);

		expect(first.body.totals.stored).toBe(1);
		expect(second.body.totals.stored, 'nothing new stored').toBe(0);
		expect(second.body.totals.unchanged, 'and it says so').toBe(1);
		expect(await issuesFor(second.body.runId), 'an unchanged file is not a problem').toEqual([]);

		const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM objects WHERE path = '/var/log/app.log'").all<{ n: number }>();
		expect(Number(results![0].n), 'one row, not two').toBe(1);
	});

	it('re-transfers nothing when a file is touched but not changed', async () => {
		// Content decides, not the timestamp. A `touch` is the most common thing that happens to a log file.
		await addRule('/var/log/*.log');
		await collect(machine({ '/var/log': [{ name: 'app.log', content: 'same', mtime: 1000 }] }));
		const second = await collect(machine({ '/var/log': [{ name: 'app.log', content: 'same', mtime: 9999 }] }));

		expect(second.body.totals.stored).toBe(0);
		expect(second.body.totals.unchanged).toBe(1);
	});

	it('detects an edit even when the modification time did not move', async () => {
		await addRule('/var/log/*.log');
		await collect(machine({ '/var/log': [{ name: 'app.log', content: 'before', mtime: 1000 }] }));
		const second = await collect(machine({ '/var/log': [{ name: 'app.log', content: 'after', mtime: 1000 }] }));

		expect(second.body.totals.stored).toBe(1);
	});

	it('supersedes a changed file rather than duplicating it', async () => {
		await addRule('/var/log/*.log');
		await collect(machine({ '/var/log': [{ name: 'app.log', content: 'v1' }] }));
		await collect(machine({ '/var/log': [{ name: 'app.log', content: 'v2' }] }));

		const live = await stored('/var/log/app.log');
		expect(live, 'one live version').not.toBeNull();
		expect(await (await env.BUCKET.get(live!.object_key))!.text(), 'holding the newest content').toBe('v2');

		const older = await env.DB.prepare("SELECT superseded_by FROM objects WHERE path = '/var/log/app.log' AND superseded_by IS NOT NULL").first<{ superseded_by: number }>();
		expect(older, 'the previous version is recorded as replaced').not.toBeNull();
		expect(older!.superseded_by).toBe(live!.id);
	});
});

describe('what is not collected', () => {
	beforeEach(reset);

	it('records a capacity refusal as an issue naming capacity, so a full store has an answer', async () => {
		// Ticket 07's last criterion, and it could not be met until now: `collection_issues.run_id` is a NOT NULL
		// foreign key to a run, so a capacity refusal had nowhere to be written until collection created runs.
		// "Why did this stop syncing" now has an answer that names capacity rather than going silent.
		//
		// The store is filled by claiming large sizes rather than by writing gigabytes: the budget arithmetic reads
		// `size_bytes`, and the refusal happens before any read, so what is being tested does not need real bytes.
		await env.BUCKET.put('objects/web-01/filler', new TextEncoder().encode('x'));
		await env.DB.prepare(
			`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
			 VALUES ('web-01', '/filler', 'objects/web-01/filler', ?, 'filler', '2026-01-01T00:00:00.000Z')`,
		)
			.bind(10 * 1024 * 1024 * 1024 - 10)
			.run();

        const held = await env.DB.prepare("SELECT id FROM objects WHERE path = '/filler'").first<{id:number}>();
        await env.DB.prepare("INSERT INTO object_flags (object_id,important,created_at) VALUES (?,1,'2020-01-01')").bind(held!.id).run();
		await addRule('/var/log/*.log');
		const body = (await collect(machine({ '/var/log': [{ name: 'app.log', content: 'x', size: 1000 }] }))).body;

		expect(body.totals.stored, 'nothing was stored, because there was no room').toBe(0);
		expect(body.totals.failed).toBe(1);

		const issues = await issuesFor(body.runId);
		expect(issues).toHaveLength(1);
		expect(issues[0].kind, 'capacity is its own kind, so it reads as a reason and not as a failure to diagnose').toBe('capacity');
		expect(issues[0].reason).toMatch(/budget/i);
	});

	it('does not request the bytes of a file refused for capacity', async () => {
		// The same read-counting argument as the size skip: a refusal that happens after a transfer has already
		// cost the transfer, and on a metered machine that is the difference that matters.
		await env.BUCKET.put('objects/web-01/filler', new TextEncoder().encode('x'));
		await env.DB.prepare(
			`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
			 VALUES ('web-01', '/filler', 'objects/web-01/filler', ?, 'filler', '2026-01-01T00:00:00.000Z')`,
		)
			.bind(10 * 1024 * 1024 * 1024 - 10)
			.run();

        const held = await env.DB.prepare("SELECT id FROM objects WHERE path = '/filler'").first<{id:number}>();
        await env.DB.prepare("INSERT INTO object_flags (object_id,important,created_at) VALUES (?,1,'2020-01-01')").bind(held!.id).run();
		await addRule('/var/log/*.log');
		let reads = 0;
		const base = machine({ '/var/log': [{ name: 'app.log', content: 'x', size: 1000 }] });
		const watched: RemoteHost = {
			...base,
			async read(path: string) {
				reads += 1;
				return base.read(path);
			},
		};

		await collect(watched);
		expect(reads, 'the bytes were never requested').toBe(0);
	});

	it('does not collect a file matching no rule', async () => {
		await addRule('/var/log/*.log');
		const body = (await collect(machine({ '/var/log': [{ name: 'app.log', content: 'x' }], '/etc': [{ name: 'passwd', content: 'secret' }] }))).body;

		expect(body.totals.stored).toBe(1);
		expect(await stored('/etc/passwd'), 'nothing outside the rules').toBeNull();
	});

	it('does not collect a file an exclusion matches, even when an inclusion does too', async () => {
		// The single worst outcome this configuration can produce, so it is asserted at the edge rather than only
		// in the rules unit tests.
		await addRule('/var/log/*.log');
		await addRule('/var/log/secret.log', true);
		const body = (await collect(machine({ '/var/log': [{ name: 'app.log', content: 'fine' }, { name: 'secret.log', content: 'do not take' }] }))).body;

		expect(body.totals.stored).toBe(1);
		expect(await stored('/var/log/app.log')).not.toBeNull();
		expect(await stored('/var/log/secret.log'), 'the excluded file was not collected').toBeNull();
	});

	it('collects more than fifty files, which is the display cap and not a work limit', async () => {
		// `resolveRules` caps the names it REPORTS at 50 for a preview's benefit, and `filesToCollect` consumes
		// those names. Using the display default here would have collected the first 50 and reported success.
		await addRule('/var/log/*.log');
		const files = Array.from({ length: 120 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.log`, content: `line ${i}` }));

		const body = (await collect(machine({ '/var/log': files }))).body;
		expect(body.totals.stored).toBe(120);

		const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM objects').all<{ n: number }>();
		expect(Number(results![0].n)).toBe(120);
	});
});

describe('a machine that is not well', () => {
	beforeEach(reset);

	it('records a machine error in the machine\'s own words and still ends the run', async () => {
		await addRule('/secret/*.log');
		const body = (await collect(machine({ '/var/log': [] }))).body;

		expect(body.run).toBe(true);
		const issues = await issuesFor(body.runId);
		expect(issues).toHaveLength(1);
		expect(issues[0].kind).toBe('rule_unreadable');
		expect(issues[0].reason, 'the machine\'s own words are kept').toContain('No such file or directory');

		// The run still finishes, so the receipt exists and the rotation moves on.
		const row = await runRow(body.runId);
		expect(row.state).toBe('finished');
		expect(row.failed_count).toBe(1);
	});

	it('records a file that vanished between discovery and reading, without failing the rest', async () => {
		// A rotated log. The listing still shows it and the read does not, which is the real sequence.
		await addRule('/var/log/*.log');
		const base = machine({ '/var/log': [{ name: 'gone.log', content: 'x' }, { name: 'ok.log', content: 'fine' }] });
		const racing: RemoteHost = {
			...base,
			async read(path: string) {
				if (path.endsWith('gone.log')) throw new Error(`cannot open '${path}': No such file or directory`);
				return base.read(path);
			},
		};

		const body = (await collect(racing)).body;

		expect(body.totals.stored, 'the other file was still collected').toBe(1);
		expect(body.totals.failed).toBe(1);
		expect(await stored('/var/log/ok.log')).not.toBeNull();

		const issues = await issuesFor(body.runId);
		expect(issues.map((i) => i.path)).toEqual(['/var/log/gone.log']);
	});

	it('handles a file whose size the machine does not report, without treating it as empty', async () => {
		// An unreported size is unknown, not zero. Storing a zero-byte object for a file with content is silent
		// data loss, and the stream is what actually decides.
		await addRule('/var/log/*.log');
		const base = machine({ '/var/log': [{ name: 'odd.log', content: 'has content' }] });
		const sizeless: RemoteHost = { ...base, async stat() { return { isDirectory: false }; } };

		const body = (await collect(sizeless)).body;
		expect(body.totals.stored).toBe(1);

		const row = await stored('/var/log/odd.log');
		expect(row!.size_bytes, 'the real length, read from the stream').toBe(11);
		expect(await (await env.BUCKET.get(row!.object_key))!.text()).toBe('has content');
	});
});

describe('the receipt a run leaves', () => {
	beforeEach(reset);

	it('records the run with its machine, counts and an end time', async () => {
		await addRule('/var/log/*.log');
		const body = (await collect(machine({ '/var/log': [{ name: 'a.log', content: 'x' }, { name: 'b.log', content: 'yy' }] }))).body;

		const row = await runRow(body.runId);
		expect(row.state).toBe('finished');
		expect(row.finished_at, 'a finished run has an end').not.toBeNull();
		expect(row.stored_count).toBe(2);
		expect(row.failed_count).toBe(0);

		// And it is visible through the route the interface reads.
		const listed = (await (await call('/api/runs', { headers: { cookie } })).json()) as { runs: { id: number; storedCount: number }[] };
		expect(listed.runs[0].id).toBe(body.runId);
	});

	it('records nothing as an issue for files that were stored', async () => {
		await addRule('/var/log/*.log');
		const body = (await collect(machine({ '/var/log': [{ name: 'a.log', content: 'x' }, { name: 'b.log', content: 'y' }] }))).body;
		expect(await issuesFor(body.runId), 'an issue list is a list of problems').toEqual([]);
	});

	it('leaves no live row behind for a file whose bytes never made it', async () => {
		// The one unrecoverable state would be a row claiming a file that was never stored, because nothing
		// distinguishes it from a file that was stored and then evicted. The read fails here, so no row may exist.
		await addRule('/var/log/*.log');
		const base = machine({ '/var/log': [{ name: 'a.log', content: 'x' }] });
		const broken: RemoteHost = {
			...base,
			async read() {
				throw new Error('the connection dropped');
			},
		};

		await collect(broken);
		expect(await stored('/var/log/a.log'), 'no row, and no bytes either').toBeNull();

		const listing = await env.BUCKET.list({ prefix: 'objects/web-01/var/log/a.log' });
		expect(listing.objects, 'and nothing in the bucket under that key').toHaveLength(0);
	});
});
