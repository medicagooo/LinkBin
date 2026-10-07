import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Marking a stored file important, from the interface.
 *
 * This one flag decides whether the storage budget may reclaim a file, so the properties worth testing are
 * that it takes effect immediately and that it is what the budget actually reads. A flag that is recorded
 * but not consulted would pass a test that only read the flag back.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long interface password';

function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`${BASE}${path}`, init), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

let token = '';

async function bootstrap(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['shares', 'object_flags', 'objects', 'hosts', 'auth_secret', 'auth_attempts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await call('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	const login = await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
	token = /linkbin_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];

	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();
}

async function addObject(path: string, size = 1000): Promise<number> {
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
		 VALUES ('h1', ?, ?, ?, 'hash', '2026-01-01T00:00:00.000Z')`,
	)
		.bind(path, `objects/h1${path}`, size)
		.run();
	return Number(result.meta.last_row_id);
}

function asOperator(path: string, init?: RequestInit): Promise<Response> {
	return call(path, { ...init, headers: { 'content-type': 'application/json', cookie: `linkbin_session=${token}`, ...(init?.headers ?? {}) } });
}

function setImportance(id: number, important: boolean): Promise<Response> {
	return asOperator('/api/objects/importance', { method: 'POST', body: JSON.stringify({ id, important }) });
}

async function usage(): Promise<any> {
	return (await (await asOperator('/api/usage')).json()) as any;
}

async function browse(): Promise<any> {
	return (await (await asOperator('/api/objects')).json()) as any;
}

describe('marking a file important', () => {
	beforeEach(bootstrap);

	it('marks it, and the listing shows it', async () => {
		const id = await addObject('/etc/keep-me');
		expect((await setImportance(id, true)).status).toBe(200);

		const body = await browse();
		expect(body.objects[0].important).toBe(true);
	});

	it('unmarks it again', async () => {
		const id = await addObject('/etc/keep-me');
		await setImportance(id, true);
		await setImportance(id, false);

		expect((await browse()).objects[0].important).toBe(false);
	});

	it('can be applied twice without failing, because presence of the row is the flag', async () => {
		const id = await addObject('/etc/keep-me');
		expect((await setImportance(id, true)).status).toBe(200);
		expect((await setImportance(id, true)).status).toBe(200);
		expect((await browse()).objects[0].important).toBe(true);
	});

	it('can be cleared when it was never set, rather than failing', async () => {
		const id = await addObject('/etc/keep-me');
		expect((await setImportance(id, false)).status).toBe(200);
		expect((await browse()).objects[0].important).toBe(false);
	});

	it('refuses a file that does not exist', async () => {
		expect((await setImportance(999999, true)).status).toBe(404);
	});

	it('refuses a nonsense id', async () => {
		const res = await asOperator('/api/objects/importance', { method: 'POST', body: JSON.stringify({ id: 'abc', important: true }) });
		expect(res.status).toBe(400);
	});

	it('requires a signed-in operator, because it changes what survives the budget', async () => {
		const id = await addObject('/etc/keep-me');
		const res = await call('/api/objects/importance', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, important: true }),
		});
		expect(res.status).toBe(401);
		expect((await browse()).objects[0].important).toBe(false);
	});
});

describe('what the flag is for', () => {
	beforeEach(bootstrap);

	it('is what the budget reports as protected, not a separate record', async () => {
		// The flag exists so the budget never reclaims a file. If the budget read something else, the flag
		// would be decorative and this test would be the only place that noticed.
		const keep = await addObject('/etc/keep-me', 3000);
		await addObject('/var/log/noisy.log', 1000);

		expect((await usage()).usage.importantBytes).toBe(0);

		await setImportance(keep, true);
		expect((await usage()).usage.importantBytes).toBe(3000);
	});

	it('is reflected immediately, with no second step', async () => {
		const id = await addObject('/etc/keep-me', 2048);
		await setImportance(id, true);
		expect((await usage()).usage.importantBytes).toBe(2048);

		await setImportance(id, false);
		expect((await usage()).usage.importantBytes).toBe(0);
	});

	it('does not change what the file is: same path, same size, still shareable', async () => {
		const id = await addObject('/etc/config.yaml', 512);
		await setImportance(id, true);

		const body = await browse();
		expect(body.objects[0].path).toBe('/etc/config.yaml');
		expect(body.objects[0].sizeBytes).toBe(512);
		expect(body.objects[0].live).toBe(true);

		const share = await asOperator('/api/shares', { method: 'POST', body: JSON.stringify({ objectId: id }) });
		expect(share.status).toBe(200);
	});

	it('marks one file without touching another', async () => {
		const first = await addObject('/etc/one');
		await addObject('/etc/two');
		await setImportance(first, true);

		const byPath = new Map((await browse()).objects.map((o: any) => [o.path, o.important]));
		expect(byPath.get('/etc/one')).toBe(true);
		expect(byPath.get('/etc/two')).toBe(false);
	});
});
