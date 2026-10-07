import { describe, expect, it } from 'vitest';
import {
	MAX_SHARE_SECONDS,
	describeShare,
	hashSharePassword,
	newShareToken,
	shareLifetimeProblem,
	sharePasswordProblem,
	verifySharePassword,
	type ShareRow,
} from '../src/share';

/**
 * Sharing: a link to one file, for a limited time, optionally behind a password.
 *
 * The properties here are the ones where being nearly right is the same as being wrong. An expired link
 * that still works, a cancelled link indistinguishable from an expired one, a password that is bypassable
 * by reaching storage another way, or a password recoverable from a database dump — each of those is a
 * disclosure, and none of them announces itself.
 */

const base = (over: Partial<ShareRow> = {}): ShareRow => ({
	token: 'tok_abcdefghijklmnop',
	object_id: 1,
	password_salt: null,
	password_hash: null,
	password_iterations: null,
	expires_at: '2099-01-01T00:00:00.000Z',
	revoked_at: null,
	created_at: '2026-01-01T00:00:00.000Z',
	last_used_at: null,
	use_count: 0,
	...over,
});

const at = (iso: string) => () => Date.parse(iso);

describe('a share link', () => {
	it('is a random token, not a guessable one derived from the file', () => {
		// A token derived from the object key or a counter would let anyone who has one link enumerate the
		// rest, which is the whole reason the token is generated rather than computed.
		const tokens = new Set(Array.from({ length: 50 }, () => newShareToken()));
		expect(tokens.size).toBe(50);
		for (const token of tokens) {
			expect(token.length).toBeGreaterThanOrEqual(32);
			// URL-safe: it goes in a path, so it must not need escaping.
			expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});
});

describe('whether a share may be used', () => {
	it('permits a live share with no password', async () => {
		const decision = await describeShare(base(), null, at('2026-06-01T00:00:00.000Z'));
		expect(decision.usable).toBe(true);
		expect(decision.needsPassword).toBe(false);
	});

	it('refuses an expired share, and says it expired', async () => {
		const decision = await describeShare(base(), null, at('2100-01-01T00:00:00.000Z'));
		expect(decision.usable).toBe(false);
		expect(decision.reason).toBe('expired');
		expect(decision.message).toMatch(/expired/i);
	});

	it('refuses a cancelled share distinctly from an expired one', async () => {
		// The two lead an operator to different conclusions — "ask for a new link" against "someone stopped
		// this" — so collapsing them would make one of those conclusions unreachable.
		const decision = await describeShare(base({ revoked_at: '2026-06-01T00:00:00.000Z' }), null, at('2026-06-02T00:00:00.000Z'));
		expect(decision.usable).toBe(false);
		expect(decision.reason).toBe('revoked');
		expect(decision.message).toMatch(/cancel|revok/i);
	});

	it('reports a cancelled share as cancelled even after it would have expired', async () => {
		// Cancellation is the more specific fact, and it is the one the operator acted on.
		const decision = await describeShare(
			base({ revoked_at: '2026-06-01T00:00:00.000Z', expires_at: '2026-06-02T00:00:00.000Z' }),
			null,
			at('2100-01-01T00:00:00.000Z'),
		);
		expect(decision.reason).toBe('revoked');
	});

	it('treats the exact expiry instant as expired', async () => {
		// Boundary towards refusing: a link that is valid for the microsecond it expires is a link that
		// outlives its stated window.
		const row = base({ expires_at: '2026-06-01T12:00:00.000Z' });
		expect((await describeShare(row, null, at('2026-06-01T12:00:00.000Z'))).usable).toBe(false);
		expect((await describeShare(row, null, at('2026-06-01T11:59:59.999Z'))).usable).toBe(true);
	});
});

describe('a share password', () => {
	it('is not stored in a form that can be read back', async () => {
		const { salt, hash, iterations } = await hashSharePassword('a shared secret');
		expect(hash).not.toContain('a shared secret');
		expect(salt).toBeTruthy();
		expect(iterations).toBeGreaterThan(1000);
	});

	it('produces a different hash every time, so the salt is real', async () => {
		const first = await hashSharePassword('same password');
		const second = await hashSharePassword('same password');
		expect(first.salt).not.toBe(second.salt);
		expect(first.hash).not.toBe(second.hash);
	});

	it('accepts the right password and refuses a wrong one', async () => {
		const { salt, hash, iterations } = await hashSharePassword('correct');
		expect(await verifySharePassword('correct', salt, hash, iterations)).toBe(true);
		expect(await verifySharePassword('wrong', salt, hash, iterations)).toBe(false);
		expect(await verifySharePassword('', salt, hash, iterations)).toBe(false);
	});
});

describe('a share that requires a password', () => {
	it('tells the recipient a password is needed, without revealing whether it is right', async () => {
		const { salt, hash, iterations } = await hashSharePassword('secret');
		const row = base({ password_salt: salt, password_hash: hash, password_iterations: iterations });

		const without = await describeShare(row, null, at('2026-06-01T00:00:00.000Z'));
		expect(without.usable).toBe(false);
		expect(without.needsPassword).toBe(true);
		expect(without.reason).toBe('password_required');

		// A wrong password and a missing one must not be distinguishable to someone guessing, but the
		// correct one must be clearly accepted.
		const wrong = await describeShare(row, 'nope', at('2026-06-01T00:00:00.000Z'));
		expect(wrong.usable).toBe(false);

		const right = await describeShare(row, 'secret', at('2026-06-01T00:00:00.000Z'));
		expect(right.usable).toBe(true);
		expect(right.needsPassword).toBe(false);
	});

	it('does not accept the empty password as satisfying the requirement', async () => {
		const { salt, hash, iterations } = await hashSharePassword('secret');
		const row = base({ password_salt: salt, password_hash: hash, password_iterations: iterations });
		const decision = await describeShare(row, '', at('2026-06-01T00:00:00.000Z'));
		expect(decision.usable).toBe(false);
	});

	it('cannot be matched by an empty submission even if it were stored, so this check is speed not safety', async () => {
		// Established by measurement: PBKDF2 hashes the empty string to a value no real password produces, so
		// a stored password could not be satisfied by submitting nothing. Recorded because the guard in
		// verification reads like a security boundary and is not one — the boundary is at creation, below.
		const { salt, hash, iterations } = await hashSharePassword('');
		expect(await verifySharePassword('', salt, hash, iterations)).toBe(false);
		expect(await verifySharePassword('anything', salt, hash, iterations)).toBe(false);
	});
});

describe('setting a password on a share', () => {
	it('refuses an empty password, which would read as protected while being open', async () => {
		// Asserted on the MESSAGE, not merely on there being a problem. An empty password is also shorter than
		// the minimum, so a weaker assertion passes even when this check is gone — the operator would then be
		// told to add characters instead of being told the password is optional. A wrong explanation is a real
		// defect here, because it sends someone to fix the wrong thing.
		for (const empty of ['', '   ', '\t\n']) {
			const problem = sharePasswordProblem(empty);
			expect(problem).not.toBeNull();
			expect(problem).toMatch(/empty/i);
			expect(problem).toMatch(/leave it out/i);
		}
	});

	it('gives a length message for a short password rather than the empty one', () => {
		// The two cases must stay distinguishable, or one of the messages is unreachable.
		const problem = sharePasswordProblem('abc');
		expect(problem).toMatch(/at least 8/i);
		expect(problem).not.toMatch(/empty/i);
	});

	it('refuses something too short to be worth calling a password', () => {
		// The minimum is eight rather than four because this route has no throttling: a share password is the
		// only thing between a link and its file, and a four-character one over a small alphabet is worth
		// guessing when nothing counts the attempts.
		expect(sharePasswordProblem('abc')).not.toBeNull();
		expect(sharePasswordProblem('short')).not.toBeNull();
		expect(sharePasswordProblem('seven77')).not.toBeNull();
	});

	it('refuses a password containing control characters, which hash unpredictably', () => {
		// Measured on this runtime: its raw-key import drops TRAILING NUL bytes, so a password of NULs hashes to
		// the same digest as the empty string. A share stored that way was served to anyone who submitted
		// nothing — proved end to end before this rule existed.
		expect(sharePasswordProblem('abcdefg\u0000')).not.toBeNull();
		expect(sharePasswordProblem('\u0000\u0000\u0000\u0000')).not.toBeNull();
		expect(sharePasswordProblem('ab\u0001cd')).not.toBeNull();
	});

	it('accepts a password of reasonable length', () => {
		expect(sharePasswordProblem('a much longer shared phrase')).toBeNull();
		expect(sharePasswordProblem('eightchr')).toBeNull();
	});

	it('refuses a non-string, so a number or object cannot become a password', () => {
		expect(sharePasswordProblem(1234)).not.toBeNull();
		expect(sharePasswordProblem(null)).not.toBeNull();
	});

	it('refuses an expired share before checking the password, so expiry is not hidden', async () => {
		// Otherwise a recipient with the right password would be told their password was wrong, and would
		// keep trying it.
		const { salt, hash, iterations } = await hashSharePassword('secret');
		const row = base({ password_salt: salt, password_hash: hash, password_iterations: iterations });
		const decision = await describeShare(row, 'secret', at('2100-01-01T00:00:00.000Z'));
		expect(decision.reason).toBe('expired');
	});
});

describe('how long a share may last', () => {
	it('defaults to a couple of hours', () => {
		// "A couple of hours" is the requirement; stated as a constant so the default and the stated maximum
		// cannot drift apart.
		const problem = shareLifetimeProblem(undefined);
		expect(problem).toBeNull();
		expect(MAX_SHARE_SECONDS).toBeGreaterThanOrEqual(2 * 60 * 60);
	});

	it('accepts a lifetime inside the maximum', () => {
		expect(shareLifetimeProblem(60)).toBeNull();
		expect(shareLifetimeProblem(MAX_SHARE_SECONDS)).toBeNull();
	});

	it('refuses a lifetime beyond the maximum, so short-lived stays true by accident too', () => {
		const problem = shareLifetimeProblem(MAX_SHARE_SECONDS + 1);
		expect(problem).not.toBeNull();
		expect(problem!).toMatch(/maximum|longest/i);
	});

	it('refuses a lifetime that is not a positive number', () => {
		expect(shareLifetimeProblem(0)).not.toBeNull();
		expect(shareLifetimeProblem(-60)).not.toBeNull();
		expect(shareLifetimeProblem(Number.NaN)).not.toBeNull();
		expect(shareLifetimeProblem(Number.POSITIVE_INFINITY)).not.toBeNull();
	});

	it('refuses a lifetime that is long enough to be a de facto permanent link', () => {
		expect(shareLifetimeProblem(365 * 24 * 60 * 60)).not.toBeNull();
	});
});
