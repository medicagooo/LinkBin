import { env } from 'cloudflare:test';
import worker from '../src/index';
import { COLLECTION_MATCH_LIMIT, resolveRules, type RemoteHost } from '../src/remote';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Collection rules, and what they resolve to on a machine.
 *
 * Rules decide which files are ever looked at, so the properties worth testing are the ones that
 * silently do the wrong thing if they break: an exclusion that loses to an inclusion collects a file the
 * operator deliberately skipped, and a rule that cannot be resolved looks exactly like a rule that
 * matched nothing.
 *
 * Everything here goes through the Worker's request/response edge, including rule resolution, which is
 * driven by substituting the remote machine through an environment binding. Production has no such
 * binding, so the fake cannot reach production code paths.
 */

const BASE = TEST_BASE_URL;
const PASSWORD = 'a sufficiently long password';

/**
 * A valid master key for tests.
 *
 * Credentials are encrypted with the master key, so saving a host is refused outright when none is set
 * — which is the correct behaviour and not something to weaken for the sake of a test. A fixed value is
 * used rather than the developer's own, so a test run cannot depend on local state.
 */


/** A stand-in machine. Files are given per directory so resolution has something real to match. */
function fakeMachine(files: Record<string, { name: string; size?: number; isDirectory?: boolean }[]>) {
	return {
		list: async (dir: string) =>
			(files[dir] ?? []).map((f) => ({ name: f.name, size: f.size ?? 1, mtime: 0, isDirectory: f.isDirectory ?? false })),
		stat: async () => ({ size: 1, mtime: 0, isDirectory: false }),
		read: async () => new Uint8Array() as unknown as ReadableStream<Uint8Array>,
		exec: async (command: string) => (command.startsWith('uname') ? 'FakeOS 1.0' : 'fake'),
	};
}

function call(path: string, init?: RequestInit, remote?: unknown): Promise<Response> {
	// The master key is supplied explicitly: without one, saving a host is refused, because encrypting a
	// credential with no key is exactly the case that must not silently succeed.
	const target: Record<string, unknown> = { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY };
	if (remote) target.TEST_REMOTE = remote;
	return worker.fetch(new Request(`${BASE}${path}`, init), target as never, {} as never);
}

let token = '';

async function bootstrap(): Promise<void> {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['source_rules', 'hosts', 'auth_secret', 'auth_attempts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await call('/api/auth/setup', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ password: PASSWORD }),
	});
	const login = await call('/api/auth/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ password: PASSWORD }),
	});
	token = /linkbin_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
}

function as(path: string, init?: RequestInit, remote?: unknown): Promise<Response> {
	return call(path, { ...init, headers: { 'content-type': 'application/json', cookie: `linkbin_session=${token}`, ...(init?.headers ?? {}) } }, remote);
}

function addRule(body: unknown): Promise<Response> {
	return as('/api/rules', { method: 'POST', body: JSON.stringify(body) });
}

async function addHost(id: string): Promise<void> {
	const res = await as('/api/hosts', {
		method: 'POST',
		body: JSON.stringify({ id, label: id, address: `${id}.invalid`, port: 22, username: 'root', password: 'a host password' }),
	});
	// Surfaced rather than swallowed: a host that failed to save makes every later assertion in the test
	// fail for an unrelated reason, which is how an afternoon disappears.
	expect(res.status, `saving host ${id} failed: ${JSON.stringify(await res.clone().json())}`).toBe(200);
}

async function rules(): Promise<any[]> {
	return ((await (await as('/api/rules')).json()) as any).rules;
}

