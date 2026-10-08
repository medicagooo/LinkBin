/**
 * Managed R2 files and direct downloads. index.ts calls management only after its session gate.
 * Uploads use the existing streaming pipeline, capacity accounting and recoverable version publisher.
 * Direct bearer links resolve host/path on every read; shares remain pinned snapshots in share.ts/index.ts.
 * No R2 token or additional deployment secret is needed. @uploads is a disabled internal owner, not a VPS.
 */
import { newShareToken } from './share';
import { MAX_FILE_BYTES, measureStorage, publishVersion, reclaimVersion, withStorageWriter } from './storage';
import { storeStream } from './store';

export class FileProblem extends Error {
  constructor(public status: number, message: string) { super(message); }
}
interface FileEnv { DB: D1Database; BUCKET: R2Bucket }
interface FileRow { id: number; host_id: string; path: string; object_key: string }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

function objectId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new FileProblem(400, 'a valid stored file id is required');
  return id;
}
async function liveFile(db: D1Database, id: number): Promise<FileRow> {
  const row = await db.prepare('SELECT id, host_id, path, object_key FROM objects WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL')
    .bind(id).first<FileRow>();
  if (!row) throw new FileProblem(404, 'no live stored file with that id');
  return row;
}

/** Shared by operator downloads, direct links and password shares; names are safe HTTP header values. */
export async function downloadFile(bucket: R2Bucket, key: string, path: string, head = false): Promise<Response> {
  const object = head ? await bucket.head(key) : await bucket.get(key);
  if (!object) return json({ ok: false, error: 'the stored file is missing' }, 410);
  const name = path.split(/[\\/]/).pop() || 'download';
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(head ? null : (object as R2ObjectBody).body, { headers: {
    'content-type': 'application/octet-stream', 'content-length': String(object.size),
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  } });
}

export async function serveDirectLink(env: FileEnv, request: Request, token: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const link = await env.DB.prepare('SELECT host_id, path, revoked_at FROM file_links WHERE token = ?').bind(token)
    .first<{ host_id: string; path: string; revoked_at: string | null }>();
  if (!link) return json({ ok: false, error: 'this link is not valid' }, 404);
  if (link.revoked_at) return json({ ok: false, error: 'this link was revoked' }, 410);
  const row = await env.DB.prepare('SELECT object_key FROM objects WHERE host_id = ? AND path = ? AND deleted_at IS NULL AND superseded_by IS NULL ORDER BY id DESC LIMIT 1')
    .bind(link.host_id, link.path).first<{ object_key: string }>();
  if (!row) return json({ ok: false, error: 'this file is no longer stored' }, 410);
  return downloadFile(env.BUCKET, row.object_key, link.path, request.method === 'HEAD');
}

export async function manageFiles(env: FileEnv, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/files/download' && (request.method === 'GET' || request.method === 'HEAD')) {
    const row = await liveFile(env.DB, objectId(url.searchParams.get('id')));
    return downloadFile(env.BUCKET, row.object_key, row.path, request.method === 'HEAD');
  }
  if (path === '/api/files/upload' && request.method === 'POST') {
    const name = url.searchParams.get('name') ?? '';
    if (!name.trim() || name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..') {
      throw new FileProblem(400, 'name must be a filename, at most 200 characters, without slashes or control characters');
    }
    if (!request.body) throw new FileProblem(400, 'a file body is required');
    return withStorageWriter(env, async () => {
      const usage = await measureStorage(env.DB, env.BUCKET);
      const length = request.headers.get('content-length');
      const declaredSize = length === null ? undefined : Number(length);
      if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) throw new FileProblem(400, 'invalid content length');
      const key = `uploads/${crypto.randomUUID()}/${name}`;
      const outcome = await storeStream(request.body!, env.BUCKET, key, { partSize: 8 * 1024 * 1024,
        multipartThreshold: 8 * 1024 * 1024, maxBytes: Math.min(MAX_FILE_BYTES, usage.remainingBytes), declaredSize });
      if (!outcome.ok) throw new FileProblem(413, outcome.problem ?? 'file could not be stored');
      const at = new Date().toISOString();
      try {
        await env.DB.prepare(`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
          VALUES ('@uploads', 'Uploaded files', '-', 0, '-', 0, ?, ?) ON CONFLICT (id) DO NOTHING`).bind(at, at).run();
        const id = await publishVersion(env, { hostId: '@uploads', path: `/${name}`, key, bytes: outcome.bytes, hash: outcome.hash!, mtime: null });
        return json({ ok: true, objectId: id, path: `/${name}`, sizeBytes: outcome.bytes });
      } catch (error) {
        // publishVersion owns cleanup after it has a staging marker; keep charged bytes if cleanup failed.
        const owned = await env.DB.prepare('SELECT id FROM objects WHERE object_key = ?').bind(key).first();
        const pending = await env.DB.prepare('SELECT id FROM multipart_sessions WHERE object_key = ?').bind(key).first();
        if (!owned && !pending) await env.BUCKET.delete(key);
        throw error;
      }
    });
  }
  if (path === '/api/files/delete' && request.method === 'POST') {
    const body = await request.json() as { id?: unknown };
    return withStorageWriter(env, async () => {
      const row = await liveFile(env.DB, objectId(body.id));
      const dependency = await env.DB.prepare(`SELECT output.id FROM object_sources os JOIN objects input ON input.id = os.source_object_id
        JOIN objects output ON output.id = os.object_id WHERE input.host_id = ? AND input.path = ?
        AND output.deleted_at IS NULL AND output.superseded_by IS NULL LIMIT 1`).bind(row.host_id, row.path).first();
      if (dependency) throw new FileProblem(409, 'this file is used by a live combined file; delete the combined file first');
      const at = new Date().toISOString();
      await reclaimVersion(env.DB, env.BUCKET, row.id, at);
      await env.DB.prepare('UPDATE objects SET deleted_at = ? WHERE id = ?').bind(at, row.id).run();
      return json({ ok: true, deleted: row.id });
    });
  }
  if (path === '/api/file-links' && request.method === 'POST') {
    const body = await request.json() as { objectId?: unknown };
    return withStorageWriter(env, async () => {
      const row = await liveFile(env.DB, objectId(body.objectId));
      if (!await env.BUCKET.head(row.object_key)) throw new FileProblem(410, 'the stored file is missing');
      let link = await env.DB.prepare('SELECT token FROM file_links WHERE host_id = ? AND path = ? AND revoked_at IS NULL')
        .bind(row.host_id, row.path).first<{ token: string }>();
      if (!link) {
        link = { token: newShareToken() };
        await env.DB.prepare('INSERT INTO file_links (token, host_id, path, created_at) VALUES (?, ?, ?, ?)')
          .bind(link.token, row.host_id, row.path, new Date().toISOString()).run();
      }
      return json({ ok: true, link: { token: link.token, url: `${url.origin}/d/${link.token}`, path: row.path } });
    });
  }
  if (path === '/api/file-links' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT token, host_id, path, created_at, revoked_at FROM file_links ORDER BY created_at DESC LIMIT 200').all();
    return json({ ok: true, links: (results ?? []).map(link => ({ ...link, url: `${url.origin}/d/${link.token}` })) });
  }
  if (path === '/api/file-links/revoke' && request.method === 'POST') {
    const body = await request.json() as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new FileProblem(400, 'token is required');
    const result = await env.DB.prepare('UPDATE file_links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
      .bind(new Date().toISOString(), body.token).run();
    if (!result.meta.changes) throw new FileProblem(404, 'no active direct link with that token');
    return json({ ok: true });
  }
  return null;
}
