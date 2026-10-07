import { describe, expect, it } from 'vitest';
import { PBKDF2_ITERATIONS, PBKDF2_ITERATION_CEILING, hashPassword } from '../src/auth';
import { sharePasswordProblem } from '../src/share';

/**
 * The PBKDF2 iteration ceiling, which only a live deployment revealed.
 *
 * `PBKDF2_ITERATIONS` was 210,000 and the deployed Worker refused it outright:
 *
 *     Pbkdf2 failed: iteration counts above 100000 are not supported (requested 210000).
 *
 * Setting a password was therefore IMPOSSIBLE on the real deployment — `/api/auth/setup` answered 500 — while
 * every test in this suite passed, because the local runtime accepts 210,000. That divergence is the whole
 * reason this project verifies against a live deployment, and it cannot be reproduced here: **a test in this
 * environment can never observe the limit**, because the environment does not have one.
 *
 * So the ceiling is treated as a recorded PLATFORM FACT and asserted against, rather than discovered. That is a
 * weaker guarantee than measuring it, and it is stated plainly: if Cloudflare changes the limit, this test keeps
 * passing while the deployment breaks. What it does guarantee is that the value cannot drift upward unnoticed,
 * which is exactly how the original defect reached production.
 */
describe('the PBKDF2 iteration ceiling', () => {
	it('keeps the configured count at or below what the runtime will perform', () => {
		// The direction matters. A count BELOW the ceiling is merely weaker; a count ABOVE it makes the deployment
		// unable to set a password at all, which is a total failure of the only way in.
		expect(
			PBKDF2_ITERATIONS,
			'above this, `crypto.subtle` refuses on a deployed Worker and nobody can set a password',
		).toBeLessThanOrEqual(PBKDF2_ITERATION_CEILING);
	});

	it('uses the ceiling rather than something comfortable below it', () => {
		// A password is the only thing between the internet and every stored machine credential, so the cost of
		// guessing is the point of using PBKDF2 at all. Sitting far below the ceiling would be leaving hardening
		// on the table for no reason; the value is AT the ceiling deliberately.
		expect(PBKDF2_ITERATIONS).toBe(PBKDF2_ITERATION_CEILING);
	});

	it('records the ceiling as the figure the deployed runtime actually named', () => {
		// Pinned to the literal from the error message, not to the constant. Asserting a constant equals itself
		// would pass no matter what it held, which is the mistake this test exists to avoid.
		expect(PBKDF2_ITERATION_CEILING, 'from: "iteration counts above 100000 are not supported"').toBe(100_000);
	});

	it('still derives a hash at that cost, so the count is usable and not merely permitted', () => {
		// The ceiling being ALLOWED is not the same as the work completing. This runs the real derivation once.
		return hashPassword('a sufficiently long password', 'AAAAAAAAAAAAAAAAAAAAAA==').then((hash) => {
			expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
			expect(hash.length).toBeGreaterThan(20);
		});
	});

	it('hashes the same password differently with a different salt, so salts are doing work', async () => {
		const a = await hashPassword('same password here', 'AAAAAAAAAAAAAAAAAAAAAA==');
		const b = await hashPassword('same password here', 'BBBBBBBBBBBBBBBBBBBBBB==');
		expect(a).not.toBe(b);
	});

	it('accepts a share password of a length that reaches this hashing path', () => {
		// The share password is hashed by the same function, so the ceiling applies to shares too — a share whose
		// password could not be hashed would be a share nobody could open.
		expect(sharePasswordProblem('a reasonably long share password')).toBeNull();
	});
});
