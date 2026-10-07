/**
 * Authentication for a single-operator tool.
 *
 * The shape follows from that: one password, set by whoever arrives first, and no user table, roles or
 * invitations. What has to be right is narrower and more absolute than a multi-user system, because
 * this Worker holds credentials for every collected machine:
 *
 *   - a stranger must get nothing, including no hint that a resource exists;
 *   - the password must not be recoverable from the database;
 *   - changing the password must actually lock out whatever was already signed in;
 *   - the single secret must not be guessable by repetition.
 *
 * Two decisions worth stating because they are not obvious:
 *
 * **Sessions are signed tokens, not rows.** Nothing is stored per session, so "sign out" and "change
 * the password invalidates everything" need a different mechanism than deleting rows. A token carries
 * the moment it was issued, and it is refused if that moment is older than the newest of two
 * timestamps: the time the password last changed, and the time sessions were last revoked. That makes
 * both operations immediate without a session table to keep consistent.
 *
 * **No new deployment secret.** The signing key is derived from the existing master key, so the
 * single-secret architecture survives (D32). Adding a second secret would break that decision rather
 * than extend it.
 */

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SESSION_SECONDS = 12 * 60 * 60;

/**
 * Failed attempts allowed from one caller within the window before sign-in is refused outright.
 *
 * Deliberately generous, and that is a correction rather than a preference. An earlier value of eight was
 * reported by an adversarial audit as a way to lock the operator out, and the report was right: when the
 * platform supplies no caller address, every such caller shares one bucket, so eight failures from anyone
 * refused the operator's correct password. The same is true for an operator and an attacker behind one
 * address, which is what a shared office or a mobile network looks like.
 *
 * Thirty is enough that reaching it means deliberate repetition rather than a mistyped passphrase, and the
 * ceiling below is what actually bounds sustained guessing.
 */
const MAX_ATTEMPTS = 30;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;

/**
 * Failed attempts allowed from EVERYONE within the window.
 *
 * Much higher than the per-caller limit, and it exists because the per-caller one is not sufficient on its
 * own. Two cases get through it, both found by an adversarial audit:
 *
 *   - When the platform has not supplied a caller address, there is no per-caller key to use. The first
 *     attempt at this pooled every such caller into one bucket, which meant an attacker's failures locked the
 *     operator out — a denial of service against the single account, which is the exact failure the per-caller
 *     limit was introduced to prevent.
 *   - An attacker can rotate `x-forwarded-for` freely, and although that header is no longer trusted for the
 *     key, a determined caller can vary the address the platform reports by other means.
 *
 * This ceiling is the backstop: it cannot be escaped by changing identity, only by succeeding. It is set far
 * above the per-caller limit so that normal use never reaches it — an operator mistyping their password a few
 * times, from a few devices, is nowhere near a hundred failures in a quarter of an hour.
 */
const MAX_GLOBAL_ATTEMPTS = 200;

const MIN_PASSWORD_LENGTH = 12;

/**
 * How far a session may be stamped ahead of this server's clock before it is refused.
 *
 * Not zero, because the signer and the verifier are the same Worker and their clocks agree — but a token
 * could in principle be minted moments before a check that happens to land on an earlier millisecond. A
 * minute is far below the session lifetime and far above any real skew between two calls in one isolate.
 */
const CLOCK_TOLERANCE_MS = 60_000;

const encoder = new TextEncoder();

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

function base64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Compares two byte strings without leaking where they first differ. */
export function timingSafeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
	return diff === 0;
}

export function newSalt(): string {
	return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Hashes a password for storage.
 *
 * PBKDF2 rather than a plain digest: the password is the only thing between the internet and every
 * stored machine credential, so it must be expensive to guess rather than merely hard to reverse. The
 * iteration count is returned with the hash so it can be raised later without invalidating an
 * existing password.
 */
export async function hashPassword(password: string, salt: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
	const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' },
		material,
		KEY_BYTES * 8,
	);
	return toBase64(new Uint8Array(bits));
}

/** HKDF via HMAC-SHA256: derives a purpose-bound key from the master key. */
async function deriveKey(master: string, purpose: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', encoder.encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	// A fixed, purpose-specific info string means a key derived for sessions cannot be used for
	// anything else derived from the same master key.
	const prk = await crypto.subtle.sign('HMAC', material, encoder.encode(`linkbin/v1/${purpose}`));
	const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
	return key;
}

/**
 * The credential a scheduler presents to trigger collection without a human.
 *
 * Derived from the master key with its own purpose string, which is what makes it a *different*
 * credential from a session rather than another instance of one: rotating it, or refusing it, cannot
 * affect an interactive session and vice versa.
 *
 * Nothing is stored for it. The operator holds the master key locally (it is the deployment's secret),
 * so the same value can be produced on demand and handed to whatever calls the schedule endpoint.
 * Revoking means changing the master key, which is already a deliberate, documented act — and that
 * keeps this deployment at exactly one secret (D32) rather than adding one to carry a second token.
 */
export async function scheduleToken(master: string): Promise<string> {
	const key = await deriveKey(master, 'schedule');
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode('schedule/v1'));
	return base64Url(new Uint8Array(signature));
}

