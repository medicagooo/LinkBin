import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { collectionPorts, cursorFor, openRun } from '../src/collect-store';
import { collectFrom, MAX_FILES_PER_RUN } from '../src/collect';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import type { RemoteHost } from '../src/remote';
import { withStorageWriter } from '../src/storage';
import { storeStream } from '../src/store';

const GB = 1024 ** 3;
let cookie = '';
const call = (path: string, init: RequestInit = {}, extra: Record<string, unknown> = {}) =>
	worker.fetch(new Request(TEST_BASE_URL + path, init), { ...env, SSH_MASTER_KEY: TEST_MASTER_KEY, ...extra } as never, {} as never);
const post = (path: string, body: unknown = {}, extra: Record<string, unknown> = {}) =>
	call(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }, extra);
const stream = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
function machine(count = 2): RemoteHost {
	return {
		async list() { return Array.from({ length: count }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}.txt`, size: 1, isDirectory: false })); },
		async stat() { return { size: 1, isDirectory: false }; },
		async read() { return stream('x'); },
	};
}
async function live(path = '/data/a.txt') {
	return (await env.DB.prepare('SELECT * FROM objects WHERE host_id = ? AND path = ? AND deleted_at IS NULL AND superseded_by IS NULL').bind('h1', path).first()) as any;
}
async function seedHeld(size: number, important = true) {
	await env.BUCKET.put('review/filler', 'x');
	const inserted = await env.DB.prepare("INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, created_at) VALUES ('h1', '/filler', 'review/filler', ?, 'filler', '2020-01-01')").bind(size).run();
	if (important) await env.DB.prepare("INSERT INTO object_flags (object_id, important, created_at) VALUES (?, 1, '2020-01-01')").bind(inserted.meta.last_row_id).run();
}
beforeEach(async () => {
	await call('/api/admin/apply-schema', { method: 'POST' });
	for (const table of ['object_reclaims', 'object_sources', 'derived_objects', 'derived_rules', 'object_flags', 'shares', 'multipart_sessions', 'objects', 'collection_issues', 'collection_runs', 'source_rules', 'auth_attempts', 'auth_secret']) await env.DB.prepare(`DELETE FROM ${table}`).run();
	await env.DB.prepare("DELETE FROM hosts WHERE id != '@derived'").run();
	await env.DB.prepare("INSERT INTO hosts (id,label,address,username,enabled,created_at,updated_at) VALUES ('h1','h1','h1.invalid','root',1,'2020-01-01','2020-01-01')").run();
	const listed = await env.BUCKET.list();
	if (listed.objects.length) await env.BUCKET.delete(listed.objects.map(o => o.key));
	const setup = await post('/api/auth/setup', { password: 'review regression password' });
	expect(setup.status).toBe(200);
	const login = await post('/api/auth/login', { password: 'review regression password' });
	cookie = /(linkbin_session=[^;]+)/.exec(login.headers.get('set-cookie') ?? '')![1];
});
describe('review regressions through real storage and HTTP', () => {
	it('a corrupt saved rule does not affect an explicit build of another rule', async () => {
		const valid = await (await post('/api/derived', { outputName: 'valid.txt', combination: 'concat', sources: [{ hostId: 'h1', pattern: '/data/*.txt' }] })).json() as any;
		await env.DB.prepare("INSERT INTO derived_rules (id,output_name,rule_json,signature,created_at,updated_at) VALUES ('aaa-corrupt','corrupt.txt','null','old','2020-01-01','2020-01-01')").run();
		await env.DB.prepare("INSERT INTO source_rules (pattern,is_exclude,enabled,created_at) VALUES ('/data/*.txt',0,1,'2020-01-01')").run();
		const result = await post('/api/collect', {}, { TEST_REMOTE: machine(1) });
		expect(result.status).toBe(200);
		expect(await post('/api/derived/run', { id: valid.id })).toMatchObject({ status: 200 });
		const output = await env.DB.prepare("SELECT object_key FROM objects WHERE host_id='@derived' AND path='/valid.txt' AND deleted_at IS NULL").first<{object_key: string}>();
		expect(output).not.toBeNull();
		expect(await (await env.BUCKET.get(output!.object_key))!.text()).toBe('x\n');
		expect(await env.DB.prepare("SELECT reason FROM collection_issues WHERE kind='merge_failed'").first()).toBeNull();
	});
	it('recovers an interrupted publication and restores the protected predecessor', async () => {
        const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
        await ports.store({ path: '/data/a.txt', stream: stream('good'), mtime: null });
        const previous = await live();
        await env.DB.prepare("INSERT INTO object_flags (object_id,important,created_at) VALUES (?,1,'2020-01-01')").bind(previous.id).run();
        await env.BUCKET.put('review/pending', 'bad');
        const staged = await env.DB.prepare("INSERT INTO objects (host_id,path,object_key,size_bytes,content_hash,created_at,deleted_at) VALUES ('h1','/data/a.txt','review/pending',3,'bad','2020-01-01','2020-01-01')").run();
        await env.DB.prepare("INSERT INTO object_flags (object_id,important,created_at) VALUES (?,1,'2020-01-01')").bind(staged.meta.last_row_id).run();
        await env.DB.prepare("UPDATE objects SET deleted_at='2020-01-01' WHERE id=?").bind(previous.id).run();
        await env.DB.prepare(`INSERT INTO multipart_sessions (id,host_id,path,object_key,upload_id,total_bytes,part_size,parts_json,state,created_at,updated_at)
            VALUES ('pending','h1','/data/a.txt','review/pending','publication',3,0,?,'publishing','2020-01-01','2020-01-01')`).bind(JSON.stringify({ previousId: previous.id })).run();
        await withStorageWriter(env, async () => {});
        expect((await live()).id).toBe(previous.id);
        expect(await env.DB.prepare('SELECT important FROM object_flags WHERE object_id=?').bind(previous.id).first('important')).toBe(1);
        expect(await env.BUCKET.get('review/pending')).toBeNull();
        expect(await (await env.BUCKET.get(previous.object_key))!.text()).toBe('good');
    });
	it('includes every metadata page and abandoned R2 bytes in capacity accounting', async () => {
        await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
            INSERT INTO objects (host_id,path,object_key,size_bytes,content_hash,created_at)
            SELECT 'h1','/page/'||x,'page/'||x,1,'x','2020-01-01' FROM n`).run();
        await env.BUCKET.put('objects/orphaned-write', 'lost');
        const usage = await (await call('/api/usage', { headers: { cookie } })).json() as any;
        expect(usage.usage.totalBytes).toBe(5005);
    });
	it('serializes competing writers without stealing an active lease', async () => {
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const first = withStorageWriter(env.DB, async () => { entered(); await waiting; });
        await ready;
        await expect(withStorageWriter(env.DB, async () => {})).rejects.toThrow(/another storage operation/);
        release();
        await first;
        await expect(withStorageWriter(env.DB, async () => 'released')).resolves.toBe('released');
    });
	it('a failed protection write keeps the protected predecessor live', async () => {
        const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
        await ports.store({ path: '/data/a.txt', stream: stream('good'), mtime: null });
        const previous = await live();
        await env.DB.prepare("INSERT INTO object_flags (object_id,important,created_at) VALUES (?,1,'2020-01-01')").bind(previous.id).run();
        const db = new Proxy(env.DB, { get(target, key) {
            if (key === 'prepare') return (sql: string) => {
                const statement = target.prepare(sql);
                if (!sql.startsWith('INSERT OR IGNORE INTO object_flags')) return statement;
                const failing = { bind: (...args: unknown[]) => { statement.bind(...args); return failing; }, run: async () => { throw new Error('injected protection failure'); } };
                return failing;
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
        const failing = collectionPorts({ DB: db, BUCKET: env.BUCKET }, 'h1', await openRun(env.DB, 'h1', null));
        await expect(failing.store({ path: '/data/a.txt', stream: stream('replacement'), mtime: null })).rejects.toThrow(/protection failure/);
        expect((await live()).id).toBe(previous.id);
        expect(await (await env.BUCKET.get(previous.object_key))!.text()).toBe('good');
    });
	it('does not evict the current version during its own failed refresh', async () => {
        const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
        await ports.store({ path: '/data/a.txt', stream: stream('good'), mtime: null });
        const previous = await live();
        await seedHeld(10 * GB - 4);
        expect((await ports.canStore({ path: '/data/a.txt', size: 4 })).ok).toBe(false);
        expect(await (await env.BUCKET.get(previous.object_key))!.text()).toBe('good');
    });
	it('bounds a stalled source read by the time budget', async () => {
        const source = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
        const outcome = await storeStream(source, env.BUCKET, 'review/stalled', { partSize: 8 * 1024 ** 2, multipartThreshold: 8 * 1024 ** 2, deadline: Date.now() + 20 });
        expect(outcome.ok).toBe(false);
        expect(outcome.problem).toMatch(/time budget/);
    });
	it('deleting a host reclaims its bytes before cascading away metadata', async () => {
        const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
        await ports.store({ path: '/data/a.txt', stream: stream('gone'), mtime: null });
        const key = (await live()).object_key;
        const deleted = await post('/api/hosts/delete', { id: 'h1' });
        expect(deleted.status, await deleted.text()).toBe(200);
        expect(await env.BUCKET.get(key)).toBeNull();
    });
	it('builds dependent merges and refuses path/glob cycles at definition time', async () => {
        const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
        await ports.store({ path: '/data/f00000.txt', stream: stream('source'), mtime: null });
        await post('/api/derived', { outputName: 'a.txt', combination: 'concat', sources: [{ hostId: 'h1', pattern: '/data/*.txt' }] });
        await post('/api/derived', { outputName: 'b.txt', combination: 'concat', sources: [{ hostId: '@derived', pattern: '/a.txt' }] });
        await env.DB.prepare("INSERT INTO source_rules (pattern,is_exclude,enabled,created_at) VALUES ('/data/*.txt',0,1,'2020-01-01')").run();
        await post('/api/collect', {}, { TEST_REMOTE: machine(1) });
        const a = await (await call('/api/derived/status', { headers: { cookie } })).json() as any;
        const aRule = a.rules.find((rule: any) => rule.outputName === 'a.txt');
        const bRule = a.rules.find((rule: any) => rule.outputName === 'b.txt');
        expect(await post('/api/derived/run', { id: aRule.ruleId })).toMatchObject({ status: 200 });
        expect(await post('/api/derived/run', { id: bRule.ruleId })).toMatchObject({ status: 200 });
        const key = await env.DB.prepare("SELECT object_key FROM objects WHERE host_id='@derived' AND path='/b.txt' AND deleted_at IS NULL").first<string>('object_key');
        expect(key).toBeTruthy();
        expect(await (await env.BUCKET.get(key!))!.text()).toBe('x\n');
        expect((await post('/api/derived', { outputName: 'a.txt', combination: 'concat', sources: [{ hostId: '@derived', pattern: '/b.txt' }] })).status).toBe(400);
    });
	it('enforces the file ceiling when the source never reports its size', async () => {
        const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
        let remaining = 101;
        const source = new ReadableStream<Uint8Array>({ pull(controller) {
            if (remaining-- > 0) controller.enqueue(new Uint8Array(1024 ** 2));
            else controller.close();
        } });
        const result = await ports.store({ path: '/data/unknown.bin', stream: source, mtime: null });
        expect(result.ok).toBe(false);
        expect((result as any).skipped).toBe(true);
        expect(await live('/data/unknown.bin')).toBeNull();
    });
	it('reads a deliberately stopped cursor and does not revive it after a completed scan', async () => {
		await env.DB.prepare("INSERT INTO source_rules (pattern, is_exclude, enabled, created_at) VALUES ('/data/*.txt',0,1,'2020-01-01')").run();
		await env.DB.prepare("INSERT INTO collection_runs (host_id,state,started_at,cursor_json) VALUES ('h1','stopped','2020-01-01',?)").bind(cursorFor('h1', 1, '2020-01-01')).run();
		const first = await (await post('/api/collect', {}, { TEST_REMOTE: machine() })).json() as any;
		expect(first.resumeFrom).toBe('1');
		expect(first.totals.stored).toBe(1);
		const second = await (await post('/api/collect', {}, { TEST_REMOTE: machine() })).json() as any;
		expect(second.resumeFrom).toBeNull();
		expect(second.totals.stored).toBe(1);
	});
	it('bounds an unknown or growing stream by remaining capacity', async () => {
		await seedHeld(10 * GB - 2);
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		const result = await ports.store({ path: '/data/a.txt', stream: stream('four'), mtime: null });
		expect(result.ok).toBe(false);
		expect(await live()).toBeNull();
	});
	it('automatically reclaims an unprotected oldest object before reading a new file', async () => {
		await seedHeld(10 * GB, false);
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		expect((await ports.canStore({ path: '/data/a.txt', size: 4 })).ok).toBe(true);
		expect(await env.BUCKET.get('review/filler')).toBeNull();
	});
	it('preserves protection and accounts only bytes still held after a replacement', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.txt', stream: stream('old'), mtime: null });
		const old = await live();
		await env.DB.prepare("INSERT INTO object_flags (object_id, important, created_at) VALUES (?,1,'2020-01-01')").bind(old.id).run();
		await ports.store({ path: '/data/a.txt', stream: stream('newer'), mtime: null });
		const current = await live();
		expect(await env.DB.prepare('SELECT important FROM object_flags WHERE object_id = ?').bind(current.id).first('important')).toBe(1);
		const usage = await (await call('/api/usage', { headers: { cookie } })).json() as any;
		expect(usage.usage.totalBytes).toBe(5);
	});
	it('a share of a replaced version never discloses the replacement', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.txt', stream: stream('shared'), mtime: null });
		const shared = await (await post('/api/shares', { objectId: (await live()).id })).json() as any;
		await ports.store({ path: '/data/a.txt', stream: stream('private replacement'), mtime: null });
		const download = await call(`/s/${shared.share.token}`);
		expect(download.status).toBe(410);
	});
	it('a failed replacement write preserves the previous collected file', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.txt', stream: stream('good'), mtime: null });
		const previous = await live();
		const bucket = new Proxy(env.BUCKET, { get(target, key) { if (key === 'put') return async () => { throw new Error('injected R2 failure'); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
		const failing = collectionPorts({ DB: env.DB, BUCKET: bucket }, 'h1', await openRun(env.DB, 'h1', null));
		expect((await failing.store({ path: '/data/a.txt', stream: stream('bad'), mtime: null })).ok).toBe(false);
		expect((await live()).id).toBe(previous.id);
		expect(await (await env.BUCKET.get(previous.object_key))!.text()).toBe('good');
	});
	it('failed derived storage leaves the last good output live', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/a.txt', stream: stream('good'), mtime: null });
		const rule = await (await post('/api/derived', { outputName: 'merged.txt', combination: 'concat', sources: [{ pattern: '/data/*.txt' }] })).json() as any;
		expect((await post('/api/derived/run', { id: rule.id })).status).toBe(200);
		const previous = await env.DB.prepare("SELECT * FROM objects WHERE host_id = '@derived' AND deleted_at IS NULL").first() as any;
		const bucket = new Proxy(env.BUCKET, { get(target, key) { if (key === 'put') return async () => { throw new Error('injected R2 failure'); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
		expect((await post('/api/derived/run', { id: rule.id }, { BUCKET: bucket })).status).toBe(500);
		expect(await env.DB.prepare('SELECT deleted_at FROM objects WHERE id = ?').bind(previous.id).first('deleted_at')).toBeNull();
		expect(await (await env.BUCKET.get(previous.object_key))!.text()).toBe('good\n');
	});
	it('protects merge inputs and refreshes saved output after collection changes one', async () => {
		const ports = collectionPorts(env, 'h1', await openRun(env.DB, 'h1', null));
		await ports.store({ path: '/data/f00000.txt', stream: stream('old'), mtime: null });
		const rule = await (await post('/api/derived', { outputName: 'merged.txt', combination: 'concat', sources: [{ pattern: '/data/*.txt' }] })).json() as any;
		await post('/api/derived/run', { id: rule.id });
		const usage = await (await call('/api/usage', { headers: { cookie } })).json() as any;
		expect(usage.usage.importantBytes).toBe(usage.usage.totalBytes);
		await env.DB.prepare("INSERT INTO source_rules (pattern,is_exclude,enabled,created_at) VALUES ('/data/*.txt',0,1,'2020-01-01')").run();
		const collected = await (await post('/api/collect', {}, { TEST_REMOTE: machine(1) })).json() as any;
		expect(collected.totals.stored, JSON.stringify(collected)).toBe(1);
		const issues = await env.DB.prepare('SELECT reason FROM collection_issues').all();
		expect(issues.results).toEqual([]);
		const output = await env.DB.prepare("SELECT object_key FROM objects WHERE host_id = '@derived' AND deleted_at IS NULL").first<string>('object_key');
        expect(await (await env.BUCKET.get(output!))!.text()).toBe('old\n');
        expect(await post('/api/derived/run', { id: rule.id })).toMatchObject({ status: 200 });
        const rebuilt = await env.DB.prepare("SELECT object_key FROM objects WHERE host_id = '@derived' AND deleted_at IS NULL").first<string>('object_key');
        expect(await (await env.BUCKET.get(rebuilt!))!.text()).toBe('x\n');
	});
});
describe('collection completion boundaries', () => {
	const ports = () => ({ rules: [{ pattern: '/data/*.txt', is_exclude: 0, host_id: null }], canStore: async () => ({ ok: true as const }), store: async () => ({ ok: true as const, bytes: 1, hash: 'x', unchanged: false }), recordIssue: async () => {} });
	it('stops at the per-run file cap and resumes through the rest of the rule', async () => {
		const first = await collectFrom(machine(MAX_FILES_PER_RUN + 3), ports());
		expect(first.stoppedEarly).toBe(true);
		const second = await collectFrom(machine(MAX_FILES_PER_RUN + 3), { ...ports(), resumeFrom: first.resumed });
		expect(second.totals.stored).toBe(3);
		expect(second.stoppedEarly).toBe(false);
	});
	it('does not advance past a file whose stream ran out of time', async () => {
		let clock = 0;
		const result = await collectFrom(machine(), { ...ports(), deadline: 10, now: () => clock, store: async () => { clock = 10; return { ok: false as const, reason: "the run's time budget ran out", skipped: false, size: null }; } });
		expect(result.stoppedEarly).toBe(true);
		expect(result.resumed).toBe(0);
	});
	it('resolves directory wildcards during collection', async () => {
		const remote: RemoteHost = { ...machine(), async list(dir) { if (dir === '/data') return [{ name: 'app', size: 0, isDirectory: true }]; if (dir === '/data/app') return [{ name: 'one.txt', size: 1, isDirectory: false }]; throw new Error('unexpected directory'); } };
		const result = await collectFrom(remote, { ...ports(), rules: [{ pattern: '/data/*/*.txt', is_exclude: 0, host_id: null }] });
		expect(result.outcomes.map(o => o.path)).toEqual(['/data/app/one.txt']);
	});
});
