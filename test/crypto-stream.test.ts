import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * Whether a streaming hash is available here at all.
 *
 * The pipeline must hash a file without holding it, and WebCrypto's `digest` is one-shot: using it means
 * buffering the whole file, which is the single thing this design cannot do. If `node:crypto`'s streaming
 * hash works under this runtime's compatibility flag, that problem disappears.
 *
 * Checked rather than assumed, and checked by **agreeing with an independent implementation**: a
 * streaming hash that produces consistent but wrong output would make every stored file's recorded hash
 * useless for exactly the purpose it exists for — deciding whether a file changed.
 */
describe('a streaming hash in this runtime', () => {
	/** The known SHA-256 of "abc", so a wrong-but-consistent implementation cannot pass. */
	it('matches the published digest for a known input', () => {
		expect(createHash('sha256').update('abc').digest('hex')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});

	it('agrees with WebCrypto on the same bytes', async () => {
		const bytes = new Uint8Array(100_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

		const streaming = createHash('sha256').update(bytes).digest('hex');
		const oneShot = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		expect(streaming).toBe(oneShot);
	});

	it('produces the same result whether fed in one piece or many', () => {
		// The property that makes it usable incrementally: chunk boundaries must not matter.
		const whole = new Uint8Array(5000);
		for (let i = 0; i < whole.length; i++) whole[i] = (i * 7) % 256;

		const oneShot = createHash('sha256').update(whole).digest('hex');
		const hash = createHash('sha256');
		for (let offset = 0; offset < whole.length; offset += 512) {
			hash.update(whole.subarray(offset, Math.min(offset + 512, whole.length)));
		}
		expect(hash.digest('hex')).toBe(oneShot);
	});

	it('accepts an empty input, which is a real case for a zero-byte file', () => {
		expect(createHash('sha256').update(new Uint8Array(0)).digest('hex')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
	});

	it('can be copied mid-stream, so a resume point can carry a hash forward', () => {
		const hash = createHash('sha256');
		hash.update('first');
		const copy = hash.copy();
		hash.update('second');
		copy.update('second');
		expect(hash.digest('hex')).toBe(copy.digest('hex'));
	});
});
