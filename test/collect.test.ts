import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Starting a collection on demand.
 *
 * The decision layer is real and this exposes it; the collection itself is not built, and the response says
 * so rather than reporting a run that never happened. A caller that assumed otherwise would believe a
 * machine had been updated.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long interface password';

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

let token = '';

async function bootstrap(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['collection_issues', 'collection_runs', 'hosts', 'auth_secret', 'auth_attempts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	token = /linkbin_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
}

async function addHost(id: string, enabled = true): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, 22, 'root', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	)
		.bind(id, id, `${id}.invalid`, enabled ? 1 : 0)
		.run();
}

function collect(): Promise<Response> {
	return call('/api/collect', { method: 'POST', headers: { cookie: `linkbin_session=${token}` } });
}

describe('starting a collection on demand', () => {
	beforeEach(bootstrap);

	it('says there is nothing to do when no machine is configured, rather than appearing to work', async () => {
		// The most likely reason for a button that seems to do nothing, stated rather than left to be guessed.
		const body = (await (await collect()).json()) as any;
		expect(body.ok).toBe(true);
		expect(body.run).toBe(false);
		expect(body.reason).toBe('nothing-to-do');
	});

	it('names the machine it would collect, and reports the attempt when it cannot reach it', async () => {
		// The route no longer stops at the decision: it opens a run and tries to connect. With no machine to reach
		// — `web-01.invalid` resolves nowhere — the honest answer is that a run was started and failed, so `run` is
		// true (the schedule DID pick a machine) while `connected` is false and the totals are zero.
		//
		// `run` answers "did the schedule pick a machine", not "did it succeed". Conflating the two would make a
		// failure look like an idle scheduler, which is the one thing an operator must be able to tell apart.
		await addHost('web-01');
		const body = (await (await collect()).json()) as any;
		expect(body.run).toBe(true);
		expect(body.machineId).toBe('web-01');
		expect(body.connected, 'the machine was not reachable').toBe(false);
		expect(body.runId, 'and the attempt is recorded as a run').toBeGreaterThan(0);
		expect(body.totals.stored).toBe(0);
	});

	it('says plainly when a request collected nothing, so no one believes a machine was updated', async () => {
		// `run: false` is the field that carries this. It used to be `collectionImplemented: false`, which meant
		// something different and stopped being true: collection IS implemented, and this request simply had
		// nothing to do. A flag meaning "the code cannot do this" must not be used to mean "this call did
		// nothing", or the two states become indistinguishable and one of them is a lie.
		//
		// NO machine is configured here, which is the only way to reach `run: false` now that the route actually
		// collects: with a machine configured it opens a run and attempts a connection, however that ends.
		const body = (await (await collect()).json()) as any;
		expect(body.collectionImplemented, 'collection exists').toBe(true);
		expect(body.run, 'and this request collected nothing').toBe(false);
		expect(body.reason).toBe('nothing-to-do');
		expect(body.machineId).toBeNull();
	});

	it('reports that the operator asked, as distinct from the scheduler', async () => {
		await addHost('web-01');
		const body = (await (await collect()).json()) as any;
		expect(body.by).toBe('operator');
	});

	it('ignores a disabled machine', async () => {
		await addHost('off', false);
		const body = (await (await collect()).json()) as any;
		expect(body.run).toBe(false);
		expect(body.reason).toBe('nothing-to-do');
	});

	it('rotates: two requests choose the machine that has waited longest', async () => {
		await addHost('first');
		await addHost('second');
		const one = (await (await collect()).json()) as any;
		// Whichever was chosen is recorded as attempted, exactly as a run would record it.
		await env.DB.prepare(
			`INSERT INTO collection_runs (host_id, state, started_at, stored_count, skipped_count, failed_count, bytes_stored)
			 VALUES (?, 'finished', '2026-06-01T00:00:00.000Z', 0, 0, 0, 0)`,
		)
			.bind(one.machineId)
			.run();

		const two = (await (await collect()).json()) as any;
		expect(two.machineId).not.toBe(one.machineId);
	});

	it('resumes only from a cursor belonging to the machine chosen', async () => {
		// Two machines, and the unfinished run belongs to the one that will NOT be chosen: `someone-else` was
		// attempted most recently, so the rotation picks `only`.
		await addHost('only');
		await addHost('someone-else');
		await env.DB.prepare(
			`INSERT INTO collection_runs (host_id, state, started_at, cursor_json, stored_count, skipped_count, failed_count, bytes_stored)
			 VALUES ('someone-else', 'running', '2026-06-01T00:00:00.000Z', '{"hostId":"someone-else","position":"dir:/var/log","startedAt":"2026-06-01T00:00:00.000Z"}', 0, 0, 0, 0)`,
		).run();

		const body = (await (await collect()).json()) as any;
		expect(body.machineId).toBe('only');
		// A cursor names a position on ONE machine, so it is not applied to another — and the fact is said
		// rather than left to look like the cursor was never written.
		expect(body.resumeFrom).toBeNull();
		expect(body.notes.join(' ')).toMatch(/cursor/i);
	});

	it('resumes from a cursor that does belong to the machine chosen', async () => {
		await addHost('only');
		await env.DB.prepare(
			`INSERT INTO collection_runs (host_id, state, started_at, cursor_json, stored_count, skipped_count, failed_count, bytes_stored)
			 VALUES ('only', 'running', '2026-06-01T00:00:00.000Z', '{"hostId":"only","position":"dir:/var/log","startedAt":"2026-06-01T00:00:00.000Z"}', 0, 0, 0, 0)`,
		).run();

		const body = (await (await collect()).json()) as any;
		expect(body.run).toBe(true);
		expect(body.resumeFrom).toBe('dir:/var/log');
	});

	it('treats an unreadable cursor as absent', async () => {
		await addHost('only');
		await env.DB.prepare(
			`INSERT INTO collection_runs (host_id, state, started_at, cursor_json, stored_count, skipped_count, failed_count, bytes_stored)
			 VALUES ('only', 'running', '2026-06-01T00:00:00.000Z', '{"hostId":', 0, 0, 0, 0)`,
		).run();

		const body = (await (await collect()).json()) as any;
		expect(body.run).toBe(true);
		expect(body.resumeFrom).toBeNull();
	});

	it('treats a run that finished with problems as having collected the machine', async () => {
		// A run that finished with files it could not handle HAS completed: the machine was reached and
		// scanned. Counting only runs with zero failures would report such a machine as never collected, which
		// is false and sends someone to investigate a connection that is working.
		await addHost('one');
		await addHost('two');
		await env.DB.prepare(
			`INSERT INTO collection_runs (host_id, state, started_at, finished_at, stored_count, skipped_count, failed_count, bytes_stored)
			 VALUES ('one', 'finished', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 5, 1, 2, 100)`,
		).run();

		const body = (await (await collect()).json()) as any;
		// `one` was attempted most recently, so the rotation chooses `two` — which it would also do if `one` had
		// no runs at all. What matters is that `one` is not treated as never-attempted and does not block.
		expect(body.machineId).toBe('two');
	});

	it('requires a session or the scheduler credential', async () => {
		expect((await call('/api/collect', { method: 'POST' })).status).toBe(401);
	});
});
