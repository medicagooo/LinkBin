import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Browsing stored files, through the request/response edge.
 *
 * The generated statement is executed here against a real database, which the unit tests on the builder
 * cannot do. That matters because the query joins the importance flag: a column name that collides across
 * the join, or a misplaced alias, produces a statement that looks right and fails only when run.
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
		 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
		        ('h2', 'two', 'b.invalid', 22, 'root', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	).run();
}

async function addObject(over: { host?: string; path: string; size?: number; at?: string; superseded?: boolean; important?: boolean }) {
	const host = over.host ?? 'h1';
	const result = await env.DB.prepare(
		`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at, superseded_by)
		 VALUES (?, ?, ?, ?, 'hash', ?, ?)`,
	)
		.bind(
			host,
			// A superseded version and its replacement share a path — that is what superseding means — so the
			// new version carries a distinguishing suffix internally while the row that is superseded keeps the
			// path the test asserts on.
			over.superseded ? `${over.path}.old` : over.path,
			`objects/${host}${over.path}`,
			over.size ?? 100,
			over.at ?? '2026-01-01T00:00:00.000Z',
			null,
		)
		.run();

	const id = Number(result.meta.last_row_id);

	if (over.superseded) {
		// A real successor, not a dangling id: `superseded_by` is a foreign key, and inventing a value fails
		// the constraint rather than creating the state under test.
		const successor = await env.DB.prepare(
			`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at)
			 VALUES (?, ?, ?, ?, 'hash-2', ?)`,
		)
			.bind(host, over.path, `objects/${host}${over.path}.new`, over.size ?? 100, over.at ?? '2026-01-01T00:00:00.000Z')
			.run();
		await env.DB.prepare('UPDATE objects SET superseded_by = ? WHERE id = ?').bind(Number(successor.meta.last_row_id), id).run();
	}

	if (over.important) {
		await env.DB.prepare('INSERT INTO object_flags (object_id, important, created_at) VALUES (?, 1, ?)')
			.bind(id, '2026-01-01T00:00:00.000Z')
			.run();
	}
	return id;
}

function browse(query = ''): Promise<Response> {
	return call(`/api/objects${query}`, { headers: { cookie: `linkbin_session=${token}` } });
}

describe('listing stored files', () => {
	beforeEach(bootstrap);

	it('returns the files with what the interface needs to show them', async () => {
		await addObject({ path: '/etc/config.yaml', size: 2048 });
		const body = (await (await browse()).json()) as any;

		expect(body.objects.length).toBe(1);
		expect(body.objects[0].path).toBe('/etc/config.yaml');
		expect(body.objects[0].sizeBytes).toBe(2048);
		expect(body.objects[0].hostId).toBe('h1');
		expect(body.objects[0].live).toBe(true);
	});

	it('reports the total separately from the page, so a truncated list is not mistaken for the whole answer', async () => {
		for (let i = 0; i < 5; i++) await addObject({ path: `/etc/file-${i}`, at: `2026-01-0${i + 1}T00:00:00.000Z` });
		const body = (await (await browse('?limit=2')).json()) as any;

		expect(body.objects.length).toBe(2);
		expect(body.total).toBe(5);
		expect(body.limit).toBe(2);
	});

	it('lists newest first', async () => {
		await addObject({ path: '/old', at: '2026-01-01T00:00:00.000Z' });
		await addObject({ path: '/new', at: '2026-06-01T00:00:00.000Z' });
		const body = (await (await browse()).json()) as any;
		expect(body.objects[0].path).toBe('/new');
	});

	it('hides superseded versions by default and shows them when history is asked for', async () => {
		await addObject({ path: '/current' });
		// Superseding creates a replacement row, and that replacement is live — so it is expected in both
		// answers. What changes with `history=1` is that the older version appears as well.
		await addObject({ path: '/replaced', superseded: true, at: '2026-02-01T00:00:00.000Z' });

		const without = (await (await browse()).json()) as any;
		const withHistory = (await (await browse('?history=1')).json()) as any;

		expect(without.objects.map((o: any) => o.path).sort()).toEqual(['/current', '/replaced']);
		expect(without.objects.every((o: any) => o.superseded === false)).toBe(true);
		expect(withHistory.objects.length).toBe(3);
		expect(withHistory.objects.filter((o: any) => o.superseded).length).toBe(1);
	});

	it('marks a superseded version as not live, because its bytes may already be gone', async () => {
		await addObject({ path: '/replaced', superseded: true });
		const body = (await (await browse('?history=1')).json()) as any;

		const old = body.objects.find((o: any) => o.superseded);
		expect(old.live).toBe(false);
		expect(old.path).toBe('/replaced.old');

		// And the replacement is live, which is the difference the flag exists to express.
		const replacement = body.objects.find((o: any) => !o.superseded);
		expect(replacement.live).toBe(true);
	});

	it('shows which files are protected from eviction', async () => {
		await addObject({ path: '/keep', important: true });
		await addObject({ path: '/ordinary', at: '2026-02-01T00:00:00.000Z' });
		const body = (await (await browse()).json()) as any;
		expect(body.objects.find((o: any) => o.path === '/keep').important).toBe(true);
		expect(body.objects.find((o: any) => o.path === '/ordinary').important).toBe(false);
	});

	it('requires a signed-in operator', async () => {
		expect((await call('/api/objects')).status).toBe(401);
	});
});