describe('defining what to collect', () => {
	beforeEach(bootstrap);

	it('accepts a rule scoped to one machine', async () => {
		await addHost('one');
		const res = await addRule({ pattern: '/var/log/*.log', hostId: 'one' });
		expect(res.status).toBe(200);

		const all = await rules();
		expect(all.length).toBe(1);
		expect(all[0].scope).toBe('host');
		expect(all[0].hostId).toBe('one');
	});

	it('accepts a rule that applies to every machine', async () => {
		await addRule({ pattern: '/etc/hostname' });
		const all = await rules();
		expect(all[0].scope).toBe('global');
		expect(all[0].hostId).toBeNull();
	});

	it('records an exclusion distinguishably from an inclusion', async () => {
		await addRule({ pattern: '/var/log/*.log' });
		await addRule({ pattern: '/var/log/noisy.log', isExclude: true });

		const all = await rules();
		expect(all.find((r) => r.pattern === '/var/log/noisy.log').isExclude).toBe(true);
		expect(all.find((r) => r.pattern === '/var/log/*.log').isExclude).toBe(false);
	});

	it('refuses a pattern that is not an absolute path, and says why', async () => {
		const res = await addRule({ pattern: 'var/log/*.log' });
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toMatch(/absolute/i);
	});

	it('refuses a rule referring to a machine that does not exist', async () => {
		const res = await addRule({ pattern: '/etc/hostname', hostId: 'no-such-host' });
		expect(res.status).toBe(400);
	});

	it('does not create a second copy of an identical rule', async () => {
		await addRule({ pattern: '/etc/hostname' });
		const again = await addRule({ pattern: '/etc/hostname' });
		expect(((await again.json()) as any).deduplicated).toBe(true);
		expect((await rules()).length).toBe(1);
	});

	it('treats the same pattern on a different machine as a different rule', async () => {
		// Scope is part of a rule's identity, or a global rule and a machine rule would collapse into one
		// and the machine rule would silently stop existing.
		await addHost('one');
		await addRule({ pattern: '/etc/hostname' });
		await addRule({ pattern: '/etc/hostname', hostId: 'one' });
		expect((await rules()).length).toBe(2);
	});

	it('can remove a rule', async () => {
		const created = (await (await addRule({ pattern: '/etc/hostname' })).json()) as any;
		const removed = await as('/api/rules/delete', { method: 'POST', body: JSON.stringify({ id: created.id }) });
		expect(removed.status).toBe(200);
		expect((await rules()).length).toBe(0);
	});

	it('keeps rules without any collection ever having run', async () => {
		await addRule({ pattern: '/etc/hostname' });
		const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM source_rules').all<{ n: number }>();
		expect(Number(results?.[0]?.n)).toBe(1);
	});

	it('requires a signed-in operator to define rules', async () => {
		const res = await call('/api/rules', { method: 'POST', body: JSON.stringify({ pattern: '/etc/hostname' }) });
		expect(res.status).toBe(401);
	});
});

describe('which rules apply to which machine', () => {
	beforeEach(async () => {
		await bootstrap();
		await addHost('one');
		await addHost('two');
	});

	it('gives a machine its own rules plus every global rule, and not another machine\u2019s rules', async () => {
		await addRule({ pattern: '/global/*.log' });
		await addRule({ pattern: '/only-one/*.log', hostId: 'one' });

		const machine = fakeMachine({ '/global': [{ name: 'a.log' }], '/only-one': [{ name: 'b.log' }] });

		const forOne = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: 'one' }) }, machine)).json()) as any;
		const forTwo = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: 'two' }) }, machine)).json()) as any;

		expect(forOne.rules.map((r: any) => r.pattern).sort()).toEqual(['/global/*.log', '/only-one/*.log']);
		expect(forTwo.rules.map((r: any) => r.pattern)).toEqual(['/global/*.log']);
	});

	it('orders exclusions first, so an exclusion is never skipped over', async () => {
		// Ordering is not cosmetic: it is what guarantees the exclusion is evaluated before the inclusion
		// it is meant to override.
		await addRule({ pattern: '/var/log/*.log' });
		await addRule({ pattern: '/var/log/noisy.log', isExclude: true });

		const machine = fakeMachine({ '/var/log': [{ name: 'noisy.log' }, { name: 'quiet.log' }] });
		const body = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: 'one' }) }, machine)).json()) as any;

		expect(body.evaluations[0].pattern).toBe('/var/log/noisy.log');
		expect(body.evaluations[0].isExclude).toBe(true);
	});

	it('ignores a disabled rule', async () => {
		await addRule({ pattern: '/global/*.log' });
		await env.DB.prepare('UPDATE source_rules SET enabled = 0').run();

		const machine = fakeMachine({ '/global': [{ name: 'a.log' }] });
		const body = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: 'one' }) }, machine)).json()) as any;
		expect(body.rules.length).toBe(0);
	});
});

