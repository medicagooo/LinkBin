/**
 * ssh-probe — a DISPOSABLE prototype. Not production code, never merged to main.
 *
 * It answers exactly one question (see ../../.scratch/vps-file-hub/STATE.md, decision D14):
 *
 *   Can a Cloudflare Worker reach a real VPS over SSH, authenticate, list a directory, and
 *   read a file's bytes — inside the paid-plan CPU budget?
 *
 * Why it has to be deployed rather than run under `wrangler dev`: local development refuses
 * outbound connections to localhost and private addresses, so no local SSH server can stand in
 * for the real target.
 *
 * Deliberate limits, so that a failure is informative rather than ambiguous:
 *   - READ-ONLY against the target host. It only ever lists and reads.
 *   - The SSH stack is Workers-native (`edgeport`) because `ssh2` cannot even be imported in
 *     workerd: it compiles poly1305 WASM at module init and runtime WASM compilation is
 *     disallowed there (mscdex/ssh2#1494).
 *   - AES-GCM is negotiated explicitly. It is WebCrypto-backed, whereas
 *     chacha20-poly1305@openssh.com would be assembled in pure JS and is the likeliest way to
 *     blow the CPU budget.
 */

import { connect as sshConnect, type SshSession } from 'edgeport/ssh';
import { connect as sftpConnect, type SftpSession } from 'edgeport/sftp';

interface Env {
	/** Host to reach. Supplied as a plain var, not a secret. */
	PROBE_HOST: string;
	/** TCP port, as a string var. */
	PROBE_PORT: string;
	/** Login user. Supplied as a plain var, not a secret. */
	PROBE_USER: string;
	/** Login password. MUST come from a Worker secret (wrangler secret put PROBE_PASSWORD). */
	PROBE_PASSWORD: string;
	/** Throwaway R2 bucket proving the read bytes can be persisted. */
	PROBE_BUCKET: R2Bucket;
}

/** Per-stage timings, so a failure points at the stage that failed. */
type Stage = { stage: string; ms: number };
type ProbeError = { stage: string; name: string; message: string; ms: number };

