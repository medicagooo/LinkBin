import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RemoteEntry, RemoteHost } from '../src/remote';
import { cursorFor } from '../src/collect-store';
import { parseCursor } from '../src/schedule';
import { cursorPosition } from '../src/index';

/**
 * Resuming a run that stopped early, rather than starting it again.
 *
 * The cursor was written, read, reported and then **ignored**: `collectFrom` always began at the front of the
 * resolved order. The criterion is that the next run "does not redo work already completed", so what is asserted
 * here is the WORK, not the cursor's presence — a test that only checked the JSON would have passed against the
 * version that ignored it.
 *
 * The measurement is a count of reads at the machine. Re-reading a file is not free: every one costs a `stat`, a
 * content hash and a comparison, and on a metered host it costs transfer as well. The only honest way to show
 * that work was skipped is to count the times the machine was asked for bytes.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';
const FILES = 30;

/** A machine that counts how many times it was asked to open a file, and how many it listed. */
function countingMachine(): { remote: RemoteHost; reads: () => number; stats: () => number; reset: () => void } {
	let reads = 0;
	let stats = 0;
	const files = Array.from({ length: FILES }, (_, i) => `/var/log/f${String(i).padStart(3, '0')}.log`);

	const remote: RemoteHost = {
		async list(dir: string): Promise<RemoteEntry[]> {
			if (dir !== '/var/log') throw new Error(`no such directory ${dir}`);
			return files.map((p) => ({ name: p.slice('/var/log/'.length), size: 4, mtime: 1_700_000_000, isDirectory: false }));
		},
		async stat(path: string) {
			stats += 1;
			if (!files.includes(path)) throw new Error(`no such file ${path}`);
			return { size: 4, mtime: 1_700_000_000, isDirectory: false };
		},
		async read(path: string) {
			reads += 1;
			if (!files.includes(path)) throw new Error(`no such file ${path}`);
			// Content is derived from the path, so each file is distinct and none is "unchanged" by accident.
			const body = path.slice(-7);
			return new ReadableStream<Uint8Array>({
				start(ctrl) {
					ctrl.enqueue(new TextEncoder().encode(body));
					ctrl.close();
				},
			});
		},
		async exec() {
			return 'FakeOS 1.0';
		},
	};

	return { remote, reads: () => reads, stats: () => stats, reset: () => { reads = 0; stats = 0; } };
}

function call(path: string, init?: RequestInit, remote?: RemoteHost): Promise<Response> {
	const target: Record<string, unknown> = { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY };
	if (remote) target.TEST_REMOTE = remote;
	return worker.fetch(new Request(`${BASE}${path}`, init), target as never, {} as never);
}

let cookie = '';

