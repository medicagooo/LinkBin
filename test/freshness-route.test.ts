import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * How stale each machine is, through the route the interface reads.
 *
 * `schedule.test.ts` covers the arithmetic with four cases. What only an integration test shows is that the
 * inputs are assembled correctly from the database — which matters because the two figures an operator acts on
 * are both easy to get subtly wrong here: "last collected successfully" must count a run that FINISHED, and a
 * machine that has never succeeded must report `null` rather than zero.
 *
 * A zero would read as "collected just now", which is the opposite of the truth, and it is exactly the kind of
 * mistake that makes an interface confidently wrong.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (cookie) headers.cookie = cookie;
	return call(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

let cookie = '';

async function reset(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['collection_issues', 'collection_runs', 'hosts', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	const setup = await post('/api/auth/setup', { password: PASSWORD });
	if (setup.status !== 200) throw new Error(`setup failed: ${await setup.text()}`);
	const login = await post('/api/auth/login', { password: PASSWORD });
	cookie = /(linkbin_session=[^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
}

async function addHost(id: string): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES (?, ?, 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	)
		.bind(id, id)
		.run();
}

async function addRun(hostId: string, state: string, startedAt: string, finishedAt: string | null, counts = { stored: 0, skipped: 0, failed: 0 }): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO collection_runs (host_id, state, started_at, finished_at, stored_count, skipped_count, failed_count, bytes_stored)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
	)
		.bind(hostId, state, startedAt, finishedAt, counts.stored, counts.skipped, counts.failed)
		.run();
}

type Freshness = {
	ok: boolean;
	machines: { id: string; secondsSinceSuccess: number | null; never: boolean; lastOutcome: { state: string; stored: number } | null }[];
	worstSeconds: number | null;
	neverCount: number;
	targetSeconds: number;
};

async function freshnessOf(): Promise<Freshness> {
	const res = await call('/api/freshness', { headers: { cookie } });
	if (res.status !== 200) throw new Error(`freshness answered ${res.status}: ${await res.text()}`);
	return (await res.json()) as Freshness;
}

describe('how fresh the store is', () => {
	beforeEach(reset);

	it('reports each machine with the seconds since it last succeeded', async () => {
		await addHost('h1');
		const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
		await addRun('h1', 'finished', anHourAgo, anHourAgo, { stored: 3, skipped: 0, failed: 0 });

		const body = await freshnessOf();
		expect(body.machines).toHaveLength(1);
		expect(body.machines[0].never).toBe(false);
		expect(body.machines[0].secondsSinceSuccess, 'about an hour, allowing for the clock moving').toBeGreaterThanOrEqual(3595);
		expect(body.machines[0].secondsSinceSuccess).toBeLessThanOrEqual(3605);
		expect(body.machines[0].lastOutcome?.stored).toBe(3);
	});

	it('reports a machine that has never succeeded as never, not as zero seconds', async () => {
		// Zero would read as "collected just now", which is the opposite of the truth and the reason `freshness`
		// distinguishes the two. Asserting the flag AND the null, because an interface could render either.
		await addHost('fresh');

		const body = await freshnessOf();
		expect(body.machines[0].never, 'never collected successfully').toBe(true);
		expect(body.machines[0].secondsSinceSuccess).toBeNull();
		expect(body.neverCount).toBe(1);
		expect(body.worstSeconds, 'a worst case cannot be known when one machine has no data').toBeNull();
	});

	it('does not count a run that never finished as a success', async () => {
		// An unfinished run means the machine was reached and the scan did not complete. Counting it would report
		// the machine as collected when files were missed.
		await addHost('h1');
		await addRun('h1', 'running', new Date(Date.now() - 60_000).toISOString(), null);

		const body = await freshnessOf();
		expect(body.machines[0].never, 'a run that never finished is not a success').toBe(true);
		expect(body.machines[0].lastOutcome?.state, 'but the attempt is visible').toBe('running');
	});

	it('reports the WORST staleness across machines, not an average', async () => {
		// An average hides the machine that is never collected, and that is the one worth knowing about.
		await addHost('quick');
		await addHost('slow');
		await addRun('quick', 'finished', new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
		await addRun('slow', 'finished', new Date(Date.now() - 7200_000).toISOString(), new Date(Date.now() - 7200_000).toISOString());

		const body = await freshnessOf();
		// An average would be about 3630; the worst is about 7200, and it is the slow machine the operator needs
		// to hear about.
		expect(body.worstSeconds).toBeGreaterThanOrEqual(7195);
		expect(body.worstSeconds).toBeLessThanOrEqual(7205);
	});

	it('states the target it is comparing against', async () => {
		// A worst case alone answers nothing: "3000 seconds" is fine or alarming depending on what was intended.
		//
		// 25 minutes is the midpoint of the spec's 15-30 minute range. The value was 40 when first written, taken
		// from my own paraphrase of the spec rather than the spec, and the difference was permissive rather than
		// obviously wrong: a machine 35 minutes stale would have been reported as healthy.
		const body = await freshnessOf();
		expect(body.targetSeconds).toBe(25 * 60);
		expect(body.targetSeconds, 'inside the range the spec states').toBeGreaterThanOrEqual(15 * 60);
		expect(body.targetSeconds).toBeLessThanOrEqual(30 * 60);
	});

	it('excludes the derived sentinel, which is not a machine', async () => {
		// It exists because `objects.host_id` is a foreign key and a merged file comes from no machine. Listing it
		// would offer it as a machine that has never been collected, which is noise at best.
		await addHost('h1');
		const body = await freshnessOf();
		expect(body.machines.map((m) => m.id)).toEqual(['h1']);
	});

	it('stays consistent with no machines at all', async () => {
		const body = await freshnessOf();
		expect(body.machines).toEqual([]);
		expect(body.neverCount).toBe(0);
		expect(body.worstSeconds).toBeNull();
	});

	it('requires a signed-in operator', async () => {
		expect((await call('/api/freshness')).status).toBe(401);
	});
});