/** RFC 3339 UTC, which is also the Worker's own clock (workerd runs with TZ=UTC). */
function nowIso(): string {
	return new Date().toISOString();
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Negotiates AES-GCM only.
 *
 * `cipher` is a single string in edgeport's AlgorithmPrefs rather than a preference list, so
 * this is an assertion: if the server cannot do aes256-gcm@openssh.com, negotiation fails and
 * that failure is itself the finding (rather than silently falling back to pure-JS ChaCha and
 * reporting a CPU number that means something else).
 */
const AES_GCM_ONLY = { cipher: 'aes256-gcm@openssh.com' } as const;

const baseOptions = (env: Env) => ({
	hostname: env.PROBE_HOST,
	port: Number(env.PROBE_PORT || '22'),
	username: env.PROBE_USER,
	password: env.PROBE_PASSWORD,
	algorithms: AES_GCM_ONLY,
	timeoutMs: 20_000,
});

/**
 * One connection, reused for every route. `sshConnect` must be called inside the request
 * handler: a socket cannot be created in global scope or shared across requests.
 */
async function withSftp<T>(env: Env, fn: (sftp: SftpSession, ssh: SshSession) => Promise<T>) {
	const ssh = await sshConnect(baseOptions(env));
	try {
		const sftp = await sftpConnect({ session: ssh });
		try {
			return await fn(sftp, ssh);
		} finally {
			await sftp.close();
		}
	} finally {
		await ssh.close();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const stages: Stage[] = [];
		const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
			const t0 = Date.now();
			try {
				return await fn();
			} finally {
				stages.push({ stage, ms: Date.now() - t0 });
			}
		};

		const target = {
			host: env.PROBE_HOST,
			port: Number(env.PROBE_PORT || '22'),
			user: env.PROBE_USER,
			hasPassword: typeof env.PROBE_PASSWORD === 'string' && env.PROBE_PASSWORD.length > 0,
		};

		// --- 0. config sanity, without opening a connection -------------------------------
		if (url.pathname === '/') {
			return json({
				probe: 'ssh-probe',
				purpose: 'Can a Worker read a file from a real VPS over SSH?',
				target,
				routes: ['/', '/exec', '/list?path=/etc', '/read?path=/etc/hostname'],
				note: target.hasPassword ? 'credential present' : 'PROBE_PASSWORD is NOT set — /exec, /list and /read will fail',
			});
		}

		if (!target.hasPassword) {
			return json({ error: 'PROBE_PASSWORD is not set', target }, 500);
		}
		if (!target.host || !target.user) {
			return json({ error: 'PROBE_HOST or PROBE_USER is not set', target }, 500);
		}

		try {
			// --- 1. does the SSH transport + auth work at all? ---------------------------
			if (url.pathname === '/exec') {
				const result = await timed('ssh connect + exec', () =>
					withSftp(env, async (_sftp, ssh) => {
						const uname = await ssh.run('uname -a');
						const whoami = await ssh.run('whoami');
						const hostname = await ssh.run('hostname');
						return { uname, whoami, hostname };
					}),
				);
				return json({ ok: true, startedAt: nowIso(), target, stages, result });
			}

			// --- 2. does the SFTP subsystem work? ---------------------------------------
			if (url.pathname === '/list') {
				const path = url.searchParams.get('path') ?? '/etc';
				const entries = await timed('sftp list', () =>
					withSftp(env, async (sftp) => sftp.list(path)),
				);
				// Directory listings can be large; return a bounded, sorted sample.
				const sorted = [...entries].sort((a, b) => a.filename.localeCompare(b.filename));
				return json({
					ok: true,
					startedAt: nowIso(),
					target,
					stages,
					path,
					entryCount: entries.length,
					entries: sorted.slice(0, 25).map((e) => ({
						name: e.filename,
						size: e.attrs.size,
						isDirectory: e.attrs.isDirectory,
						mtime: e.attrs.mtime,
					})),
				});
			}

			// --- 3. the real experiment: read bytes, hash them, persist them to R2 -------
			if (url.pathname === '/read') {
				const path = url.searchParams.get('path') ?? '/etc/hostname';
				const key = url.searchParams.get('key') ?? `probe${path}`;

				const read = await timed('sftp readFile', () =>
					withSftp(env, async (sftp) => {
						const attrs = await sftp.stat(path);
						const bytes = await sftp.readFile(path);
						return { attrs, bytes };
					}),
				);

				const hash = await timed('sha256 of bytes', () => sha256Hex(read.bytes));
				const put = await timed('r2 put', () => env.PROBE_BUCKET.put(key, read.bytes));

				return json({
					ok: true,
					startedAt: nowIso(),
					target,
					stages,
					path,
					sftp: {
						reportedSize: read.attrs.size,
						mtime: read.attrs.mtime,
						isDirectory: read.attrs.isDirectory,
					},
					read: {
						bytesRead: read.bytes.length,
						sha256: hash,
						// Proof that the bytes are the remote file's content, and not an
						// empty or error buffer.
						contentUtf8: new TextDecoder().decode(read.bytes.slice(0, 256)),
					},
					r2: {
						key,
						bytesWritten: put?.size ?? null,
						etag: put?.etag ?? null,
					},
					// First 64 bytes as hex, so the local comparison is unambiguous when the
					// content is not valid UTF-8.
					headHex: [...read.bytes.slice(0, 64)].map((b) => b.toString(16).padStart(2, '0')).join(''),
				});
			}

			return json({ error: 'unknown route', routes: ['/', '/exec', '/list', '/read'] }, 404);
		} catch (err) {
			// A failure here IS a result. Report which stage died and what the runtime said.
			const e = err as Error;
			return json(
				{
					ok: false,
					startedAt: nowIso(),
					target,
					stages,
					error: { name: e?.name ?? 'unknown', message: e?.message ?? String(err), stack: e?.stack },
					hint: 'If the message mentions exceeding CPU or error 1102, the CPU budget is the blocker. If it mentions a protocol or cipher negotiation failure, AES-GCM was refused.',
				},
				502,
			);
		}
	},
} satisfies ExportedHandler<Env>;