/** True when the presented credential is the scheduler's, compared without leaking where it differs. */
export async function isScheduleToken(master: string, presented: string): Promise<boolean> {
	return timingSafeEqual(await scheduleToken(master), presented);
}

/**
 * Signs a session token.
 *
 * The payload is `<issuedAtMillis>.<random>`, so two sessions issued in the same millisecond are still
 * distinct, and the signature covers both parts.
 *
 * Milliseconds rather than seconds, deliberately. The floor a session is checked against is a
 * timestamp of when the password changed or sessions were revoked. At second granularity a token
 * minted in the same second as that timestamp is indistinguishable from one minted before it, so
 * either legitimate sign-ins were rejected or a revoked session kept working. Millisecond precision
 * separates the two without weakening the revocation.
 */
export async function signSession(master: string, issuedAtMillis: number, nonce: string): Promise<string> {
	const key = await deriveKey(master, 'session');
	const payload = `${issuedAtMillis}.${nonce}`;
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
	return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

export interface SessionCheck {
	valid: boolean;
	issuedAt: number;
}

/**
 * Verifies a session token and reports when it was issued.
 *
 * `notBefore` is the newest of the password-change and revocation timestamps: a token issued at or
 * before it is refused. Comparing against a timestamp rather than a list of live sessions is what lets
 * "sign out everywhere" and "the password changed" both take effect with no session table.
 */
export async function verifySession(master: string, token: string, notBefore: number): Promise<SessionCheck> {
	const invalid: SessionCheck = { valid: false, issuedAt: 0 };
	const parts = token.split('.');
	if (parts.length !== 3) return invalid;

	const [issuedRaw, nonce, signatureRaw] = parts;
	const issuedAt = Number(issuedRaw);
	if (!Number.isFinite(issuedAt) || issuedAt <= 0) return invalid;

	const key = await deriveKey(master, 'session');
	const payload = `${issuedRaw}.${nonce}`;
	let signature: Uint8Array;
	try {
		signature = fromBase64(signatureRaw.replace(/-/g, '+').replace(/_/g, '/'));
	} catch {
		return invalid;
	}
	// `verify` fails closed on a wrong length or a bad signature, so a truncated or invented token is
	// refused here rather than needing a separate shape check.
	const ok = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload));
	if (!ok) return invalid;

	// Strictly after: a token minted in the same millisecond as a revocation is refused, which is the
	// safe direction for a comparison this coarse to be wrong in.
	if (issuedAt <= notBefore) return invalid;

	// A token stamped in the FUTURE is refused outright. This is a real finding from an adversarial audit,
	// not a theoretical one.
	//
	// The floor can only revoke a token whose issued-at is in the past: a password change sets the floor to
	// now, and a token claiming to have been issued next year stays newer than that floor for as long as it
	// keeps claiming so. A future-dated token therefore survives every revocation this system has, and only
	// ages out when the clock eventually catches up. Nothing legitimate mints one — the signer uses its own
	// clock — so a future timestamp means a forged token or a badly wrong clock, and honouring it is wrong
	// either way.
	const clock = Date.now();
	if (issuedAt > clock + CLOCK_TOLERANCE_MS) return invalid;
	if (issuedAt + SESSION_SECONDS * 1000 < clock) return invalid;

	return { valid: true, issuedAt };
}

export function newNonce(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(12)));
}

export function sessionMaxAgeSeconds(): number {
	return SESSION_SECONDS;
}

export function minPasswordLength(): number {
	return MIN_PASSWORD_LENGTH;
}

export function attemptLimits(): { max: number; windowSeconds: number; maxGlobal: number } {
	return { max: MAX_ATTEMPTS, windowSeconds: ATTEMPT_WINDOW_SECONDS, maxGlobal: MAX_GLOBAL_ATTEMPTS };
}

/**
 * Rejects a password that would make the single secret trivial.
 *
 * Length is the main rule, deliberately: composition rules ("one digit, one symbol") are well established to
 * push people towards predictable substitutions while adding nothing against an offline attack. A long
 * passphrase is both stronger and easier to remember.
 *
 * **Control characters are refused too, and that rule is not cosmetic.** Direct measurement on this runtime
 * showed that its raw-key import **drops trailing NUL bytes**: `hashPassword('P\0')` produces the same digest
 * as `hashPassword('P')`, and therefore `hashPassword('\0'.repeat(12))` produces the same digest as
 * `hashPassword('')`. A password of twelve NULs was consequently accepted by the length rule and stored as the
 * hash of the empty string — after which a sign-in attempt with an **empty password** computed that same
 * digest and succeeded, issuing a session. A deployment the operator believed was password-protected was open
 * to anyone who submitted nothing.
 *
 * Refusing control characters closes that at the only place it can be closed: the value that gets stored.
 * Checking at verification instead would leave the unusable password in the database and depend on every
 * future verification path remembering to special-case it.
 */
export function passwordProblem(password: string): string | null {
	if (typeof password !== 'string') return 'a password is required';
	const trimmed = password.trim();
	if (trimmed.length === 0) return 'a password is required';
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(password)) {
		return 'the password cannot contain control characters, which are not accepted because they cannot be typed back reliably';
	}
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `the password must be at least ${MIN_PASSWORD_LENGTH} characters`;
	}
	return null;
}