describe('searching', () => {
	beforeEach(async () => {
		await bootstrap();
		await addObject({ host: 'h1', path: '/var/log/nginx/access.log', at: '2026-01-01T00:00:00.000Z' });
		await addObject({ host: 'h1', path: '/var/log/nginx/error.log', at: '2026-01-02T00:00:00.000Z' });
		await addObject({ host: 'h2', path: '/etc/nginx.conf', at: '2026-01-03T00:00:00.000Z' });
		await addObject({ host: 'h2', path: '/etc/hostname', at: '2026-01-04T00:00:00.000Z' });
	});

	it('finds files by a directory name in the middle of the path', async () => {
		// The most likely thing anyone types. A name-only search would return nothing here.
		const body = (await (await browse('?q=nginx')).json()) as any;
		expect(body.objects.length).toBe(3);
		expect(body.total).toBe(3);
	});

	it('finds files by a partial name', async () => {
		const body = (await (await browse('?q=error')).json()) as any;
		expect(body.objects.length).toBe(1);
		expect(body.objects[0].path).toBe('/var/log/nginx/error.log');
	});

	it('filters by a directory prefix', async () => {
		const body = (await (await browse('?pattern=/var/log')).json()) as any;
		expect(body.objects.length).toBe(2);
	});

	it('filters by a wildcard pattern', async () => {
		const body = (await (await browse('?pattern=/etc/*.conf')).json()) as any;
		expect(body.objects.length).toBe(1);
		expect(body.objects[0].path).toBe('/etc/nginx.conf');
	});

	it('combines a machine with a search', async () => {
		const body = (await (await browse('?host=h2&q=nginx')).json()) as any;
		expect(body.objects.length).toBe(1);
		expect(body.objects[0].path).toBe('/etc/nginx.conf');
	});

	it('reports nothing found rather than everything, for a term that matches nothing', async () => {
		const body = (await (await browse('?q=nothing-matches-this')).json()) as any;
		expect(body.objects).toEqual([]);
		expect(body.total).toBe(0);
	});

	it('treats a literal percent sign as a character rather than a wildcard', async () => {
		// Otherwise searching for "100%" returns everything, which reads as the filter being ignored.
		const body = (await (await browse('?q=100%25')).json()) as any;
		expect(body.objects).toEqual([]);
	});

	it('survives a search term that looks like SQL', async () => {
		// The value is parameterised, so this is about the statement still being valid rather than about the
		// result. It is checked because a query assembled from strings is where this usually goes wrong.
		const res = await browse(`?q=${encodeURIComponent("' OR 1=1; DROP TABLE objects; --")}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.objects).toEqual([]);

		// And the table is still there.
		expect(((await (await browse()).json()) as any).total).toBe(4);
	});

	it('ignores a blank search rather than treating it as a match-everything', async () => {
		const body = (await (await browse('?q=%20%20')).json()) as any;
		expect(body.total).toBe(4);
	});
});

describe('sorting', () => {
	beforeEach(async () => {
		await bootstrap();
		await addObject({ path: '/small', size: 10, at: '2026-01-01T00:00:00.000Z' });
		await addObject({ path: '/large', size: 9000, at: '2026-02-01T00:00:00.000Z' });
		await addObject({ path: '/medium', size: 500, at: '2026-03-01T00:00:00.000Z' });
	});

	it('sorts by size when asked', async () => {
		expect(((await (await browse('?sort=largest')).json()) as any).objects.map((o: any) => o.path)).toEqual([
			'/large',
			'/medium',
			'/small',
		]);
		expect(((await (await browse('?sort=smallest')).json()) as any).objects.map((o: any) => o.path)).toEqual([
			'/small',
			'/medium',
			'/large',
		]);
	});

	it('sorts by path when asked', async () => {
		expect(((await (await browse('?sort=path')).json()) as any).objects.map((o: any) => o.path)).toEqual([
			'/large',
			'/medium',
			'/small',
		]);
	});

	it('falls back to newest for a sort it does not recognise', async () => {
		const body = (await (await browse('?sort=not-a-sort')).json()) as any;
		expect(body.objects[0].path).toBe('/medium');
	});
});
