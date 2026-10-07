import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * What a deployment says when its schema is not applied.
 *
 * This is not a hypothetical state: it is what the live deployment was found in, and what it did about it
 * was wrong twice over. `/api/status` reported `ready: false` while naming only some of the missing
 * objects, and a route whose table was absent returned a 500 whose body carried a stack trace and the
 * failing SQL — internal detail given to an anonymous caller, and a message that told the operator
 * nothing about what to do.
 *
 * A readiness check that under-reports is worse than none, because it is believed.
 */

const BASE = TEST_BASE_URL;

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

/** Drops every table the Worker needs, leaving a database in the state a fresh deployment is in. */
async function dropEverything(): Promise<void> {
	// Only the tables this suite creates; indexes go with them.
	for (const table of ['shares', 'object_flags', 'object_sources', 'collection_issues', 'collection_runs', 'multipart_sessions', 'objects', 'source_rules', 'hosts', 'auth_attempts', 'auth_secret']) {
		await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	}
}

describe('a deployment whose schema is not applied', () => {
	beforeEach(dropEverything);

	it('reports itself unready, and names every missing object', async () => {
		const res = await call('/api/status');
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;

		expect(body.schema.ready).toBe(false);
		// Names the core tables.
		expect(body.schema.missing).toContain('hosts');
		// And the ones later features added, which an earlier version of this check forgot: it reported a
		// healthy schema while the sharing routes could not run at all.
		expect(body.schema.missing).toContain('shares');
		expect(body.schema.missing).toContain('object_flags');
		expect(body.schema.missing).toContain('auth_secret');
		expect(body.schema.missing).toContain('auth_attempts');
	});

	it('refuses an API route with an explanation rather than a crash', async () => {
		// No session either, so this may be refused for authentication first; either way it must not be a 500.
		const res = await call('/api/hosts');
		expect(res.status).not.toBe(500);
	});

	it('answers the sign-in state cleanly instead of crashing, and leaks nothing internal', async () => {
		// `/api/auth/state` is a route EVERY first visitor hits. It was the one defect the schema guard missed,
		// because `/api/auth/*` returned before the guard ran — found by auditing the live deployment, which
		// answered 500 with a stack trace and `no such table: auth_secret`.
		const res = await call('/api/auth/state');
		expect(res.status).not.toBe(500);

		const raw = await res.text();
		expect(raw).not.toContain('no such table');
		expect(raw).not.toContain('at async');
		expect(raw).not.toContain('stack');
	});

	it('refuses a sign-in attempt cleanly, because it cannot read the password', async () => {
		const res = await call('/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'anything at all' }),
		});
		expect(res.status).not.toBe(500);
		expect(await res.text()).not.toContain('no such table');
	});

	it('still lets setup be attempted, because that is the only way out of this state', async () => {
		// Setup is the bootstrap. Refusing it would leave a deployment with an unapplied migration unable to
		// create the tables it needs, which is a dead end rather than a safeguard.
		const res = await call('/api/auth/setup', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'a sufficiently long password' }),
		});
		expect(res.status).not.toBe(503);
	});

	it('answers a share link cleanly instead of crashing, and leaks nothing internal', async () => {
		// The live deployment returned a 500 here with a stack trace and `no such table: shares` in the body.
		// A recipient cannot act on that, and handing internal detail to whoever holds a link is a defect in
		// itself.
		const res = await call('/s/any-token-at-all');
		expect(res.status).not.toBe(500);

		const raw = await res.text();
		expect(raw).not.toContain('no such table');
		expect(raw).not.toContain('at async');
		expect(raw).not.toContain('index.js');
		expect(raw).not.toContain('stack');
	});

	it('says the schema is the problem on a route that needs it, naming what is missing', async () => {
		const res = await call('/api/usage');
		expect([401, 503]).toContain(res.status);
		if (res.status === 503) {
			const body = (await res.json()) as any;
			expect(body.missing).toContain('hosts');
			expect(body.hint).toContain('apply-schema');
		}
	});

	it('still lets the schema be fixed, or the deployment could never recover', async () => {
		const res = await call('/api/admin/apply-schema', { method: 'POST' });
		expect(res.status).toBe(200);

		const after = (await (await call('/api/status')).json()) as any;
		expect(after.schema.ready).toBe(true);
		expect(after.schema.missing).toEqual([]);
	});
});

describe('once the schema is applied', () => {
	beforeEach(async () => {
		await call('/api/admin/apply-schema', { method: 'POST' });
	});

	it('reports every required object as present', async () => {
		const body = (await (await call('/api/status')).json()) as any;
		expect(body.schema.ready).toBe(true);
		expect(body.schema.missing).toEqual([]);
	});

	it('still refuses a share link that does not exist, without leaking anything', async () => {
		const res = await call('/s/definitely-not-a-real-token');
		expect(res.status).toBe(404);
		const raw = await res.text();
		expect(raw).not.toContain('no such table');
		expect(raw).not.toContain('SELECT');
	});
});
