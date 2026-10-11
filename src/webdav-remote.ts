import type { RemoteEntry, RemoteHost } from './remote';

export interface WebDavTarget {
	baseUrl: string;
	username: string;
	password: string;
	rootPath?: string;
}

export interface WebDavEntry extends RemoteEntry {
	version?: string;
	/** Absolute response path, retained internally so a root PROPFIND is not returned as its own child. */
	hrefPath?: string;
}

export class WebDavRemoteError extends Error {
	constructor(public readonly status: number, message: string) { super(message); }
}

function cleanPath(value: string): string {
	const decoded = decodeURIComponent(value || '/').replace(/\\/g, '/');
	if (!decoded.startsWith('/') || decoded.includes('\0')) throw new Error('WebDAV path must be absolute');
	const parts = decoded.split('/').filter(Boolean);
	if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) throw new Error('WebDAV path escapes its root');
	return `/${parts.join('/')}`;
}

function joinPath(root: string, path: string): string {
	const base = cleanPath(root || '/').replace(/\/$/, '');
	const child = cleanPath(path);
	return `${base}${child === '/' ? '/' : child}` || '/';
}

function comparablePath(value: string): string {
	const normalized = cleanPath(value);
	return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function xmlText(block: string, name: string): string | undefined {
	const match = block.match(new RegExp(`<[^>]*${name}[^>]*>([\\s\\S]*?)</[^>]*${name}\\s*>`, 'i'));
	return match?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function parseDate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const at = Date.parse(value);
	return Number.isFinite(at) ? Math.floor(at / 1000) : undefined;
}

function parseResponses(xml: string, requestUrl: string): WebDavEntry[] {
	const entries: WebDavEntry[] = [];
	for (const block of xml.match(/<[^>]*(?:response)\b[^>]*>[\s\S]*?<\/[^>]*response\s*>/gi) ?? []) {
		const hrefText = xmlText(block, 'href');
		if (!hrefText) continue;
		let path: string;
		try {
			path = new URL(hrefText, requestUrl).pathname;
		} catch {
			continue;
		}
		const isDirectory = /<[^>]*resourcetype[^>]*>[\s\S]*?<[^>]*collection\s*\/?\s*>/i.test(block);
		let name: string;
		try { name = decodeURIComponent(path.replace(/\/$/, '').split('/').pop() || ''); } catch { continue; }
		if (!name) continue;
		const size = Number(xmlText(block, 'getcontentlength') ?? 0);
		entries.push({
			name,
			size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
			mtime: parseDate(xmlText(block, 'getlastmodified')),
			isDirectory,
			version: xmlText(block, 'getetag')?.replace(/^W\//, '').replace(/^"|"$/g, ''),
			hrefPath: path,
		});
	}
	return entries;
}

function basic(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const value = btoa(binary);
	return `Basic ${value}`;
}

export class WebDavRemote implements RemoteHost {
	private readonly base: URL;
	private readonly root: string;
	private readonly auth: string;

	constructor(target: WebDavTarget) {
		const parsed = new URL(target.baseUrl);
		if (parsed.protocol !== 'https:') throw new Error('WebDAV endpoint must use HTTPS');
		if (parsed.username || parsed.password) throw new Error('WebDAV endpoint must not embed credentials');
		if (parsed.hash || parsed.search) throw new Error('WebDAV endpoint must not include a query or fragment');
		this.base = parsed;
		this.root = cleanPath(target.rootPath || '/');
		this.auth = basic(target.username, target.password);
	}

	private url(path: string): URL {
		const target = new URL(this.base.toString());
		target.pathname = joinPath(this.base.pathname || '/', joinPath(this.root, path));
		return target;
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('authorization', this.auth);
		headers.set('accept', 'application/xml, text/xml, */*');
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		let response: Response;
		try {
			response = await fetch(this.url(path), { ...init, headers, redirect: 'manual', signal: init.signal ?? controller.signal });
		} catch (error) {
			throw new WebDavRemoteError((error as DOMException)?.name === 'AbortError' ? 504 : 502, 'WebDAV endpoint could not be reached');
		} finally {
			clearTimeout(timer);
		}
		if (response.status >= 300 && response.status < 400) throw new WebDavRemoteError(502, 'WebDAV endpoint returned a redirect; configure its final HTTPS URL');
		if (response.status === 401 || response.status === 403) throw new WebDavRemoteError(response.status, `WebDAV endpoint rejected credentials with HTTP ${response.status}`);
		return response;
	}

	private async propfind(path: string, depth: '0' | '1'): Promise<WebDavEntry[]> {
		const response = await this.request(path, {
			method: 'PROPFIND',
			headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
			body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/><getetag/></prop></propfind>',
		});
		if (response.status === 404) throw new WebDavRemoteError(404, 'WebDAV path was not found');
		if (response.status !== 207) throw new WebDavRemoteError(502, `WebDAV PROPFIND failed with HTTP ${response.status}`);
		const parsed = parseResponses(await response.text(), this.url(path).toString());
		return parsed;
	}

	async list(path: string): Promise<WebDavEntry[]> {
		const ownPath = comparablePath(this.url(path).pathname);
		return (await this.propfind(path, '1')).filter((entry) => !entry.hrefPath || comparablePath(entry.hrefPath) !== ownPath);
	}

	async stat(path: string): Promise<WebDavEntry> {
		const entries = await this.propfind(path, '0');
		if (!entries[0]) throw new WebDavRemoteError(404, 'WebDAV path was not found');
		return entries[0];
	}

	async read(path: string): Promise<ReadableStream<Uint8Array>> {
		const response = await this.request(path, { method: 'GET' });
		if (!response.ok || !response.body) throw new WebDavRemoteError(response.status === 404 ? 404 : 502, `WebDAV GET failed with HTTP ${response.status}`);
		return response.body;
	}

	private async mutate(method: string, path: string, expectedVersion?: string, headers: Record<string, string> = {}, body?: BodyInit): Promise<void> {
		const requestHeaders = new Headers(headers);
		if (expectedVersion) requestHeaders.set('if-match', expectedVersion.startsWith('"') ? expectedVersion : `"${expectedVersion}"`);
		const response = await this.request(path, { method, headers: requestHeaders, body });
		if (![200, 201, 204].includes(response.status)) throw new WebDavRemoteError(response.status === 404 ? 404 : response.status === 412 ? 412 : 502, `WebDAV ${method} failed with HTTP ${response.status}`);
	}

	async write(path: string, body: ReadableStream<Uint8Array>, expectedVersion?: string): Promise<void> {
		await this.mutate('PUT', path, expectedVersion, { 'content-type': 'application/octet-stream' }, body);
	}

	async remove(path: string, expectedVersion?: string): Promise<void> {
		await this.mutate('DELETE', path, expectedVersion);
	}

	async move(from: string, to: string, expectedVersion?: string): Promise<void> {
		await this.mutate('MOVE', from, expectedVersion, { destination: this.url(to).toString(), overwrite: 'T' });
	}

	async copy(from: string, to: string, expectedVersion?: string): Promise<void> {
		await this.mutate('COPY', from, expectedVersion, { destination: this.url(to).toString(), overwrite: 'T' });
	}
}

export function parseWebDavResponses(xml: string, requestUrl = 'https://example.test/'): WebDavEntry[] {
	return parseResponses(xml, requestUrl);
}
