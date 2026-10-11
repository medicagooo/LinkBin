import { MAX_FILE_BYTES, measureStorage, publishVersion, reclaimVersion, withStorageWriter } from './storage';
import { storeStream } from './store';
import type { RemoteHost, RemoteEntry } from './remote';

export interface WebDavStorageEnv { DB: D1Database; BUCKET: R2Bucket }

export class WebDavError extends Error {
	constructor(public readonly status: number, message: string) { super(message); }
}

interface LiveObject {
	id: number;
	host_id: string;
	path: string;
	object_key: string;
	size_bytes: number;
	content_hash: string;
	mtime: number | null;
}

interface DavPath {
	kind: 'root' | 'host' | 'file' | 'directory';
	hostId?: string;
	path?: string;
	object?: LiveObject;
	segments: string[];
}

const DAV_PREFIX = '/dav';
const ALLOW = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, COPY, MOVE';

function xml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function decodeSegments(pathname: string): string[] {
	if (pathname !== DAV_PREFIX && !pathname.startsWith(`${DAV_PREFIX}/`)) throw new WebDavError(404, 'WebDAV route not found');
	const rest = pathname.slice(DAV_PREFIX.length);
	const raw = rest.split('/').filter(Boolean);
	const segments = raw.map((segment) => {
		let decoded: string;
		try { decoded = decodeURIComponent(segment); } catch { throw new WebDavError(400, 'invalid WebDAV path encoding'); }
		if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
			throw new WebDavError(400, 'WebDAV path traversal is not allowed');
		}
		return decoded;
	});
	return segments;
}

function objectPath(segments: string[]): { hostId: string; path: string } | null {
	if (segments.length < 2) return null;
	const hostId = segments[0] === 'uploads' ? '@uploads' : segments[0];
	return { hostId, path: `/${segments.slice(1).join('/')}` };
}

async function liveObject(env: WebDavStorageEnv, hostId: string, path: string): Promise<LiveObject | null> {
	return await env.DB.prepare(`SELECT id, host_id, path, object_key, size_bytes, content_hash, mtime
		FROM objects WHERE host_id = ? AND path = ? AND deleted_at IS NULL AND superseded_by IS NULL`)
		.bind(hostId, path).first<LiveObject>();
}

async function resolvePath(env: WebDavStorageEnv, segments: string[]): Promise<DavPath> {
	if (segments.length === 0) return { kind: 'root', segments };
	if (segments.length === 1) {
		const hostId = segments[0] === 'uploads' ? '@uploads' : segments[0];
		if (hostId === '@uploads') return { kind: 'directory', hostId, path: '/', segments };
		const host = await env.DB.prepare('SELECT id FROM hosts WHERE id = ?').bind(hostId).first();
		if (!host) throw new WebDavError(404, 'WebDAV resource was not found');
		return { kind: 'directory', hostId, path: '/', segments };
	}
	const parsed = objectPath(segments);
	if (!parsed) return { kind: 'host', hostId: segments[0], segments };
	const object = await liveObject(env, parsed.hostId, parsed.path);
	if (object) return { kind: 'file', hostId: parsed.hostId, path: parsed.path, object, segments };
	const prefix = `${parsed.path.replace(/\/$/, '')}/`;
	const child = await env.DB.prepare(`SELECT id FROM objects WHERE host_id = ? AND deleted_at IS NULL AND superseded_by IS NULL AND path LIKE ? LIMIT 1`)
		.bind(parsed.hostId, `${prefix}%`).first();
	if (child) return { kind: 'directory', hostId: parsed.hostId, path: parsed.path, segments };
	const host = await env.DB.prepare('SELECT id FROM hosts WHERE id = ?').bind(parsed.hostId).first();
	if (host && parsed.path === '/') return { kind: 'directory', hostId: parsed.hostId, path: '/', segments };
	throw new WebDavError(404, 'WebDAV resource was not found');
}

function nameOf(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	return trimmed.split('/').pop() || '';
}

function hrefFor(segments: string[], collection = false): string {
	const encoded = segments.map((part) => encodeURIComponent(part)).join('/');
	return `${DAV_PREFIX}/${encoded}${collection && encoded ? '/' : ''}`;
}