describe('resolving a rule against the machine\u2019s filesystem', () => {
	beforeEach(async () => {
		await bootstrap();
		await addHost('one');
	});

	async function evaluate(rule: unknown, files: Record<string, { name: string; isDirectory?: boolean }[]>) {
		await addRule(rule);
		const machine = fakeMachine(files);
		const body = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: 'one' }) }, machine)).json()) as any;
		return body.evaluations[0];
	}

	it('reports the files a rule matched', async () => {
		const result = await evaluate({ pattern: '/var/log/*.log' }, {
			'/var/log': [{ name: 'b.log' }, { name: 'a.log' }, { name: 'notes.txt' }],
		});
		expect(result.status).toBe('ok');
		expect(result.matches).toEqual(['a.log', 'b.log']);
		expect(result.matchCount).toBe(2);
	});

	it('distinguishes a rule that matched nothing from one that cannot be resolved at all', async () => {
		// The property that matters most here. Both look identical to an operator unless the two are
		// reported differently, and one of them means "your rule is fine, the directory is empty" while
		// the other means "this rule was never checked".
		const empty = await evaluate({ pattern: '/var/log/*.log' }, { '/var/log': [] });
		expect(empty.status).toBe('ok');
		expect(empty.matchCount).toBe(0);

		const unresolvable = await evaluate({ pattern: '/var/*/*.log' }, { '/var/log': [{ name: 'a.log' }] });
		expect(unresolvable.status).toBe('needs_collection_step');
		expect(unresolvable.matchCount).toBeUndefined();
		expect(unresolvable.detail).toMatch(/wildcard/i);
	});

	it('reports a directory it cannot read as an error, quoting the machine', async () => {
		await addRule({ pattern: '/root/secret/*.log' });
		const unreadable = {
			list: async () => {
				throw new Error('permission denied');
			},
			stat: async () => ({ size: 1, mtime: 0, isDirectory: false }),
			read: async () => new Uint8Array() as unknown as ReadableStream<Uint8Array>,
		};
		const body = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: 'one' }) }, unreadable)).json()) as any;
		expect(body.evaluations[0].status).toBe('error');
		expect(body.evaluations[0].detail).toContain('permission denied');
	});

	it('matches files only, not directories whose names happen to fit', async () => {
		const result = await evaluate({ pattern: '/*.log' }, {
			'/': [{ name: 'archive.log' }, { name: 'archive.log.d', isDirectory: true }],
		});
		expect(result.matches).toEqual(['archive.log']);
	});

	it('still reports the connection timings, so a slow machine is visible', async () => {
		await addRule({ pattern: '/etc/*' });
		const machine = fakeMachine({ '/etc': [{ name: 'hostname' }] });
		const body = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: 'one' }) }, machine)).json()) as any;
		expect(Array.isArray(body.stages)).toBe(true);
		expect(body.stages.length).toBeGreaterThan(0);
		expect(body.stages.every((s: any) => typeof s.ms === 'number')).toBe(true);
	});
});

