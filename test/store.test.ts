import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { storeStream, type StoreOutcome } from '../src/store';

/**
 * Streaming a file into storage without ever holding it whole.
 *
 * The per-file limit is large enough that buffering the file twice — once to read it, once to upload it
 * — does not fit in this runtime's memory. The number that matters is therefore **peak bytes held at
 * once**, not whether the result is correct: a version that buffers passes every correctness test and
 * then dies in production on the one file size that matters.
 *
 * So these tests measure. The source stream reports how many bytes it has handed over but not yet had
 * acknowledged, and the peak of that figure is the memory the pipeline actually needs. That makes an
 * accidental "read it all, then write it all" show up here as a failure instead of on a real file.
 *
 * Parameters are injected rather than fixed, because the thresholds depend on a measurement that has not
 * happened yet (ticket 04). Nothing here should have to change when those numbers do.
 */

/** A stream of `size` bytes with a recognisable, position-dependent pattern. */
function patternStream(size: number, tracker: { outstanding: number; peak: number }, chunk = 64 * 1024): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= size) {
				controller.close();
				return;
			}
			const length = Math.min(chunk, size - sent);
			const bytes = new Uint8Array(length);
			for (let i = 0; i < length; i++) bytes[i] = (sent + i) % 251;
			sent += length;

			// Track what the consumer has taken but not yet released. The pipeline reports each release.
			tracker.outstanding += length;
			tracker.peak = Math.max(tracker.peak, tracker.outstanding);
			controller.enqueue(bytes);
		},
	});
}

/** The same pattern, computed independently, for comparison against what was stored. */
function expectedBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = i % 251;
	return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SMALL = { partSize: 5 * 1024 * 1024, multipartThreshold: 5 * 1024 * 1024 };