function prop(entry: { href: string; name: string; collection: boolean; size?: number; mtime?: number | null; etag?: string }): string {
	const modified = entry.mtime ? new Date(entry.mtime * 1000).toUTCString() : undefined;
	return `<d:response><d:href>${xml(entry.href)}</d:href><d:propstat><d:prop><d:displayname>${xml(entry.name)}</d:displayname>` +
		`<d:resourcetype>${entry.collection ? '<d:collection/>' : ''}</d:resourcetype>` +
		(entry.collection ? '' : `<d:getcontentlength>${entry.size ?? 0}</d:getcontentlength><d:getcontenttype>application/octet-stream</d:getcontenttype>`) +
		(modified ? `<d:getlastmodified>${modified}</d:getlastmodified>` : '') +
		(entry.etag ? `<d:getetag>&quot;${xml(entry.etag)}&quot;</d:getetag>` : '') +
		`</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

async function children(env: WebDavStorageEnv, resolved: DavPath): Promise<string> {
	if (resolved.kind === 'root') {
		const { results } = await env.DB.prepare("SELECT id, label FROM hosts WHERE id NOT IN ('@derived') ORDER BY label LIMIT 200").all<{ id: string; label: string }>();
		const rows = results ?? [];
		if (!rows.some((row) => row.id === '@uploads')) rows.unshift({ id: '@uploads', label: 'Uploaded files' });
		return rows.slice(0, 200).map((row) => {
			const segment = row.id === '@uploads' ? 'uploads' : row.id;
			return prop({ href: hrefFor([segment], true), name: row.label || segment, collection: true });
		}).join('');
	}
	if (!resolved.hostId || !resolved.path) return '';
	const prefix = resolved.path === '/' ? '/' : `${resolved.path.replace(/\/$/, '')}/`;
	const { results } = await env.DB.prepare(`SELECT path, size_bytes, mtime, content_hash FROM objects
		WHERE host_id = ? AND deleted_at IS NULL AND superseded_by IS NULL AND path LIKE ? ORDER BY path LIMIT 500`)
		.bind(resolved.hostId, `${prefix}%`).all<{ path: string; size_bytes: number; mtime: number | null; content_hash: string }>();
	const seen = new Set<string>();
	const output: string[] = [];
	for (const row of results ?? []) {
		const remainder = row.path.slice(prefix.length);
		if (!remainder) continue;
		const first = remainder.split('/')[0];
		if (seen.has(first)) continue;
		seen.add(first);
		const directory = remainder.includes('/');
		const childPath = prefix === '/' ? `/${first}` : `${prefix}${first}`;
		const childSegments = [resolved.hostId === '@uploads' ? 'uploads' : resolved.hostId, ...childPath.split('/').filter(Boolean)];
		output.push(prop({ href: hrefFor(childSegments, directory), name: first, collection: directory, size: directory ? undefined : row.size_bytes, mtime: directory ? null : row.mtime, etag: directory ? undefined : row.content_hash }));
	}
	return output.join('');
}

async function ensureUploads(env: WebDavStorageEnv): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		VALUES ('@uploads', 'Uploaded files', '-', 0, '-', 0, ?, ?) ON CONFLICT (id) DO NOTHING`).bind(now, now).run();
}

function ifMatch(request: Request): string | undefined {
	const value = request.headers.get('if-match');
	if (!value || value === '*') return undefined;
	return value.replace(/^W\//, '').replace(/^"|"$/g, '');
}

async function checkVersion(request: Request, object: LiveObject | null): Promise<void> {
	const expected = ifMatch(request);
	if (expected && (!object || object.content_hash !== expected)) throw new WebDavError(412, 'the resource changed; refresh its ETag and retry');
}

async function putUpload(env: WebDavStorageEnv, path: string, request: Request): Promise<Response> {
	if (!request.body) throw new WebDavError(400, 'a request body is required');
	const current = await liveObject(env, '@uploads', path);
	await checkVersion(request, current);
	const declared = request.headers.get('content-length');
	const declaredSize = declared === null ? undefined : Number(declared);
	if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) throw new WebDavError(400, 'invalid content length');
	if (declaredSize !== undefined && declaredSize > MAX_FILE_BYTES) throw new WebDavError(413, 'the file exceeds the 100 MiB limit');
	return await withStorageWriter(env, async () => {
		const usage = await measureStorage(env.DB, env.BUCKET);
		if (declaredSize !== undefined && usage.totalBytes + declaredSize > usage.budgetBytes) {
			throw new WebDavError(507, `the storage budget has ${usage.remainingBytes} bytes remaining`);
		}
		const key = `uploads/${crypto.randomUUID()}/${nameOf(path)}`;
		const outcome = await storeStream(request.body!, env.BUCKET, key, { partSize: 8 * 1024 * 1024, multipartThreshold: 8 * 1024 * 1024, maxBytes: Math.min(MAX_FILE_BYTES, usage.remainingBytes), declaredSize, deadline: Date.now() + 120_000 });
		if (!outcome.ok) throw new WebDavError(outcome.problem?.includes('budget') ? 507 : 413, outcome.problem ?? 'file could not be stored');
		await ensureUploads(env);
		try {
			await publishVersion(env, { hostId: '@uploads', path, key, bytes: outcome.bytes, hash: outcome.hash!, mtime: null });
		} catch (error) {
			const owned = await env.DB.prepare('SELECT id FROM objects WHERE object_key = ?').bind(key).first();
			if (!owned) await env.BUCKET.delete(key);
			throw error;
		}
		return new Response(null, { status: current ? 204 : 201, headers: { etag: `"${outcome.hash}"` } });
	});
}