describe('an exclusion beats an inclusion', () => {
	beforeEach(async () => {
		await bootstrap();
		await addHost('one');
		await addHost('two');
	});

	/**
	 * The decision under test, exercised through the real evaluations the Worker produces.
	 *
	 * Ordering the rules is necessary but not sufficient: something has to subtract, or an exclusion is a
	 * note rather than a decision. Checking the two halves together is what makes this evidence.
	 */
	async function collection(hostId: string, files: Record<string, { name: string; isDirectory?: boolean }[]>) {
		const machine = fakeMachine(files);
		const body = (await (await as('/api/hosts/test', { method: 'POST', body: JSON.stringify({ id: hostId }) }, machine)).json()) as any;
		const { filesToCollect } = await import('../src/remote');
		return filesToCollect(body.evaluations).map((f) => f.path);
	}

	it('collects a directory while skipping one file inside it', async () => {
		await addRule({ pattern: '/var/log/*.log' });
		await addRule({ pattern: '/var/log/noisy.log', isExclude: true });

		const paths = await collection('one', { '/var/log': [{ name: 'noisy.log' }, { name: 'quiet.log' }] });
		expect(paths).toEqual(['/var/log/quiet.log']);
	});

	it('lets a per-machine exclusion beat a global inclusion', async () => {
		// The case worth getting wrong: a global rule collecting everything, narrowed for one machine. If
		// precedence went the other way, a file the operator explicitly excluded would be collected.
		await addRule({ pattern: '/etc/nginx/*.conf' });
		await addRule({ pattern: '/etc/nginx/secret.conf', isExclude: true, hostId: 'one' });

		const forOne = await collection('one', { '/etc/nginx': [{ name: 'secret.conf' }, { name: 'site.conf' }] });
		const forTwo = await collection('two', { '/etc/nginx': [{ name: 'secret.conf' }, { name: 'site.conf' }] });

		expect(forOne).toEqual(['/etc/nginx/site.conf']);
		// The other machine carries no such exclusion, so it still collects both.
		expect(forTwo).toEqual(['/etc/nginx/secret.conf', '/etc/nginx/site.conf']);
	});

	it('lets a global exclusion beat a per-machine inclusion', async () => {
		await addRule({ pattern: '/srv/data/*.bak', isExclude: true });
		await addRule({ pattern: '/srv/data/*.bak', hostId: 'one' });

		expect(await collection('one', { '/srv/data': [{ name: 'old.bak' }] })).toEqual([]);
	});

	it('does not treat an unresolvable rule as if it had excluded anything', async () => {
		// A wildcard directory is reported as needing the collection step. It must not be read as
		// "matched nothing", and must not silently remove what the other rule found either.
		await addRule({ pattern: '/var/*/*.log', isExclude: true });
		await addRule({ pattern: '/var/log/*.log' });

		expect(await collection('one', { '/var/log': [{ name: 'keep.log' }] })).toEqual(['/var/log/keep.log']);
	});

	it('lists a file once even when two rules both match it', async () => {
		await addRule({ pattern: '/etc/*.conf' });
		await addRule({ pattern: '/etc/nginx.conf' });

		expect(await collection('one', { '/etc': [{ name: 'nginx.conf' }] })).toEqual(['/etc/nginx.conf']);
	});
});

describe('how many matched names a rule reports', () => {
	beforeEach(bootstrap);

	/** Resolves one pattern against a machine that offers the given names, without touching the routes. */
	async function resolve(pattern: string, files: Record<string, { name: string; isDirectory?: boolean }[]>, limit?: number) {
		const remote = fakeMachine(files) as unknown as RemoteHost;
		const evaluations = await resolveRules(remote, [{ pattern, is_exclude: 0, host_id: null }], limit);
		return evaluations[0];
	}

	it('reports the true count regardless of how many names it lists', async () => {
		// `matchCount` is what a preview says ("214 files"), and it must not be clipped by a display limit — the
		// whole value of the number is that it is the real one.
		const files = Array.from({ length: 120 }, (_, i) => ({ name: `f${i}.log` }));
		const resolved = await resolve('/var/log/*.log', { '/var/log': files });

		expect(resolved.matchCount).toBe(120);
		expect(resolved.matches?.length, 'the default is a display cap').toBe(50);
	});

	it('lists every name when a collection limit is asked for, so a run does not silently stop at 50', async () => {
		// THE DEFECT THIS EXISTS FOR. `filesToCollect` consumes the names a rule reports, so a caller that used
		// the display default collected the first 50 files per rule and reported a successful run while silently
		// leaving the rest. Nothing said anything was wrong, which is the failure mode this codebase treats as
		// the worst kind. `collectFrom` now passes `COLLECTION_MATCH_LIMIT`; this asserts the mechanism it relies
		// on rather than the call site.
		const files = Array.from({ length: 120 }, (_, i) => ({ name: `f${i}.log` }));
		const resolved = await resolve('/var/log/*.log', { '/var/log': files }, COLLECTION_MATCH_LIMIT);

		expect(resolved.matches?.length, 'a run sees every file it is willing to walk').toBe(120);
		expect(resolved.matchCount).toBe(120);
	});

	it('never reports more names than the true count', async () => {
		// The limit bounds a list; it must not be able to invent entries for a rule that matched fewer.
		const resolved = await resolve('/var/log/*.log', { '/var/log': [{ name: 'only.log' }] }, COLLECTION_MATCH_LIMIT);
		expect(resolved.matches).toEqual(['only.log']);
		expect(resolved.matchCount).toBe(1);
	});
});
