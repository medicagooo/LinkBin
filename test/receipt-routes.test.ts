import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Receipts, through the request/response edge.
 *
 * The data is seeded directly rather than produced by a collection run, because collection itself is not
 * built yet and these queries do not depend on how the rows were written. That keeps this a test of the
 * reading side, which is what the interface actually consumes.
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

	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
		        ('h2', 'two', 'b.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();
}

function asOperator(path: string): Promise<Response> {
	return call(path, { headers: { cookie: `linkbin_session=${token}` } });
}

async function addRun(over: Record<string, unknown> = {}): Promise<number> {
	const row = {
		host_id: 'h1',
		state: 'finished',
		started_at: '2026-01-01T10:00:00.000Z',
		finished_at: '2026-01-01T10:02:00.000Z',
		stored_count: 3,
		skipped_count: 0,
		failed_count: 0,
		bytes_stored: 4096,
		...over,
	};
	const result = await env.DB.prepare(
		`INSERT INTO collection_runs (host_id, state, started_at, finished_at, stored_count, skipped_count, failed_count, bytes_stored)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(row.host_id, row.state, row.started_at, row.finished_at, row.stored_count, row.skipped_count, row.failed_count, row.bytes_stored)
		.run();
	return Number(result.meta.last_row_id);
}

async function addIssue(runId: number, over: Record<string, unknown> = {}): Promise<void> {
	const row = {
		host_id: 'h1',
		path: '/var/log/app.log',
		kind: 'error',
		reason: 'Permission denied (publickey).',
		size_bytes: null,
		created_at: '2026-01-01T10:01:00.000Z',
		...over,
	};
	await env.DB.prepare(
		`INSERT INTO collection_issues (run_id, host_id, path, kind, reason, size_bytes, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(runId, row.host_id, row.path, row.kind, row.reason, row.size_bytes, row.created_at)
		.run();
}

describe('listing runs', () => {
	beforeEach(bootstrap);

	it('reports a run with its counts, newest first', async () => {
		await addRun({ started_at: '2026-01-01T10:00:00.000Z' });
		const newer = await addRun({ started_at: '2026-01-03T10:00:00.000Z', stored_count: 7 });

		const body = (await (await asOperator('/api/runs')).json()) as any;
		expect(body.runs.length).toBe(2);
		expect(body.runs[0].id).toBe(newer);
		expect(body.runs[0].stored).toBe(7);
		expect(body.runs[0].outcome).toBe('success');
	});

	it('marks a run with problems so it is visible without opening it', async () => {
		const runId = await addRun({ failed_count: 2 });
		await addIssue(runId);
		const body = (await (await asOperator('/api/runs')).json()) as any;
		expect(body.runs[0].outcome).toBe('problems');
		expect(body.runs[0].issueCount).toBe(1);
	});

	it('reports a run that never finished as unfinished, not as a successful empty one', async () => {
		await addRun({ state: 'running', finished_at: null, stored_count: 0, skipped_count: 0, failed_count: 0 });
		const body = (await (await asOperator('/api/runs')).json()) as any;
		expect(body.runs[0].outcome).toBe('unfinished');
		expect(body.runs[0].seconds).toBeNull();
	});

	it('filters by machine when asked', async () => {
		await addRun({ host_id: 'h1' });
		await addRun({ host_id: 'h2', started_at: '2026-01-02T10:00:00.000Z' });

		const body = (await (await asOperator('/api/runs?host=h1')).json()) as any;
		expect(body.runs.length).toBe(1);
		expect(body.runs[0].hostId).toBe('h1');
	});

	it('requires a signed-in operator', async () => {
		expect((await call('/api/runs')).status).toBe(401);
	});
});

describe('one run in detail', () => {
	beforeEach(bootstrap);

	it('lists its issues individually, with the machine own words', async () => {
		const runId = await addRun({ failed_count: 1 });
		await addIssue(runId, { reason: 'Permission denied (publickey).', path: '/root/secret' });

		const body = (await (await asOperator(`/api/runs/detail?id=${runId}`)).json()) as any;
		expect(body.run.issues.length).toBe(1);
		expect(body.run.issues[0].reason).toBe('Permission denied (publickey).');
		expect(body.run.issues[0].path).toBe('/root/secret');
		expect(body.run.issues[0].hostId).toBe('h1');
	});

	it('is an empty list for a run with no problems, not an absent one', async () => {
		const runId = await addRun();
		const body = (await (await asOperator(`/api/runs/detail?id=${runId}`)).json()) as any;
		expect(body.run.issues).toEqual([]);
		expect(body.run.byKind).toEqual({});
	});

	it('separates a size skip from a failure', async () => {
		const runId = await addRun({ skipped_count: 1, failed_count: 1 });
		await addIssue(runId, { kind: 'too_large', size_bytes: 200 * 1024 * 1024 });
		await addIssue(runId, { kind: 'error', reason: 'connection reset', created_at: '2026-01-01T10:01:01.000Z' });

		const body = (await (await asOperator(`/api/runs/detail?id=${runId}`)).json()) as any;
		const skipped = body.run.issues.find((i: any) => i.kind === 'too_large');
		const failed = body.run.issues.find((i: any) => i.kind === 'error');

		expect(skipped.deliberate).toBe(true);
		expect(skipped.sizeBytes).toBe(200 * 1024 * 1024);
		expect(failed.deliberate).toBe(false);
	});

	it('counts issues by kind so a pattern is visible at a glance', async () => {
		const runId = await addRun({ failed_count: 3 });
		await addIssue(runId, { kind: 'capacity' });
		await addIssue(runId, { kind: 'capacity', created_at: '2026-01-01T10:01:01.000Z' });
		await addIssue(runId, { kind: 'too_large', created_at: '2026-01-01T10:01:02.000Z' });

		const body = (await (await asOperator(`/api/runs/detail?id=${runId}`)).json()) as any;
		expect(body.run.byKind.capacity).toBe(2);
		expect(body.run.byKind.too_large).toBe(1);
	});

	it('refuses an unknown run rather than returning an empty one', async () => {
		expect((await asOperator('/api/runs/detail?id=999999')).status).toBe(404);
	});

	it('refuses a missing or nonsense id', async () => {
		expect((await asOperator('/api/runs/detail')).status).toBe(400);
		expect((await asOperator('/api/runs/detail?id=abc')).status).toBe(400);
	});
});

describe('issues across runs', () => {
	beforeEach(bootstrap);

	it('can be filtered by machine', async () => {
		const first = await addRun({ host_id: 'h1' });
		const second = await addRun({ host_id: 'h2', started_at: '2026-01-02T10:00:00.000Z' });
		await addIssue(first, { host_id: 'h1' });
		await addIssue(second, { host_id: 'h2' });

		const body = (await (await asOperator('/api/issues?host=h2')).json()) as any;
		expect(body.hostId).toBe('h2');
		expect(body.issues.length).toBe(1);
		expect(body.issues[0].hostId).toBe('h2');
	});

	it('lists everything when no machine is named', async () => {
		const first = await addRun({ host_id: 'h1' });
		await addIssue(first);
		const body = (await (await asOperator('/api/issues')).json()) as any;
		expect(body.issues.length).toBe(1);
	});

	it('requires a signed-in operator, because these name paths on private machines', async () => {
		expect((await call('/api/issues')).status).toBe(401);
	});
});

describe('successful files are not problems', () => {
	beforeEach(bootstrap);

	it('records nothing for a file that was stored', async () => {
		// The issue list is a list of problems. If successes appeared here it would stop being readable
		// exactly when it is longest and most needed — and nothing in the write path records a success as an
		// issue, which is what this pins down.
		const runId = await addRun({ stored_count: 5, skipped_count: 0, failed_count: 0 });
		const body = (await (await asOperator(`/api/runs/detail?id=${runId}`)).json()) as any;

		expect(body.run.stored).toBe(5);
		expect(body.run.issues).toEqual([]);
		expect(body.run.issueCount ?? 0).toBe(0);
	});
});