async function deleteUpload(env: WebDavStorageEnv, resolved: DavPath, request: Request): Promise<Response> {
	if (resolved.hostId !== '@uploads' || !resolved.object) throw new WebDavError(423, 'collected files are read-only; edit the source collection');
	await checkVersion(request, resolved.object);
	return await withStorageWriter(env, async () => {
		const at = new Date().toISOString();
		await reclaimVersion(env.DB, env.BUCKET, resolved.object!.id, at);
		await env.DB.prepare('UPDATE objects SET deleted_at = ? WHERE id = ?').bind(at, resolved.object!.id).run();
		return new Response(null, { status: 204 });
	});
}

async function copyUpload(env: WebDavStorageEnv, source: DavPath, destination: string, request: Request, move: boolean): Promise<Response> {
	if (source.hostId !== '@uploads' || !source.object || !destination.startsWith('/dav/uploads/')) throw new WebDavError(423, 'only uploaded files can be copied or moved in the R2 library');
	await checkVersion(request, source.object);
	const targetParts = decodeSegments(destination);
	if (targetParts[0] !== 'uploads' || targetParts.length < 2) throw new WebDavError(409, 'the WebDAV destination must be a file');
	const targetPath = `/${targetParts.slice(1).join('/')}`;
	const existing = await liveObject(env, '@uploads', targetPath);
	if (existing && request.headers.get('overwrite')?.toUpperCase() === 'F') throw new WebDavError(412, 'the WebDAV destination already exists');
	const sourceObject = await env.BUCKET.get(source.object.object_key);
	if (!sourceObject?.body) throw new WebDavError(410, 'the source bytes are missing');
	return await withStorageWriter(env, async () => {
		const usage = await measureStorage(env.DB, env.BUCKET);
		if (usage.totalBytes + source.object!.size_bytes > usage.budgetBytes) throw new WebDavError(507, `the storage budget has ${usage.remainingBytes} bytes remaining`);
		const key = `uploads/${crypto.randomUUID()}/${nameOf(targetPath)}`;
		const outcome = await storeStream(sourceObject.body, env.BUCKET, key, { partSize: 8 * 1024 * 1024, multipartThreshold: 8 * 1024 * 1024, maxBytes: Math.min(MAX_FILE_BYTES, usage.remainingBytes), declaredSize: source.object!.size_bytes, deadline: Date.now() + 120_000 });
		if (!outcome.ok) throw new WebDavError(507, outcome.problem ?? 'copy could not be stored');
		await ensureUploads(env);
		await publishVersion(env, { hostId: '@uploads', path: targetPath, key, bytes: outcome.bytes, hash: outcome.hash!, mtime: source.object!.mtime });
		if (move) {
			const at = new Date().toISOString();
			await reclaimVersion(env.DB, env.BUCKET, source.object!.id, at);
			await env.DB.prepare('UPDATE objects SET deleted_at = ? WHERE id = ?').bind(at, source.object!.id).run();
		}
		return new Response(null, { status: existing ? 204 : 201, headers: { etag: `"${outcome.hash}"` } });
	});
}

