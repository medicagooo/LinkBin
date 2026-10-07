/**
 * Sharing: a link to one stored file, for a limited time, optionally behind a password.
 *
 * ## Why the link is issued here rather than by storage
 *
 * Storage-issued links cannot be used with a custom domain at all, and they cannot be revoked. A link that
 * cannot be cancelled is a permanent disclosure the moment it is misdirected, and the password check has
 * to happen **where the file is served** — a check anywhere else is bypassed by reaching storage directly,
 * which is exactly what a storage-issued link does.
 *
 * ## The two secrets are not the same kind of secret
 *
 * The **token** is stored as-is, because it is not a password being verified: it is the credential, and a
 * lookup needs it. What makes that acceptable is what it does not grant — a leaked database yields links to
 * files, not access to the interface or to any stored machine credential. That is also why a share token
 * must never be accepted as a session; the two are verified by entirely separate code paths and neither
 * implies the other.
 *
 * The **password** is stored only as a salted slow hash, so a database leak does not hand over every live
 * share at once.
 *
 * ## Why this is a decision rather than a download
 *
 * `describeShare` answers "may this be used, and if not, why". It touches no storage, so the refusals can be
 * tested exhaustively — and they are the part worth testing, because every one of them is a disclosure if
 * it is wrong.
 */

import { PBKDF2_ITERATIONS, hashPassword, timingSafeEqual } from './auth';

/** A couple of hours, which is the requirement's own wording. */
export const DEFAULT_SHARE_SECONDS = 2 * 60 * 60;

/**
 * The shortest share password accepted.
 *
 * Raised from four, because an adversarial audit pointed out that a share password is the only thing standing
 * between a link and its file and this route had **no throttling at all**: a four-character password over a
 * small alphabet is worth guessing when nothing counts the attempts. Four was chosen for convenience; eight is
 * chosen so that the absence of throttling matters less.
 */
const MIN_SHARE_PASSWORD_LENGTH = 8;

/**
 * The longest lifetime a share may be given.
 *
 * Substantially longer than the default, because a legitimate "I need this for a day" exists — but far
 * short of anything that amounts to a permanent public link, so that "short-lived" stays true even when
 * someone sets the value carelessly.
 */
export const MAX_SHARE_SECONDS = 24 * 60 * 60;

export interface ShareRow {
	token: string;
	object_id: number;
	password_salt: string | null;
	password_hash: string | null;
	password_iterations: number | null;
	expires_at: string;
	revoked_at: string | null;
	created_at: string;
	last_used_at: string | null;
	use_count: number;
}

export type ShareRefusal = 'expired' | 'revoked' | 'password_required' | 'password_incorrect';

export interface ShareDecision {
	usable: boolean;
	/** True when the share is live but a password must be supplied. Not a refusal. */
	needsPassword: boolean;
	reason?: ShareRefusal;
	/** A sentence for the recipient. Deliberately vague about whether a password was close. */
	message?: string;
}

/**
 * A new link token.
 *
 * Generated, never derived. A token computed from the object key, a counter or a timestamp would let
 * anyone holding one link enumerate the others, which defeats the point of sharing a single file.
 */
export function newShareToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	// URL-safe: the token travels in a path, so it must not need escaping or be mangled by a client.
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hashes a share password for storage. Reuses the interface's own hashing so the cost is one decision. */
export async function hashSharePassword(password: string): Promise<{ salt: string; hash: string; iterations: number }> {
	const saltBytes = crypto.getRandomValues(new Uint8Array(16));
	let binary = '';
	for (const byte of saltBytes) binary += String.fromCharCode(byte);
	const salt = btoa(binary);
	const iterations = PBKDF2_ITERATIONS;
	return { salt, hash: await hashPassword(password, salt, iterations), iterations };
}

export async function verifySharePassword(
	password: string,
	salt: string,
	hash: string,
	iterations: number,
): Promise<boolean> {
	// An empty submission is not a password, so it cannot be the right one even if the hash somehow matched.
	if (!password) return false;
	return timingSafeEqual(await hashPassword(password, salt, iterations), hash);
}

/**
 * Decides whether a share may be used, and why not when it may not.
 *
 * Order matters and is deliberate:
 *
 *   1. **Cancellation, then expiry, before the password.** A recipient holding the right password for an
 *      expired link must be told it expired — otherwise they conclude their password is wrong and keep
 *      retrying it.
 *   2. **Cancellation before expiry**, because it is the more specific fact and the one the operator acted
 *      on. "This link was cancelled" and "this link expired" send someone to different places.
 *   3. **Expiry is inclusive of its own instant.** A link valid for the microsecond it expires is a link
 *      that outlives its stated window.
 */
