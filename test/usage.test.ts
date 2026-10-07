import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * What the interface is told about storage.
 *
 * The budget is enforced whether or not anyone can see it, so the property worth testing is that the
 * numbers shown agree with the numbers the policy acts on. Two independent calculations of the same total
 * is the classic way for a store to look healthy while it is over its ceiling.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

let token = '';

async function bootstrap(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['object_flags', 'objects', 'hosts', 'auth_secret', 'auth_attempts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	token = /linkbin_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'h.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();
}

async function usage(): Promise<any> {
	const res = await call('/api/usage', { headers: { cookie: `linkbin_session=${token}` } });
	return (await res.json()) as any;
}

async function addObject(key: string, size: number, over: { superseded?: boolean; deleted?: boolean; important?: boolean } = {}) {
	await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at, superseded_by, deleted_at)
		 VALUES ('h1', ?, ?, ?, 'hash', '2026-01-01T00:00:00Z', ?, ?)`,
	)
		.bind(key, key, size, over.superseded ? 1 : null, over.deleted ? '2026-01-02T00:00:00Z' : null)
		.run();

	if (over.important) {
		const row = await env.DB.prepare('SELECT id FROM objects WHERE object_key = ?').bind(key).first<{ id: number }>();
		await env.DB.prepare('INSERT INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)')
			.bind(row!.id, '2026-01-01T00:00:00Z')
			.run();
	}
}

describe('the budget is stated, not only enforced', () => {
	beforeEach(bootstrap);

	it('reports the ceiling, the total held, and the per-file limit', async () => {
		const body = await usage();
		expect(body.ok).toBe(true);
		expect(body.usage.budgetBytes).toBe(10 * 1024 * 1024 * 1024);
		expect(body.usage.totalBytes).toBe(0);
		expect(body.usage.remainingBytes).toBe(10 * 1024 * 1024 * 1024);
		// The per-file limit is a separate number and the interface has to be able to show both.
		expect(body.usage.maxFileBytes).toBe(100 * 1024 * 1024);
	});

	it('counts superseded and deleted objects in the total, because they are still held', async () => {
		await addObject('/live', 1000);
		await addObject('/old', 2000, { superseded: true });
		await addObject('/gone', 4000, { deleted: true });

		const body = await usage();
		expect(body.usage.totalBytes).toBe(7000);
		expect(body.usage.liveBytes).toBe(1000);
		expect(body.usage.retainedBytes).toBe(6000);
	});

	it('shows the share of the budget used, and it agrees with the raw numbers', async () => {
		await addObject('/a', 5 * 1024 * 1024 * 1024);
		const body = await usage();
		expect(body.usage.usedFraction).toBeCloseTo(0.5, 6);
		expect(body.usage.usedFraction * body.usage.budgetBytes).toBeCloseTo(body.usage.totalBytes, 0);
	});

	it('reports how much is protected from eviction', async () => {
		await addObject('/keep', 3000, { important: true });
		await addObject('/other', 1000);
		const body = await usage();
		expect(body.usage.importantBytes).toBe(3000);
	});

	it('does not claim to be saturated while unprotected space remains', async () => {
		await addObject('/keep', 1000, { important: true });
		const body = await usage();
		expect(body.usage.saturatedByImportant).toBe(false);
	});

	it('stays consistent when the store is empty', async () => {
		const body = await usage();
		expect(body.usage.objectCount).toBe(0);
		expect(body.usage.usedFraction).toBe(0);
		expect(body.usage.saturatedByImportant).toBe(false);
	});

	it('requires a signed-in operator, because it describes stored files', async () => {
		const res = await call('/api/usage');
		expect(res.status).toBe(401);
	});

	it('stops charging for an object whose bytes have been reclaimed', async () => {
		// The distinction the reclaims table exists for, asserted where the operator reads it. A soft-deleted
		// object still has its bytes, so it is still charged; a RECLAIMED one does not, so it is not. One bit
		// cannot answer both, and the answers are opposites.
		await addObject('/soft', 3000, { deleted: true });
		await addObject('/reclaimed', 5000);
		const row = await env.DB.prepare("SELECT id FROM objects WHERE object_key = '/reclaimed'").first<{ id: number }>();
		await env.DB.prepare('INSERT INTO object_reclaims (object_id, bytes_freed, reclaimed_at) VALUES (?, 5000, ?)')
			.bind(row!.id, '2026-01-03T00:00:00Z')
			.run();

		const body = await usage();

		// 3000, not 8000: the reclaimed bytes are genuinely gone, and the soft-deleted ones are not.
		expect(body.usage.totalBytes).toBe(3000);
		expect(body.usage.objectCount, 'both rows are still listed, because a record outlives its bytes').toBe(2);
	});

	it('does not count a reclaimed object towards what is protected either', async () => {
		// A protected file that was reclaimed would otherwise add its size to `importantBytes` while contributing
		// nothing to `totalBytes`, so the two figures the interface shows would contradict each other.
		await addObject('/keep', 4000, { important: true });
		await addObject('/keep2', 2000, { important: true });
		const row = await env.DB.prepare("SELECT id FROM objects WHERE object_key = '/keep2'").first<{ id: number }>();
		await env.DB.prepare('INSERT INTO object_reclaims (object_id, bytes_freed, reclaimed_at) VALUES (?, 2000, ?)')
			.bind(row!.id, '2026-01-03T00:00:00Z')
			.run();

		const body = await usage();
		expect(body.usage.totalBytes).toBe(4000);
		expect(body.usage.importantBytes).toBe(4000);
	});
});

/**
 * The panel that shows the budget.
 *
 * The route's numbers are tested above; what is tested here is that the interface actually asks for them and has
 * somewhere to put them. That is not a formality — three of ticket 07's criteria were blocked for two rounds on
 * exactly this, a finished route with no caller, and "the data exists" is not the same as "the operator can see
 * it".
 *
 * The client script cannot be executed here, so these assertions are about structure: the panel exists, it is
 * labelled, and the renderer and the loader are present in the emitted script. A test that ran the DOM would be
 * better and is not available offline; this is the honest limit, stated rather than implied.
 */
describe('the storage panel', () => {
	beforeEach(bootstrap);

	async function page(): Promise<string> {
		const res = await call('/', { headers: { cookie: `linkbin_session=${token}` } });
		expect(res.status).toBe(200);
		return await res.text();
	}

	it('has a panel for the budget, labelled for screen readers', async () => {
		const html = await page();
		expect(html).toContain('id="storage-h"');
		expect(html, 'the heading is translatable').toContain('data-i18n="storage.title"');
		expect(html, 'and the panel is described by it').toMatch(/aria-labelledby="storage-h"/);
	});

	it('has somewhere for the numbers to go', async () => {
		expect(await page()).toContain('id="usage"');
	});

	it('asks the server for the figures and renders them', async () => {
		// Both halves are needed: a loader without a renderer fetches and discards, and a renderer without a
		// loader draws nothing. Asserting only the panel's existence would pass with either missing.
		const html = await page();
		expect(html, 'the loader calls the route').toContain("api('/api/usage')");
		expect(html, 'the renderer exists').toMatch(/function renderUsage\(/);

		// The CALL, not merely the name. An earlier version of this assertion matched /loadUsage\(\)/ anywhere in
		// the file, which the function's own definition satisfies — so it passed with the call removed, which was
		// the one thing it existed to catch. Mutation testing found that; reading it had not.
		const refresh = /function refreshAll\(\)\s*\{[\s\S]*?\n  \}/.exec(html)?.[0] ?? '';
		expect(refresh, 'refreshAll was found in the emitted script').toContain('refreshAll');
		expect(refresh, 'and it calls the loader, so the panel is filled when the page loads').toContain('loadUsage();');
	});

	it('states the per-file limit and the saturated case, because those are the actionable ones', async () => {
		const html = await page();
		// Both are keys the renderer needs; the guard that every used key exists in all four locales is what makes
		// naming them here meaningful rather than decorative.
		expect(html).toContain("t('storage.perFile')");
		expect(html).toContain("t('storage.saturated')");
		expect(html).toContain("u.saturatedByImportant");
	});
});
