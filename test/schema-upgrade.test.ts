import { env } from 'cloudflare:test';
import worker from '../src/index';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';

function call(path: string, db = env.DB, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${TEST_BASE_URL}${path}`, init),
    { ...(env as object), DB: db, SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
}

async function status(): Promise<any> {
  return (await call('/api/status')).json();
}

describe('an initialized deployment with an additive migration missing', () => {
  beforeEach(async () => {
    await call('/api/admin/apply-schema', env.DB, { method: 'POST' });
    await env.DB.prepare('DELETE FROM auth_secret').run();
    await call('/api/auth/setup', env.DB, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'existing-password-123' }),
    });
    await env.DB.prepare(`INSERT OR IGNORE INTO hosts
      (id, label, address, port, username, enabled, created_at, updated_at)
      VALUES ('upgrade-host', 'Existing', 'host.invalid', 22, 'root', 1, '2026-01-01', '2026-01-01')`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO objects
      (host_id, path, object_key, size_bytes, content_hash, created_at)
      VALUES ('upgrade-host', '/file', 'upgrade/file', 7, 'existing-hash', '2026-01-01')`).run();
    await env.BUCKET.put('upgrade/file', 'content');
    await env.DB.prepare('DROP TABLE source_profiles').run();
  });

  it('upgrades on the first page visit and preserves hosts, objects, password and R2 bytes', async () => {
    const hosts = await env.DB.prepare('SELECT * FROM hosts').all();
    const objects = await env.DB.prepare('SELECT * FROM objects').all();
    const auth = await env.DB.prepare('SELECT * FROM auth_secret').all();
    expect((await status()).schema.missing).toEqual(['source_profiles']);
    expect((await call('/')).status).toBe(200);
    expect((await status()).schema).toEqual({ ready: true, missing: [] });
    expect((await env.DB.prepare('SELECT * FROM hosts').all()).results).toEqual(hosts.results);
    expect((await env.DB.prepare('SELECT * FROM objects').all()).results).toEqual(objects.results);
    expect((await env.DB.prepare('SELECT * FROM auth_secret').all()).results).toEqual(auth.results);
    expect(await (await env.BUCKET.get('upgrade/file'))!.text()).toBe('content');
    const login = await call('/api/auth/login', env.DB, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'existing-password-123' }),
    });
    expect(login.status).toBe(200);
  });

  it('keeps the public status endpoint read-only', async () => {
    expect((await status()).schema.ready).toBe(false);
    expect((await status()).schema.missing).toEqual(['source_profiles']);
  });

  it('also upgrades for API clients without a page visit', async () => {
    const response = await call('/api/auth/state');
    expect(response.status).toBe(200);
    expect((await response.json() as any).configured).toBe(true);
    expect((await status()).schema.ready).toBe(true);
  });

  it('upgrades for WebDAV clients without bypassing authentication', async () => {
    expect((await call('/dav', env.DB, { method: 'PROPFIND' })).status).toBe(401);
    expect((await status()).schema.ready).toBe(true);
  });

  it('shares one migration attempt across concurrent requests and skips DDL once ready', async () => {
    const batch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
    const db = { prepare: env.DB.prepare.bind(env.DB), batch } as unknown as D1Database;
    const responses = await Promise.all([call('/', db), call('/api/auth/state', db), call('/dav', db)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 401]);
    expect((await status()).schema.ready).toBe(true);
    expect(batch).toHaveBeenCalledTimes(2);
    await call('/', db);
    await call('/api/auth/state', db);
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('returns a clean refusal on partial failure and retries on the next request', async () => {
    await env.DB.prepare('DROP INDEX idx_objects_usage').run();
    const hosts = await env.DB.prepare('SELECT * FROM hosts').all();
    const objects = await env.DB.prepare('SELECT * FROM objects').all();
    const auth = await env.DB.prepare('SELECT * FROM auth_secret').all();
    let calls = 0;
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (++calls === 2) throw new Error('simulated migration failure containing private SQL');
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const first = await call('/api/auth/state', db);
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain('private SQL');
    expect((await status()).schema.ready).toBe(false);
    expect((await status()).schema.missing).toEqual(['source_profiles']);
    expect((await call('/api/auth/state', db)).status).toBe(200);
    expect((await status()).schema.ready).toBe(true);
    expect((await env.DB.prepare('SELECT * FROM hosts').all()).results).toEqual(hosts.results);
    expect((await env.DB.prepare('SELECT * FROM objects').all()).results).toEqual(objects.results);
    expect((await env.DB.prepare('SELECT * FROM auth_secret').all()).results).toEqual(auth.results);
    expect(await (await env.BUCKET.get('upgrade/file'))!.text()).toBe('content');
  });

  it('allows independent bindings to repeat the migration concurrently', async () => {
    const hosts = await env.DB.prepare('SELECT * FROM hosts').all();
    const auth = await env.DB.prepare('SELECT * FROM auth_secret').all();
    const firstBatch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
    const secondBatch = vi.fn((statements: D1PreparedStatement[]) => env.DB.batch(statements));
    const first = { prepare: env.DB.prepare.bind(env.DB), batch: firstBatch } as unknown as D1Database;
    const second = { prepare: env.DB.prepare.bind(env.DB), batch: secondBatch } as unknown as D1Database;
    const responses = await Promise.all([call('/api/auth/state', first), call('/api/auth/state', second)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(firstBatch).toHaveBeenCalledTimes(2);
    expect(secondBatch).toHaveBeenCalledTimes(2);
    expect((await status()).schema.ready).toBe(true);
    expect((await env.DB.prepare('SELECT * FROM hosts').all()).results).toEqual(hosts.results);
    expect((await env.DB.prepare('SELECT * FROM auth_secret').all()).results).toEqual(auth.results);
  });

  it.each(['objects', 'auth_secret'])('does not recreate missing core table %s automatically', async (table) => {
    await env.DB.prepare(`DROP TABLE ${table}`).run();
    expect((await call('/api/auth/state')).status).toBe(503);
    await call('/');
    expect((await status()).schema.missing).toContain(table);
    expect((await status()).schema.missing).toContain('source_profiles');
  });
});
