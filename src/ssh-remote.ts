/**
 * The one production implementation of {@link RemoteHost}: an SSH connection to a machine.
 *
 * Nothing is installed on the machine. The Worker connects out using `cloudflare:sockets` through a
 * Workers-native SSH stack, because `ssh2` cannot be imported here at all: it compiles WebAssembly at
 * module load and this runtime forbids runtime compilation.
 *
 * Two details here are load-bearing and were learned the hard way:
 *
 *   - `algorithms.cipher` is a **list**. Passing a bare string bundles cleanly, because the build does
 *     no type checking, and then fails at key-exchange construction with `names.join is not a function`.
 *   - `read` returns a stream. `readFile` holds the whole file in memory and peaks near twice its size,
 *     which the per-file limit makes fatal.
 */

import { connect as sshConnect, type SshSession } from 'edgeport/ssh';
import { connect as sftpConnect, type SftpSession } from 'edgeport/sftp';
import type { RemoteEntry, RemoteHost } from './remote';

export interface SshTarget {
	hostname: string;
	port: number;
	username: string;
	password?: string;
	privateKey?: { pem: string; passphrase?: string };
}

/**
 * Cipher preference, AES-GCM first because it is WebCrypto-backed.
 *
 * `aes-ctr` is the fallback so a machine without GCM still works. `chacha20-poly1305` is deliberately
 * absent: it would be assembled in pure JavaScript and is the likeliest way to exhaust the CPU budget.
 */
const CIPHERS = ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'];

export function sshOptionsFor(target: SshTarget) {
	return {
		hostname: target.hostname,
		port: target.port,
		username: target.username,
		password: target.password,
		privateKey: target.privateKey,
		algorithms: { cipher: CIPHERS },
		timeoutMs: 20_000,
	};
}

/**
 * Opens a connection and exposes it through the port.
 *
 * Takes the already-built connect options rather than a target, so the cipher preference and timeouts
 * live in exactly one place — the Worker — instead of being restated here and drifting.
 *
 * The caller owns the returned `close`, so a connection is never left open by accident.
 */
export async function connectRemote(options: ReturnType<typeof sshOptionsFor>): Promise<{ remote: RemoteHost; close: () => Promise<void> }> {
	const ssh: SshSession = await sshConnect(options);

	let sftp: SftpSession | null = null;
	const openSftp = async (): Promise<SftpSession> => {
		if (!sftp) sftp = await sftpConnect({ session: ssh });
		return sftp;
	};

	const remote: RemoteHost = {
		async list(dir: string): Promise<RemoteEntry[]> {
			const session = await openSftp();
			const entries = await session.list(dir);
			return entries.map((entry) => ({
				name: entry.filename,
				size: entry.attrs.size ?? 0,
				mtime: entry.attrs.mtime,
				isDirectory: entry.attrs.isDirectory,
			}));
		},

		async stat(path: string) {
			const session = await openSftp();
			const attrs = await session.stat(path);
			// A reported size is optional in the protocol; absent means unknown, never zero.
			return { size: attrs.size, mtime: attrs.mtime, isDirectory: attrs.isDirectory };
		},

		async read(path: string): Promise<ReadableStream<Uint8Array>> {
			const session = await openSftp();
			return session.createReadStream(path);
		},

		async exec(command: string): Promise<string> {
			// Only ever called with a command from the fixed set in this codebase; nothing is assembled
			// from user text, and nothing here writes to the machine.
			return await ssh.run(command);
		},
	};

	const close = async (): Promise<void> => {
		try {
			if (sftp) await sftp.close();
		} finally {
			await ssh.close();
		}
	};

	return { remote, close };
}