async function reset(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['multipart_sessions', 'object_reclaims', 'object_flags', 'objects', 'collection_issues', 'collection_runs', 'source_rules', 'hosts', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'h1', 'h1.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	).run();
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

async function collect(remote: RemoteHost): Promise<any> {
	return await (await call('/api/collect', { method: 'POST', headers: { cookie } }, remote)).json();
}

/** A stopped run for `h1`, with a cursor that says a given number of files were reached. */
async function seedStoppedRun(reached: number): Promise<void> {
	// The SHAPE matters and is `parseCursor`'s, not mine: `{ hostId, position, startedAt }`. The first version of
	// this fixture wrote `{ hostId, reached }`, which `parseCursor` rejects — and that mismatch turned out to be a
	// real defect in the product rather than in the fixture, which is why the header of `cursorFor` now quotes it.
	await env.DB.prepare(
		`INSERT INTO collection_runs (host_id, state, started_at, cursor_json, stored_count, skipped_count, failed_count, bytes_stored)
		 VALUES ('h1', 'running', '2026-06-01T00:00:00.000Z', ?, 0, 0, 0, 0)`,
	)
		.bind(JSON.stringify({ hostId: 'h1', position: String(reached), startedAt: '2026-06-01T00:00:00.000Z' }))
		.run();
}

describe('resuming from a cursor', () => {
	beforeEach(reset);

	it('stores every file on a first run and leaves no cursor, because it finished', async () => {
		const m = countingMachine();
		const body = await collect(m.remote);

		expect(body.totals.stored).toBe(FILES);
		expect(body.stoppedEarly).toBe(false);
		expect(body.resumeFrom, 'a finished run has nothing to resume from').toBeNull();
		expect(m.reads(), 'every file was read once').toBe(FILES);

		const run = await env.DB.prepare('SELECT cursor_json AS c FROM collection_runs ORDER BY id DESC').first<{ c: string | null }>();
		expect(run!.c, 'and no cursor was written, so the next run starts clean').toBeNull();
	});

	it('does not re-read the files a previous run already reached', async () => {
		// THE CRITERION. Twelve of thirty files were reached last time; the machine must be asked for the other
		// eighteen and for none of the first twelve.
		await seedStoppedRun(12);
		const m = countingMachine();
		const body = await collect(m.remote);

		expect(body.resumeFrom, 'the route reports where it picked up').toBe('12');
		expect(m.reads(), 'only the files that were NOT already reached').toBe(FILES - 12);
		expect(body.totals.stored, 'and each of those was stored').toBe(FILES - 12);

		// The stored rows confirm WHICH files, not merely how many.
		const { results } = await env.DB.prepare('SELECT path FROM objects ORDER BY path').all<{ path: string }>();
		expect(results!.map((r) => r.path)[0], 'the first file was skipped, so it is absent').toBe('/var/log/f012.log');
		expect(results).toHaveLength(FILES - 12);
	});

	it('reaches the end on the resumed run, so a second resume finds nothing left', async () => {
		await seedStoppedRun(25);
		const m = countingMachine();
		const body = await collect(m.remote);

		expect(m.reads()).toBe(5);
		expect(body.stoppedEarly, 'it finished rather than stopping again').toBe(false);

		const run = await env.DB.prepare('SELECT state, cursor_json AS c FROM collection_runs ORDER BY id DESC').first<{ state: string; c: string | null }>();
		expect(run!.state).toBe('finished');
		expect(run!.c, 'a finished run clears the cursor so the next starts from the beginning').toBeNull();
	});

	it('treats a cursor that cannot be used as no cursor, rather than skipping files', async () => {
		// The two failures are not symmetric. Re-reading a file costs a `stat` and a hash and stores nothing —
		// the content hash decides. SKIPPING files that were never read loses them silently. So a doubtful value
		// starts from the beginning.
		for (const bad of ['not a number', -5, 1.5, null]) {
			await env.DB.prepare('DELETE FROM collection_runs').run();
			await env.DB.prepare('DELETE FROM objects').run();
			await env.DB.prepare('DELETE FROM collection_issues').run();
			await seedStoppedRun(bad as never);

			const m = countingMachine();
			const body = await collect(m.remote);
			expect(m.reads(), `a cursor of ${JSON.stringify(bad)} must not skip anything`).toBe(FILES);
			expect(body.totals.stored).toBe(FILES);
		}
	});

	it('does not fall over when the cursor is further ahead than the machine has files', async () => {
		// A file removed upstream since the cursor was written. Nothing is left to do, and that is not an error.
		await seedStoppedRun(500);
		const m = countingMachine();
		const body = await collect(m.remote);

		expect(m.reads(), 'nothing was read').toBe(0);
		expect(body.totals.stored).toBe(0);
		expect(body.totals.failed, 'and nothing was recorded as a failure').toBe(0);
	});

	it('writes a cursor its own reader accepts, which is what the round trip failed to do', async () => {
		// THE GAP THAT HID THE REAL DEFECT. Every other test here SEEDS a cursor, so none of them exercises the
		// write — and the write was producing `{ hostId, reached }` while `parseCursor` required
		// `{ hostId, position, startedAt }`. The cursor was stored, reported, and silently unusable. A mutation
		// restoring the old shape passed the whole suite, which is how the gap was found.
		//
		// The two halves are wired together here rather than described as compatible.
		const written = cursorFor('h1', 42, '2026-06-01T00:00:00.000Z');
		const parsed = parseCursor(written);

		expect(parsed, 'what cursorFor writes, parseCursor must accept').not.toBeNull();
		expect(parsed!.hostId).toBe('h1');
		expect(parsed!.position, 'and the position is the count the walk reported').toBe('42');
		expect(cursorPosition(parsed!.position), 'which the route turns back into an offset').toBe(42);
	});

	it('does not accept a position it cannot trust as an exact count', async () => {
		// Strict rather than rounded, because the two failures are not symmetric: resuming from 0 re-reads files
		// and stores nothing, while resuming from too high SKIPS files that were never read. `Math.trunc("1.5")`
		// is `1`, which looks usable and drops a file, so it is refused instead.
		expect(cursorPosition('42')).toBe(42);
		expect(cursorPosition('0')).toBe(0);
		expect(cursorPosition('1.5'), 'a fraction is refused, not truncated').toBe(0);
		expect(cursorPosition('-5')).toBe(0);
		expect(cursorPosition('12abc')).toBe(0);
		expect(cursorPosition('')).toBe(0);
		expect(cursorPosition(null)).toBe(0);
		expect(cursorPosition(undefined)).toBe(0);
		expect(cursorPosition('9007199254740993'), 'beyond safe integers, refused').toBe(0);
	});

	it('refuses a cursor belonging to another machine rather than applying it here', async () => {
		// A cursor names a position on ONE machine. Applied to another it would skip files that were never
		// scanned there — which is why `planRun` ignores it and says so.
		await env.DB.prepare(
			`INSERT INTO collection_runs (host_id, state, started_at, cursor_json, stored_count, skipped_count, failed_count, bytes_stored)
			 VALUES ('h1', 'running', '2026-06-01T00:00:00.000Z', ?, 0, 0, 0, 0)`,
		)
			.bind(JSON.stringify({ hostId: 'someone-else', position: '20', startedAt: '2026-06-01T00:00:00.000Z' }))
			.run();

		const m = countingMachine();
		const body = await collect(m.remote);

		expect(body.resumeFrom, 'the foreign cursor is not applied').toBeNull();
		expect(m.reads(), 'so every file is read').toBe(FILES);
		expect(body.notes.join(' '), 'and the reason is said out loud').toMatch(/cursor/i);
	});
});