export async function describeShare(
	row: ShareRow,
	suppliedPassword: string | null,
	now: () => number = () => Date.now(),
): Promise<ShareDecision> {
	if (row.revoked_at) {
		return { usable: false, needsPassword: false, reason: 'revoked', message: 'this link was cancelled by whoever created it' };
	}

	if (now() >= Date.parse(row.expires_at)) {
		return { usable: false, needsPassword: false, reason: 'expired', message: 'this link has expired' };
	}

	if (!row.password_hash || !row.password_salt) {
		return { usable: true, needsPassword: false };
	}

	if (suppliedPassword === null) {
		return { usable: false, needsPassword: true, reason: 'password_required', message: 'this link needs a password' };
	}

	const ok = await verifySharePassword(suppliedPassword, row.password_salt, row.password_hash, Number(row.password_iterations ?? PBKDF2_ITERATIONS));
	if (!ok) {
		// The same message for wrong and missing, so a guesser learns nothing from the difference.
		return { usable: false, needsPassword: true, reason: 'password_incorrect', message: 'this link needs a password' };
	}

	return { usable: true, needsPassword: false };
}

/**
 * Checks a password being **set** on a share.
 *
 * This is where emptiness genuinely matters. An empty password accepted here would create a share that
 * reads as "protected" in the interface while being open to anyone — the worst combination, because the
 * operator would believe otherwise and the recipient would never know.
 *
 * Distinct from verification, where the same check is only a fast path. PBKDF2 hashes the empty string to a
 * value no real password produces, so an empty submission cannot match a real password's hash regardless;
 * it is refused there for speed, not for safety. Confirmed by direct measurement rather than assumed.
 *
 * Length is the only rule, for the same reason it is the only rule on the interface password: composition
 * requirements push people towards predictable substitutions while adding nothing against an offline attack.
 */
export function sharePasswordProblem(password: unknown): string | null {
	if (typeof password !== 'string') return 'the password must be text';
	if (password.trim().length === 0) return 'the password cannot be empty; leave it out entirely if the link needs no password';
	// Control characters are refused for the same measured reason as on the interface password: this runtime's
	// raw-key import drops trailing NUL bytes, so a password of NULs hashes to the same digest as the empty
	// string — and a share whose stored digest is the empty string's is served to anyone who submits nothing.
	// Proved end to end before this rule existed.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(password)) {
		return 'the password cannot contain control characters, which are not accepted because they cannot be typed back reliably';
	}
	// Surrounding whitespace is refused too, and an adversarial audit is why. A share created with the password
	// `"secret "` was downloadable with `"secret"`: the emptiness check trimmed and the hash did not, so two
	// different strings verified against one stored value. Whitespace in a password is legitimate in
	// principle, but a share password exists to be told to somebody, and one that cannot be typed back
	// exactly is worse than one refused at creation.
	if (password !== password.trim()) {
		return 'the password cannot start or end with a space, because nobody could tell whether one was intended';
	}
	if (password.length < MIN_SHARE_PASSWORD_LENGTH) {
		return `the password must be at least ${MIN_SHARE_PASSWORD_LENGTH} characters`;
	}
	return null;
}

/**
 * Checks a requested lifetime, returning a problem to show the operator or null when acceptable.
 *
 * `undefined` means "use the default" and is always acceptable, so the common case cannot be broken by
 * validating it.
 */
export function shareLifetimeProblem(seconds: number | undefined): string | null {
	if (seconds === undefined) return null;
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'the lifetime must be a number of seconds';
	if (seconds <= 0) return 'the lifetime must be greater than zero';
	if (seconds > MAX_SHARE_SECONDS) {
		return `the longest a link may last is ${MAX_SHARE_SECONDS} seconds (${Math.round(MAX_SHARE_SECONDS / 3600)} hours), so that a shared link stays short-lived`;
	}
	return null;
}

/** The lifetime to store, applying the default and never exceeding the maximum. */
export function resolveLifetime(seconds: number | undefined): number {
	if (seconds === undefined) return DEFAULT_SHARE_SECONDS;
	return Math.min(seconds, MAX_SHARE_SECONDS);
}