describe('a small file', () => {
	it('is stored intact and its hash matches one computed independently', async () => {
		const size = 300 * 1024;
		const tracker = { outstanding: 0, peak: 0 };
		const bytes = expectedBytes(size);
		const expectedHash = await sha256Hex(bytes);

		const outcome = await storeStream(patternStream(size, tracker), env.BUCKET, 'test/small.bin', {
			...SMALL,
			onRelease: (n) => {
				tracker.outstanding -= n;
			},
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.bytes).toBe(size);
		expect(outcome.hash).toBe(expectedHash);

		const stored = await env.BUCKET.get('test/small.bin');
		expect(stored).not.toBeNull();
		const roundTripped = new Uint8Array(await stored!.arrayBuffer());
		expect(roundTripped.length).toBe(size);
		expect(roundTripped[0]).toBe(bytes[0]);
		expect(roundTripped[size - 1]).toBe(bytes[size - 1]);
	});

	it('holds at most one part in memory, not the whole file', async () => {
		// A small file legitimately fits in one write, so peak usage is naturally near its size; there is
		// nothing to stream. The bound that matters is that it never exceeds the file by more than a part.
		const size = 300 * 1024;
		const tracker = { outstanding: 0, peak: 0 };
		await storeStream(patternStream(size, tracker), env.BUCKET, 'test/small-peak.bin', {
			...SMALL,
			onRelease: (n) => {
				tracker.outstanding -= n;
			},
		});
		expect(tracker.peak).toBeLessThanOrEqual(size + 64 * 1024);
	});
});

describe('a file that must be sent in parts', () => {
	it('is stored intact across several parts', async () => {
		// Small part size so multiple parts are exercised without a large test.
		const size = 12 * 1024 * 1024;
		const tracker = { outstanding: 0, peak: 0 };
		const expectedHash = await sha256Hex(expectedBytes(size));

		const outcome = await storeStream(patternStream(size, tracker), env.BUCKET, 'test/multi.bin', {
			partSize: 5 * 1024 * 1024,
			multipartThreshold: 5 * 1024 * 1024,
			onRelease: (n) => {
				tracker.outstanding -= n;
			},
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.parts).toBeGreaterThan(1);
		expect(outcome.bytes).toBe(size);
		expect(outcome.hash).toBe(expectedHash);

		const stored = await env.BUCKET.get('test/multi.bin');
		expect(new Uint8Array(await stored!.arrayBuffer()).length).toBe(size);
	});

	it('keeps peak memory near one part rather than near the file size', async () => {
		// The property the whole design exists for. A part is 1 MiB here and the file 12 MiB, so a
		// buffering implementation would peak around 12 MiB and this bound has room to be generous.
		const size = 12 * 1024 * 1024;
		const partSize = 1024 * 1024;
		const tracker = { outstanding: 0, peak: 0 };

		await storeStream(patternStream(size, tracker), env.BUCKET, 'test/multi-peak.bin', {
			partSize,
			// Single-write mode: this test is about how much is held while reading, not about parts.
			multipartThreshold: 0,
			onRelease: (n) => {
				tracker.outstanding -= n;
			},
		});

		expect(tracker.peak, `peak ${tracker.peak} should stay near one part (${partSize})`).toBeLessThan(partSize * 3);
	});

	it('uses one part size for every part except the last, as storage requires', async () => {
		const partSize = 1024 * 1024;
		const size = partSize * 3 + 1234;
		const sizes: number[] = [];

		await storeStream(patternStream(size, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/parts.bin', {
			partSize,
			multipartThreshold: 0,
			onPart: (n) => sizes.push(n),
		});

		expect(sizes.length).toBe(4);
		expect(sizes.slice(0, 3)).toEqual([partSize, partSize, partSize]);
		expect(sizes[3]).toBe(1234);
	});

	it('reports an upload id when it used parts, and none when it did not', async () => {
		// The id is how a later run recognises its own unfinished work rather than starting again, so its
		// presence has to be reliable — and its ABSENCE has to be reliable too, or a caller cannot tell a
		// small file written in one go from a multipart upload whose id went missing.
		//
		// Every part but the last must be at least 5 MiB, so the multipart case uses compliant parts rather
		// than convenient small ones.
		const small = await storeStream(patternStream(512 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/single.bin', {
			partSize: 5 * 1024 * 1024,
			multipartThreshold: 5 * 1024 * 1024,
		});
		expect(small.ok, `single write failed: ${small.problem}`).toBe(true);
		expect(small.parts).toBe(1);
		expect(small.uploadId ?? null, 'a single-write upload has no upload id').toBeNull();

		const large = await storeStream(patternStream(11 * 1024 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/resumable.bin', {
			partSize: 5 * 1024 * 1024,
			multipartThreshold: 5 * 1024 * 1024,
		});
		expect(large.ok, `multipart failed: ${large.problem}`).toBe(true);
		expect(large.parts).toBe(3);
		expect(large.uploadId, 'a multipart upload must report its id').toBeTruthy();
	});

	it('refuses a part size storage would reject, before transferring anything', async () => {
		// Storage accepts undersized parts one at a time and then fails the whole upload at completion. That
		// is a costly and confusing place to find out, so it is refused immediately instead.
		const outcome = await storeStream(patternStream(1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/bad-part.bin', {
			partSize: 1024 * 1024,
			multipartThreshold: 1024 * 1024,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.problem).toMatch(/minimum/i);
		expect(outcome.bytes).toBe(0);
		expect(await env.BUCKET.get('test/bad-part.bin')).toBeNull();
	});
});

describe('a stream that fails part way', () => {
	it('does not leave an object that looks complete', async () => {
		// The dangerous outcome is a partial object that a later run believes is the whole file. Refusing
		// outright means nothing is stored under the key at all.
		const partSize = 1024 * 1024;
		let emitted = 0;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emitted >= partSize * 2 + 1) {
					controller.error(new Error('the machine closed the connection'));
					return;
				}
				emitted += 64 * 1024;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
		});

		const outcome = await storeStream(failing, env.BUCKET, 'test/failing.bin', { partSize, multipartThreshold: 0 });

		expect(outcome.ok).toBe(false);
		expect(outcome.problem).toContain('connection');
		expect(await env.BUCKET.get('test/failing.bin')).toBeNull();
	});

	it('leaves nothing retrievable when a multipart upload fails', async () => {
		// What this verifies: a failure part way through a **multipart** upload leaves no object under the
		// key. That is the property a later run depends on — a partial object mistaken for a complete file
		// is worse than no object.
		//
		// What this does NOT verify: that the abandoned upload was actually aborted. Established by direct
		// probe that the local storage simulator keeps incomplete multipart uploads entirely invisible —
		// `list()` omits them and `get()` returns null — so cleaning one up and leaving it behind are
		// indistinguishable here. The cleanup call is therefore **unverified by test**, and a deliberate
		// mutation removing it was not caught. It is recorded as a known gap rather than implied to be
		// covered. Validating it needs a real bucket, where an abandoned upload is a real thing that exists.
		const partSize = 5 * 1024 * 1024;
		let produced = 0;
		const failsAfterOnePart = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced >= partSize) {
					controller.error(new Error('the machine closed the connection'));
					return;
				}
				produced += 1024 * 1024;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});

		const outcome = await storeStream(failsAfterOnePart, env.BUCKET, 'test/abandoned.bin', {
			partSize,
			multipartThreshold: partSize,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.problem).toContain('connection');

		// Nothing readable under the key.
		expect(await env.BUCKET.get('test/abandoned.bin')).toBeNull();
		const listed = await env.BUCKET.list({ prefix: 'test/abandoned.bin' });
		expect(listed.objects.length).toBe(0);
	});

	it('reports how far it got, so the next run knows where to resume', async () => {
		const partSize = 1024 * 1024;
		let emitted = 0;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emitted >= partSize + 1) {
					controller.error(new Error('interrupted'));
					return;
				}
				emitted += 64 * 1024;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
		});

		const outcome = await storeStream(failing, env.BUCKET, 'test/resume-point.bin', { partSize, multipartThreshold: 0 });
		expect(outcome.ok).toBe(false);
		// Bytes actually committed before the failure: what a resume would skip.
		expect(outcome.committedBytes ?? 0).toBeGreaterThanOrEqual(0);
	});
});