export async function handleR2WebDav(env: WebDavStorageEnv, request: Request): Promise<Response> {
	const segments = decodeSegments(new URL(request.url).pathname);
	const method = request.method.toUpperCase();
	let resolved: DavPath;
	try {
		resolved = await resolvePath(env, segments);
	} catch (error) {
		if (method === 'PUT' && segments.length >= 2 && segments[0] === 'uploads') {
			resolved = { kind: 'file', hostId: '@uploads', path: `/${segments.slice(1).join('/')}`, segments };
		} else {
			throw error;
		}
	}
	if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: ALLOW, dav: '1' } });
	if (method === 'PROPFIND') {
		const depth = request.headers.get('depth') ?? '1';
		if (depth === 'infinity') throw new WebDavError(400, 'Depth: infinity is not supported');
		if (!['0', '1'].includes(depth)) throw new WebDavError(400, 'Depth must be 0 or 1');
		const own = prop({ href: hrefFor(segments, resolved.kind !== 'file'), name: segments.length ? (resolved.kind === 'host' ? resolved.hostId! : nameOf(resolved.path ?? '')) : 'LinkBin', collection: resolved.kind !== 'file', size: resolved.object?.size_bytes, mtime: resolved.object?.mtime, etag: resolved.object?.content_hash });
		const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${own}${depth === '1' && resolved.kind !== 'file' ? await children(env, resolved) : ''}</d:multistatus>`;
		return new Response(body, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' } });
	}
	if (method === 'GET' || method === 'HEAD') {
		if (resolved.kind !== 'file' || !resolved.object) throw new WebDavError(404, 'WebDAV resource was not found');
		const object = await env.BUCKET.get(resolved.object.object_key);
		if (!object) throw new WebDavError(410, 'the stored bytes are missing');
		return new Response(method === 'HEAD' ? null : object.body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(object.size), etag: `"${resolved.object.content_hash}"`, 'cache-control': 'no-store' } });
	}
	if (method === 'PUT') {
		if (resolved.hostId !== '@uploads' || !resolved.path || resolved.kind === 'directory') throw new WebDavError(423, 'only /dav/uploads files accept writes');
		return await putUpload(env, resolved.path, request);
	}
	if (method === 'DELETE') return await deleteUpload(env, resolved, request);
	if (method === 'COPY' || method === 'MOVE') {
		if (resolved.kind !== 'file') throw new WebDavError(404, 'the source file was not found');
		const destination = request.headers.get('destination');
		if (!destination) throw new WebDavError(400, 'Destination header is required');
		let destinationPath: URL;
		try { destinationPath = new URL(destination, new URL(request.url).origin); } catch { throw new WebDavError(400, 'invalid Destination header'); }
		if (destinationPath.origin !== new URL(request.url).origin) throw new WebDavError(409, 'cross-origin WebDAV copies are not allowed');
		return await copyUpload(env, resolved, destinationPath.pathname, request, method === 'MOVE');
	}
	throw new WebDavError(405, 'WebDAV method is not supported');
}

function sourceRelative(pathname: string, sourceId: string): string[] {
	const prefix = `/dav/sources/${encodeURIComponent(sourceId)}`;
	if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) throw new WebDavError(404, 'WebDAV source route not found');
	const rest = pathname.slice(prefix.length);
	const raw = rest.split('/').filter(Boolean);
	return raw.map((part) => {
		let decoded: string;
		try { decoded = decodeURIComponent(part); } catch { throw new WebDavError(400, 'invalid WebDAV path encoding'); }
		if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) throw new WebDavError(400, 'WebDAV path traversal is not allowed');
		return decoded;
	});
}

function sourcePath(parts: string[]): string {
	return `/${parts.join('/')}`;
}

function sourceHref(sourceId: string, parts: string[], collection: boolean): string {
	return `/dav/sources/${encodeURIComponent(sourceId)}${parts.length ? `/${parts.map(encodeURIComponent).join('/')}` : ''}${collection ? '/' : ''}`;
}

function sourceProp(sourceId: string, parts: string[], entry: { name: string; collection: boolean; size?: number; mtime?: number; version?: string }): string {
	return prop({ href: sourceHref(sourceId, [...parts, entry.name], entry.collection), name: entry.name, collection: entry.collection, size: entry.size, mtime: entry.mtime, etag: entry.version });
}

function remoteStatus(error: unknown): number | undefined {
	const status = Number((error as { status?: unknown })?.status);
	return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

async function remoteStatOrNull(remote: RemoteHost, path: string): Promise<(RemoteEntry & { version?: string }) | null> {
	try {
		return await remote.stat(path) as RemoteEntry & { version?: string };
	} catch (error) {
		if (remoteStatus(error) === 404) return null;
		const status = remoteStatus(error);
		throw new WebDavError(status === 401 || status === 403 ? status : 502, 'the WebDAV source could not be read');
	}
}

function boundedBody(body: ReadableStream<Uint8Array>, limit: number): { stream: ReadableStream<Uint8Array>; exceeded: () => boolean } {
	let total = 0;
	let tooLarge = false;
	const reader = body.getReader();
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await reader.read();
			if (next.done) { controller.close(); return; }
			total += next.value.byteLength;
			if (total > limit) {
				tooLarge = true;
				await reader.cancel('WebDAV file exceeds limit');
				controller.error(new WebDavError(413, 'the file exceeds the 100 MiB limit'));
				return;
			}
			controller.enqueue(next.value);
		},
		cancel(reason) { return reader.cancel(reason); },
	});
	return { stream, exceeded: () => tooLarge };
}

export async function handleRemoteWebDav(sourceId: string, remote: RemoteHost, request: Request): Promise<Response> {
	const parts = sourceRelative(new URL(request.url).pathname, sourceId);
	const path = sourcePath(parts);
	const method = request.method.toUpperCase();
	if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: ALLOW, dav: '1' } });
	const current = await remoteStatOrNull(remote, path);
	if (parts.length && !current && method !== 'PUT') throw new WebDavError(404, 'source resource was not found');
	if (method === 'PROPFIND') {
		const depth = request.headers.get('depth') ?? '1';
		if (!['0', '1'].includes(depth)) throw new WebDavError(400, 'Depth must be 0 or 1');
		const own = prop({ href: sourceHref(sourceId, parts, current?.isDirectory ?? true), name: parts.length ? parts[parts.length - 1] : sourceId, collection: current?.isDirectory ?? true, size: current?.size, mtime: current?.mtime, etag: current?.version });
		let childrenXml = '';
		if (depth === '1' && (current?.isDirectory ?? true)) {
			const entries = await remote.list(path);
			childrenXml = entries.slice(0, 500).map((entry) => sourceProp(sourceId, parts, entry as RemoteEntry & { version?: string })).join('');
		}
		return new Response(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${own}${childrenXml}</d:multistatus>`, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } });
	}
	if (method === 'GET' || method === 'HEAD') {
		if (!current || current.isDirectory) throw new WebDavError(404, 'source file was not found');
		const body = method === 'HEAD' ? null : await remote.read(path);
		return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream', ...(current.size === undefined ? {} : { 'content-length': String(current.size) }), ...(current.version ? { etag: `"${current.version}"` } : {}) } });
	}
	const expected = ifMatch(request);
	if (expected && (!current || current.version !== expected)) throw new WebDavError(412, 'the source changed; refresh its ETag and retry');
	if (method === 'PUT') {
		if (!remote.write || !request.body) throw new WebDavError(423, 'this source is read-only');
		const declared = request.headers.get('content-length');
		const declaredSize = declared === null ? undefined : Number(declared);
		if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) throw new WebDavError(400, 'invalid content length');
		if (declaredSize !== undefined && declaredSize > MAX_FILE_BYTES) throw new WebDavError(413, 'the file exceeds the 100 MiB limit');
		const limited = boundedBody(request.body, MAX_FILE_BYTES);
		try { await remote.write(path, limited.stream, expected); } catch (error) {
			if (limited.exceeded()) throw new WebDavError(413, 'the file exceeds the 100 MiB limit');
			const status = remoteStatus(error);
			throw new WebDavError(status === 401 || status === 403 || status === 412 ? status : 502, 'the WebDAV source could not be written');
		}
		return new Response(null, { status: current ? 204 : 201 });
	}
	if (method === 'DELETE') {
		if (current?.isDirectory) throw new WebDavError(405, 'directories cannot be deleted through this source route');
		if (!remote.remove) throw new WebDavError(423, 'this source is read-only');
		try { await remote.remove(path, expected); } catch (error) {
			const status = remoteStatus(error);
			throw new WebDavError(status === 401 || status === 403 || status === 412 ? status : 502, 'the WebDAV source could not be deleted');
		}
		return new Response(null, { status: 204 });
	}
	if (method === 'COPY' || method === 'MOVE') {
		if (current?.isDirectory) throw new WebDavError(405, 'directories cannot be copied or moved through this source route');
		const destination = request.headers.get('destination');
		if (!destination) throw new WebDavError(400, 'Destination header is required');
		let target: URL;
		try { target = new URL(destination, new URL(request.url).origin); } catch { throw new WebDavError(400, 'invalid Destination header'); }
		if (target.origin !== new URL(request.url).origin) throw new WebDavError(409, 'cross-origin WebDAV copies are not allowed');
		const targetParts = sourceRelative(target.pathname, sourceId);
		const targetPath = sourcePath(targetParts);
		const action = method === 'COPY' ? remote.copy : remote.move;
		if (!action) throw new WebDavError(423, 'this source is read-only');
		const existingTarget = await remoteStatOrNull(remote, targetPath);
		if (existingTarget && request.headers.get('overwrite')?.toUpperCase() === 'F') throw new WebDavError(412, 'the WebDAV destination already exists');
		try { await action.call(remote, path, targetPath, expected); } catch (error) {
			const status = remoteStatus(error);
			throw new WebDavError(status === 401 || status === 403 || status === 412 ? status : 502, 'the WebDAV source could not copy or move the file');
		}
		return new Response(null, { status: existingTarget ? 204 : 201 });
	}
	throw new WebDavError(405, 'WebDAV method is not supported');
}
