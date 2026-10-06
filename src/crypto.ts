/**
 * Credential protection.
 *
 * Threat model, stated honestly: an attacker who holds BOTH a copy of the D1 database AND the
 * Worker's `SSH_MASTER_KEY` can recover every stored credential. What this design buys is that a
 * database leak alone — a dump, a replica, a misconfigured export — yields nothing usable, and the
 * plaintext never appears in the database, in logs, or in any API response.
 *
 * Deliberate choices, each with a reason:
 *   - `AES-GCM` with a 256-bit key via WebCrypto. Not hand-rolled, and not `node:crypto`: the
 *     streaming AEAD sequence there is broken under workerd (see docs/research, decision D23).
 *   - A fresh random 12-byte IV per encryption. Reusing an IV with GCM is catastrophic, so it is
 *     generated, stored alongside the ciphertext, and never derived.
 *   - The record's identity (`hostId` + field name) is passed as `additionalData`. Ciphertext is
 *     therefore bound to the row and column it belongs to and cannot be moved between rows.
 *   - Every failure path throws. It never returns ciphertext or a truncated value that could be
 *     mistaken for a real credential.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;

const encoder = new TextEncoder();

/** Ciphertext in a self-describing, single-column form: `v1.<iv>.<ciphertext>`, both base64. */
const VERSION = 'v1';

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Generates a fresh master key, base64-encoded, ready for `wrangler secret put SSH_MASTER_KEY`. */
export function generateMasterKey(): string {
	return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

async function importMasterKey(base64Key: string): Promise<CryptoKey> {
	let raw: Uint8Array;
	try {
		raw = fromBase64(base64Key.trim());
	} catch {
		throw new Error('SSH_MASTER_KEY is not valid base64');
	}
	if (raw.length !== KEY_BYTES) {
		// Naming the expected size matters: a truncated secret is an easy copy-paste mistake.
		throw new Error(`SSH_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}`);
	}
	return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Binds ciphertext to one row and one field, so it cannot be relocated. */
function aad(hostId: string, field: string): Uint8Array {
	return encoder.encode(`${VERSION}:${hostId}:${field}`);
}

/**
 * Encrypts one credential field.
 *
 * @returns `v1.<iv-b64>.<ciphertext-b64>` — safe to store in a single TEXT column.
 */
export async function encryptField(masterKey: string, hostId: string, field: string, plaintext: string): Promise<string> {
	const key = await importMasterKey(masterKey);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: aad(hostId, field) },
		key,
		encoder.encode(plaintext),
	);
	return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

/** Reverses {@link encryptField}. Throws rather than returning a wrong value. */
export async function decryptField(masterKey: string, hostId: string, field: string, stored: string): Promise<string> {
	const parts = stored.split('.');
	if (parts.length !== 3 || parts[0] !== VERSION) {
		throw new Error(`unrecognised ciphertext format for ${field}`);
	}
	const key = await importMasterKey(masterKey);
	const iv = fromBase64(parts[1]);
	const ciphertext = fromBase64(parts[2]);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv, additionalData: aad(hostId, field) },
		key,
		ciphertext,
	);
	return new TextDecoder().decode(plaintext);
}

/**
 * A non-reversible marker used to tell the UI "a credential is stored" without shipping the
 * credential. First 8 hex characters of a SHA-256 over the ciphertext: stable for the stored value,
 * useless for recovery, and it changes when the credential is replaced.
 */
export async function credentialFingerprint(stored: string | null): Promise<string | null> {
	if (!stored) return null;
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(stored));
	return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