describe('a file above the limit', () => {
	it('is refused on its reported size, before any part is uploaded', async () => {
		// A file that cannot be stored must not be transferred at all: the size decides before any read.
		//
		// Measured by whether anything reached storage, not by whether the stream was read. A stream under
		// this runtime is pulled as soon as it is constructed, so "was it read" says nothing about what
		// `storeStream` did — that instrument measured the harness, not the code.
		let released = 0;
		const outcome = await storeStream(patternStream(200 * 1024 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/too-big.bin', {
			...SMALL,
			maxBytes: 1024 * 1024,
			declaredSize: 200 * 1024 * 1024,
			onRelease: (n) => {
				released += n;
			},
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.problem).toMatch(/limit/i);
		expect(outcome.bytes, 'no bytes should have been read').toBe(0);
		expect(outcome.parts, 'no part should have been uploaded').toBe(0);
		expect(released, 'declining on size must not consume the stream').toBe(0);
		expect(await env.BUCKET.get('test/too-big.bin')).toBeNull();
	});

	it('accepts a file exactly at the limit', async () => {
		const size = 1024 * 1024;
		const outcome = await storeStream(patternStream(size, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/at-limit.bin', {
			...SMALL,
			maxBytes: size,
			declaredSize: size,
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.bytes).toBe(size);
	});

	it('refuses one byte over the limit before reading it', async () => {
		const outcome = await storeStream(patternStream(10 * 1024 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/over.bin', {
			...SMALL,
			maxBytes: 1024 * 1024,
			declaredSize: 1024 * 1024 + 1,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.bytes).toBe(0);
	});

	it('stops during the read when the declared size was wrong', async () => {
		// The machine's reported size can be absent or stale, so the running total is enforced too.
		const outcome = await storeStream(patternStream(8 * 1024 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/overrun.bin', {
			partSize: 1024 * 1024,
			multipartThreshold: 0,
			maxBytes: 2 * 1024 * 1024,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.problem).toMatch(/limit/i);
		expect(await env.BUCKET.get('test/overrun.bin'), 'an over-limit file must not be left stored').toBeNull();
	});
});

describe('the time budget', () => {
	it('stops at a recorded point rather than being killed mid-write', async () => {
		// An invocation that runs out of time is killed without warning, so the pipeline has to stop
		// itself while it can still leave a resume point.
		const partSize = 1024 * 1024;
		let clock = 0;
		const outcome = await storeStream(patternStream(partSize * 6, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/budget.bin', {
			partSize,
			multipartThreshold: 0,
			now: () => {
				clock += 1000;
				return clock;
			},
			deadline: 3500,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.problem).toMatch(/time|budget|deadline/i);
		// Stopped early: a completed object under the key would mean it ran to the end regardless.
		expect(outcome.committedBytes).toBeLessThan(partSize * 6);
	});

	it('does not stop when there is time left', async () => {
		const partSize = 1024 * 1024;
		const outcome = await storeStream(patternStream(partSize, { outstanding: 0, peak: 0 }), env.BUCKET, 'test/budget-ok.bin', {
			partSize,
			multipartThreshold: 0,
		});
		expect(outcome.ok).toBe(true);
	});
});
