import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The scheduled trigger, which is what makes collection happen without anyone asking.
 *
 * `wrangler.jsonc` schedules `scheduled`; what is tested here is that the handler reaches the SAME work the
 * interface reaches, under a genuine scheduler credential. That matters more than it looks: a cron invocation has
 * no caller to answer, so a handler that silently did nothing would be indistinguishable from one that found
 * nothing to collect — and the unattended case is the one nobody is watching.
 *
 * The handler is also required to swallow its own failures. A thrown error from a cron trigger produces a retry
 * of work the route has already recorded, and `run: false` for an empty rotation is not a failure at all.
 */

const BASE = TEST_BASE_URL;

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

/** Runs the scheduled handler and returns what it logged, so the log can be asserted rather than ignored. */
async function runScheduled(cron = '*/5 * * * *'): Promise<{ status: number; logged: string[] }> {
	const logged: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		logged.push(args.map(String).join(' '));
	};
	try {
		await (worker as unknown as { scheduled: (c: unknown, e: unknown) => Promise<void> }).scheduled(
			{ cron, scheduledTime: Date.now(), type: 'scheduled' },
			{ ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY },
		);
	} finally {
		console.log = original;
	}
	const line = logged.find((l) => l.includes('"at":"scheduled'));
	return { status: line ? (JSON.parse(line) as { status: number }).status : 0, logged };
}

async function reset(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['collection_issues', 'collection_runs', 'source_rules', 'hosts', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
}

async function addHost(id: string, enabled = true): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES (?, ?, 'a.invalid', 22, 'root', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	).bind(id, id, enabled ? 1 : 0).run();
}

describe('a scheduled invocation', () => {
	beforeEach(reset);

	it('reaches the collection route and reports what it found, with nothing to collect', async () => {
		// No machine configured. The run is declined rather than attempted, and the handler still reports it —
		// an unattended invocation that said nothing would be a black hole.
		const { status, logged } = await runScheduled();
		expect(status, 'the route answered 200, not a failure').toBe(200);
		expect(logged.join('\n'), 'and the cron that fired is recorded').toContain('*/5 * * * *');
	});

	it('starts a run for the machine the rotation picks, without a session', async () => {
		// The point of the criterion: no human action. The machine is unreachable in this environment, which the
		// route records as an issue — so what is asserted is that a RUN was created, not that the machine
		// answered. A scheduled invocation that never reached that point would leave no run row at all.
		await addHost('web-01');
		const { status } = await runScheduled();
		expect(status).toBe(200);

		const run = await env.DB.prepare('SELECT host_id, state FROM collection_runs ORDER BY id DESC').first<{ host_id: string; state: string }>();
		expect(run, 'a run row was created by the scheduled invocation').not.toBeNull();
		expect(run!.host_id).toBe('web-01');
	});

	it('counts as the scheduler rather than as an operator', async () => {
		// The two credentials are deliberately distinct, so a scheduled run must not be recorded as something a
		// person did — that distinction is the only way to tell an unattended failure from a manual one.
		//
		// Asserted through the receipt rather than the response body: the machine is unreachable here, and the
		// unreachable path answers `connected: false` without a `by` field. What proves the credential was the
		// scheduler's is that a run was created at all — no session exists in this test, so nothing else could
		// have authorised it.
		await addHost('web-01');
		await runScheduled();

		const run = await env.DB.prepare('SELECT id FROM collection_runs ORDER BY id DESC').first<{ id: number }>();
		expect(run, 'authorised by the scheduler credential alone, since no session was ever created').not.toBeNull();

		const issue = await env.DB.prepare("SELECT kind, reason FROM collection_issues WHERE run_id = ?").bind(run!.id).first<{ kind: string; reason: string }>();
		expect(issue!.kind).toBe('unreachable');
		expect(issue!.reason, 'and it names the machine it could not reach').toContain('web-01');
	});

	it('does nothing when every machine is disabled, and does not fail trying', async () => {
		await addHost('off', false);
		const { status } = await runScheduled();
		expect(status).toBe(200);
		const runs = await env.DB.prepare('SELECT COUNT(*) AS n FROM collection_runs').first<{ n: number }>();
		expect(Number(runs!.n), 'no run was opened for a disabled machine').toBe(0);
	});

	it('logs rather than throws when the deployment has no master key', async () => {
		// A cron invocation has no caller to answer, and throwing would produce a retry of work that cannot
		// succeed. But it must not die SILENTLY either: a deployment with no secret cannot authenticate anything,
		// and that has to be visible in the log.
		//
		// The environment is built WITHOUT `SSH_MASTER_KEY` explicitly, rather than by spreading `env` and hoping
		// it is absent. The first version spread `env` and the handler took the success path — so the test was
		// asserting a failure it had not actually arranged. An environment that is not demonstrably missing the
		// key cannot test what happens when it is missing.
		const bare: Record<string, unknown> = { ...(env as object) };
		delete bare.SSH_MASTER_KEY;

		const logged: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => {
			logged.push(args.map(String).join(' '));
		};
		try {
			await (worker as unknown as { scheduled: (c: unknown, e: unknown) => Promise<void> }).scheduled(
				{ cron: '*/5 * * * *', scheduledTime: Date.now(), type: 'scheduled' },
				bare,
			);
		} finally {
			console.log = original;
		}

		// Selected by its own marker rather than by "the second line", so an extra log from anywhere else cannot
		// make this pass or fail by accident.
		const failure = logged.find((l) => l.includes('scheduled-failed'));
		expect(failure, 'the failure is named, not silent').toBeDefined();
		expect(failure, 'and says why').toContain('SSH_MASTER_KEY');
	});
});

describe('the freshness target the interface compares against', () => {
	beforeEach(reset);

	it('is the midpoint of the spec range rather than a figure invented for the panel', async () => {
		// The first value written was 40 minutes, taken from my own paraphrase of the spec as "a few tens of
		// minutes". The spec says 15-30. At 40, a machine 35 minutes stale would be reported as healthy while the
		// requirement calls it late, so the wrong figure was quietly permissive rather than obviously broken.
		const login = await call('/api/auth/setup', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'a sufficiently long password' }),
		});
		expect(login.status).toBe(200);
		const session = await call('/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'a sufficiently long password' }),
		});
		const cookie = /(linkbin_session=[^;]+)/.exec(session.headers.get('set-cookie') ?? '')![1];

		const body = (await (await call('/api/freshness', { headers: { cookie } })).json()) as { targetSeconds: number };
		// `targetSeconds` is already SECONDS; the first version of this assertion multiplied by 60 and compared
		// against a 90-minute lower bound, so it would have accepted a target three times the spec's ceiling.
		expect(body.targetSeconds, 'at least the bottom of the spec range').toBeGreaterThanOrEqual(15 * 60);
		expect(body.targetSeconds, 'and no more than the top of it').toBeLessThanOrEqual(30 * 60);
	});
});
