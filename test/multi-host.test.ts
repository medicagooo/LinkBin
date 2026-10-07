import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RemoteEntry, RemoteHost } from '../src/remote';

/**
 * Two machines at once.
 *
 * **Every other test in this project collects from ONE host**, so nothing has yet checked the invariant that
 * matters most in a multi-machine store: that a collection of A cannot read, overwrite or evict B's files. The
 * three ways it could go wrong are all silent — a key lacking the host prefix would have the second machine
 * overwrite the first, a query missing its `host_id` filter would list another machine's files as this one's, and
 * a rotation that always picked the same machine would leave the rest permanently stale while reporting success.
 *
 * The key shape is where it would happen first. `objectKeyFor` includes the host deliberately; this is what
 * proves the inclusion is load-bearing rather than decorative.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';

/** A machine serving one directory of text files, with sizes the runtime can judge before reading. */
function machine(files: Record<string, string>): RemoteHost {
	return {
		async list(dir: string): Promise<RemoteEntry[]> {
			const entries = Object.entries(files)
				.filter(([path]) => path.startsWith(`${dir}/`))
				.map(([path, content]) => ({ name: path.slice(dir.length + 1), size: content.length, mtime: 1_700_000_000, isDirectory: false }));
			if (!entries.length) throw new Error(`cannot open directory '${dir}': No such file or directory`);
			return entries;
		},
		async stat(path: string) {
			const content = files[path];
			if (content === undefined) throw new Error(`cannot stat '${path}': No such file or directory`);
			return { size: content.length, mtime: 1_700_000_000, isDirectory: false };
		},
		async read(path: string) {
			const content = files[path];
			if (content === undefined) throw new Error(`cannot open '${path}': No such file or directory`);
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
	for (const table of ['multipart_sessions', 'object_reclaims', 'object_sources', 'object_flags', 'objects', 'collection_issues', 'collection_runs', 'source_rules', 'shares', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await env.DB.prepare("DELETE FROM hosts WHERE id != '@derived'").run();
	for (const id of ['alpha', 'beta']) {
		await env.DB.prepare(
			`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		).bind(id, id, `${id}.invalid`).run();
	}
	// One rule for both machines, so the ONLY thing separating their files is the host.
	await env.DB.prepare('INSERT INTO source_rules (host_id, pattern, is_exclude, enabled, created_at) VALUES (NULL, ?, 0, 1, ?)')
		.bind('/var/log/*.log', '2026-01-01T00:00:00.000Z')
		.run();

	const left = await env.BUCKET.list({ prefix: 'objects/' });
	if (left.objects.length) await env.BUCKET.delete(left.objects.map((o) => o.key));

	const setup = await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	if (setup.status !== 200) throw new Error(`setup failed: ${await setup.text()}`);
	const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	cookie = /(linkbin_session=[^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
}

/** Collects from ONE machine by naming it first in the rotation, then returns the response body. */
async function collect(remote: RemoteHost): Promise<any> {
	const res = await call('/api/collect', { method: 'POST', headers: { cookie } }, remote);
	return await res.json();
}

async function liveRows(): Promise<{ hostId: string; path: string; objectKey: string }[]> {
	const { results } = await env.DB.prepare(
		'SELECT host_id AS hostId, path, object_key AS objectKey FROM objects WHERE deleted_at IS NULL AND superseded_by IS NULL ORDER BY host_id, path',
	).all<{ hostId: string; path: string; objectKey: string }>();
	return results ?? [];
}

describe('two machines holding the same path', () => {
	beforeEach(reset);

	it('stores both, under different keys, without either overwriting the other', async () => {
		// THE DEFECT THIS EXISTS FOR. `objectKeyFor` prefixes the host; if it did not, beta's `/var/log/app.log`
		// would land on alpha's key, the row would be correct while the BYTES belonged to the wrong machine, and
		// nothing would report an error - alpha would simply start serving beta's file.
		await collect(machine({ '/var/log/app.log': 'from alpha' }));
		await collect(machine({ '/var/log/app.log': 'from beta' }));

		const rows = await liveRows();
		expect(rows.map((r) => r.hostId), 'one row per machine').toEqual(['alpha', 'beta']);
		expect(new Set(rows.map((r) => r.objectKey)).size, 'two distinct keys for the same path').toBe(2);

		// And the BYTES, which is the half a row-level assertion would miss.
		const alpha = await env.BUCKET.get(rows.find((r) => r.hostId === 'alpha')!.objectKey);
		const beta = await env.BUCKET.get(rows.find((r) => r.hostId === 'beta')!.objectKey);
		expect(await alpha!.text()).toBe('from alpha');
		expect(await beta!.text()).toBe('from beta');
	});

	it('reports each file against the machine it came from, not just once', async () => {
		// A listing that de-duplicated on path alone would show one entry and silently hide a machine.
		await collect(machine({ '/var/log/app.log': 'a' }));
		await collect(machine({ '/var/log/app.log': 'b' }));

		const listed = (await (await call('/api/objects', { headers: { cookie } })).json()) as { objects: { hostId: string; path: string }[] };
		expect(listed.objects.map((o) => `${o.hostId}:${o.path}`).sort()).toEqual(['alpha:/var/log/app.log', 'beta:/var/log/app.log']);
	});

	it('filters a listing to one machine when asked for one', async () => {
		await collect(machine({ '/var/log/app.log': 'a' }));
		await collect(machine({ '/var/log/app.log': 'b' }));

		const only = (await (await call('/api/objects?host=alpha', { headers: { cookie } })).json()) as { objects: { hostId: string }[] };
		expect(only.objects.map((o) => o.hostId)).toEqual(['alpha']);
	});

	it('keeps a changed file on one machine from superseding the other machine\'s file', async () => {
		// Supersession is keyed on host AND path. Keyed on path alone, one machine changing its file would retire
		// the other machine's live version — so the other would appear to have lost a file still on its disk.
		//
		// WHICH MACHINE EACH RUN PICKS IS DELIBERATELY NOT ASSUMED, and that is a correction. The rotation orders
		// by LONGEST WAITING rather than taking turns, so the sequence is alpha, beta, ALPHA — alpha waited
		// longest at that point because beta had just been attempted. The first version asserted alpha, beta, beta
		// and failed on an assertion about the rotation rather than about supersession, which is a test blaming
		// the product for the fixture. Each machine is now given exactly one change and the assertion reads
		// whichever run touched which host.
		const first = await collect(machine({ '/var/log/app.log': 'v1' }));
		const second = await collect(machine({ '/var/log/app.log': 'v2' }));
		expect([first.machineId, second.machineId].sort(), 'two different machines were collected').toEqual(['alpha', 'beta']);

		const third = await collect(machine({ '/var/log/app.log': 'v3' }));
		expect([first.machineId, second.machineId], 'and the third revisits one of them, not a third machine').toContain(third.machineId);

		const rows = await liveRows();
		expect(rows.map((r) => r.hostId).sort(), 'both machines still have a live version').toEqual(['alpha', 'beta']);

		const superseded = await env.DB.prepare('SELECT host_id AS hostId FROM objects WHERE superseded_by IS NOT NULL').all<{ hostId: string }>();
		expect(superseded.results!.map((r) => r.hostId), 'only the revisited machine has a retired version').toEqual([third.machineId]);
	});

	it('does not charge one machine for the other machine\'s bytes twice', async () => {
		// The budget is a total, so the same path on two machines must cost twice. A de-duplicating total would
		// under-report capacity and let the store run past its ceiling.
		await collect(machine({ '/var/log/app.log': '0123456789' }));
		await collect(machine({ '/var/log/app.log': '0123456789' }));

		// `totalBytes`, not `heldBytes`: the first version of this assertion invented a field name, compared
		// `undefined` against a number, and failed for a reason unrelated to what it was testing. The shape is
		// read from `StorageUsage` rather than guessed.
		const usage = (await (await call('/api/usage', { headers: { cookie } })).json()) as {
			usage: { totalBytes: number; liveBytes: number; objectCount: number };
		};
		expect(usage.usage.totalBytes, 'ten bytes on each machine, counted twice').toBe(20);
		expect(usage.usage.liveBytes).toBe(20);
		expect(usage.usage.objectCount).toBe(2);
	});

	it('rotates: repeated collections spread across the machines instead of starving one', async () => {
		// A rotation that always chose the first row would leave every other machine permanently stale while
		// reporting success on each run — the failure this ticket names in its own words.
		//
		// The first version of this test asserted that `beta` had no run yet, which was true for a reason that had
		// nothing to do with rotation: it had never been in the machine list at all. It would have passed against a
		// rotation that never moved. This one runs the rotation and counts what it actually touched.
		const picked: string[] = [];
		for (let i = 0; i < 4; i++) picked.push((await collect(machine({ '/var/log/app.log': `run ${i}` }))).machineId);

		expect(new Set(picked).size, `four runs must reach both machines, and reached ${new Set(picked).size}`).toBe(2);
		expect(picked[0], 'and must not start on the same one every time').not.toBe(picked[1]);

		// Counted from the run rows rather than from the responses, so the record and the behaviour must agree.
		const runs = await env.DB.prepare('SELECT host_id AS h, COUNT(*) AS n FROM collection_runs GROUP BY host_id ORDER BY h').all<{ h: string; n: number }>();
		expect(runs.results!.map((r) => `${r.h}:${r.n}`), 'and each machine was attempted twice').toEqual(['alpha:2', 'beta:2']);
	});
});

describe('a machine that is unreachable among reachable ones', () => {
	beforeEach(reset);

	it('records the failure against that machine and does not touch the other one\'s files', async () => {
		// The ticket calls for an unreachable machine among reachable ones. What must NOT happen is the failure
		// being attributed to the wrong host, or a partially-written row appearing for the machine that failed.
		await collect(machine({ '/var/log/app.log': 'alpha file' }));

		const broken: RemoteHost = {
			...machine({}),
			async list() {
				throw new Error('connection timed out');
			},
		};
		const body = await collect(broken);

		// The rotation moved to beta, so the failure is beta's.
		expect(body.machineId).toBe('beta');

		const rows = await liveRows();
		expect(rows.map((r) => r.hostId), 'alpha keeps its file and beta has nothing').toEqual(['alpha']);

		const issues = await env.DB.prepare('SELECT host_id AS h, kind FROM collection_issues').all<{ h: string; kind: string }>();
		expect(issues.results!.every((i) => i.h === 'beta'), 'the failure is recorded against beta, not alpha').toBe(true);
	});
});
