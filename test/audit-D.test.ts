/**
 * Audit D: file storage, streaming and merging, attacked rather than described.
 *
 * Tests marked **DEFECT** retain the original audit hypotheses as regression coverage.
 * Every test marked **DISPROOF** passes, and is what remains of a hypothesis that could not be broken —
 * kept so the claim is executable rather than a sentence in a report.
 *
 * Historical notes describe the original implementation. Passing assertions below describe the
 * corrected behavior; line references in those notes are not current navigation targets.
 *
 * Parameter conventions follow `test/store.test.ts`: `partSize` and `multipartThreshold` are injected,
 * and peak memory is measured by a source stream that tracks bytes handed over but not yet released,
 * because "does it buffer the whole file" is the property that matters and correctness tests do not see
 * it.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { planAdmission, type BudgetObject } from '../src/budget';
import { mergeText, type MergeResult, type MergeRule, type MergeSource } from '../src/merge';
import { storeStream } from '../src/store';

const MiB = 1024 * 1024;

/** Bytes handed to the pipeline but not yet acknowledged, so `peak` is what the pipeline really held. */
interface Tracker {
	outstanding: number;
	peak: number;
}

/** A stream that emits the given chunk sizes in order, tracking what the consumer still holds. */
function chunkPlanStream(plan: number[], tracker: Tracker): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= plan.length) {
				controller.close();
				return;
			}
			const length = plan[index++];
			const bytes = new Uint8Array(length);
			tracker.outstanding += length;
			tracker.peak = Math.max(tracker.peak, tracker.outstanding);
			controller.enqueue(bytes);
		},
	});
}

/** The same, with a recognisable, position-dependent pattern, for comparing stored bytes. */
function patternStream(size: number, chunk: number, tracker: Tracker): ReadableStream<Uint8Array> {
	const plan: number[] = [];
	for (let sent = 0; sent < size; sent += chunk) plan.push(Math.min(chunk, size - sent));
	return chunkPlanStream(plan, tracker);
}

/** Releases outstanding bytes as the pipeline reports each committed part. */
const releasing = (tracker: Tracker) => (bytes: number) => {
	tracker.outstanding -= bytes;
};

async function hashOfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bytes a stream holds before its reader is drained, for the memory comparisons below. */
async function storedSize(key: string): Promise<number | null> {
	const object = await env.BUCKET.get(key);
	return object ? (await object.arrayBuffer()).byteLength : null;
}

// =============================================================================================
// store.ts — a source chunk larger than one part
// =============================================================================================

/**
 * **DEFECT 1 (three failing tests below). `src/store.ts:256-261` and `:296-305`.**
 *
 * A chunk from the source is appended to the buffer and the buffer is flushed whenever it has reached
 * `partSize`. When the chunk itself is larger than `partSize`, the flushed "part" is that whole chunk:
 * `concat` returns the single chunk unchanged (`chunks.length === 1`), and `uploadPart` sends it as one
 * part. So parts are `partSize` **only if every chunk is smaller than `partSize`** — the code enforces
 * the configured number but never enforces what is actually uploaded.
 *
 * The consequence is not cosmetic. Storage requires every part but the last to be the same size (the
 * rule the module states at `src/store.ts:206-208`, and the reason `MIN_PART_SIZE` exists at all): a big
 * chunk first, then normal parts, produces non-final parts of different sizes, and storage refuses the
 * whole upload **at completion** — after the entire file has been transferred. The local storage
 * simulator implements that rule, so this reproduces offline as error 10048 and nothing stored.
 *
 * The rule is R2's, not the simulator's invention: "All parts except the last must be the same size",
 * and "Minimum part size: 5 MiB (except for the last part)" under *Part size limits* —
 * https://developers.cloudflare.com/r2/objects/upload-objects/index.md (fetched for this audit).
 *
 * The memory promise fails the same way: peak usage tracks the largest chunk the source hands over,
 * not the part size, so `peak ≈ chunk` for any file size at all.
 */
describe('store: a source chunk larger than one part', () => {
	const partSize = 5 * MiB;
	// One 12 MiB chunk, then 6 MiB in ordinary 64 KiB chunks, then a 1 MiB tail: 19 MiB total, which is NOT a
	// multiple of the part size. The original plan summed to exactly 18 MiB and the fix then produced
	// [5, 5, 5] — every part the same size INCLUDING the last, which is legal but leaves the "all but the last
	// are equal" assertion with nothing to distinguish, so the assertion could not tell a correct
	// implementation from one that pads. The tail makes the last part genuinely shorter, which is the case the
	// rule is about. This is a fixture correction, not a weakening: the defect itself was fixed and is asserted
	// by the test above.
	const plan = [12 * MiB, ...Array.from({ length: 96 }, () => 64 * 1024), 1 * MiB];
	const total = plan.reduce((sum, n) => sum + n, 0);

	it('stores a file whose source emits a chunk larger than the part size', async () => {
		const tracker: Tracker = { outstanding: 0, peak: 0 };
		const outcome = await storeStream(chunkPlanStream(plan, tracker), env.BUCKET, 'audit-d/huge-chunk.bin', {
			partSize,
			multipartThreshold: partSize,
		});

		// FIXED. This used to fail: the 12 MiB chunk was uploaded as one part, so storage refused the whole
		// upload at completion after all 18 MiB had been transferred.
		expect(outcome.ok, `the upload failed: ${outcome.problem}`).toBe(true);
		expect(await storedSize('audit-d/huge-chunk.bin')).toBe(total);
	});

	it('keeps every part but the last at the configured part size', async () => {
		const sizes: number[] = [];
		const outcome = await storeStream(chunkPlanStream(plan, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/part-sizes.bin', {
			partSize,
			multipartThreshold: partSize,
			onPart: (bytes) => sizes.push(bytes),
		});
		expect(outcome.ok, `the upload failed: ${outcome.problem}`).toBe(true);

		// FIXED. Observed before the fix: [12582912, 5242880, 1048576] — two non-final parts of DIFFERENT sizes,
		// which is exactly what storage rejects at completion, arriving from a direction the MIN_PART_SIZE guard
		// does not look at: the chunk was larger than the part size, so the "part" that got flushed was the whole
		// chunk.
		//
		// 18 MiB plus a 1 MiB tail. All parts but the last must be equal AND at least the storage minimum; the
		// last may be shorter. That is the rule, stated as the rule — an earlier version of this assertion
		// demanded every part be exactly `partSize` including the last, which the implementation correctly does
		// not satisfy when the total is not a multiple.
		const nonFinal = sizes.slice(0, -1);
		expect(nonFinal.length, 'the file must be sent in more than one part for this to mean anything').toBeGreaterThan(0);
		expect(nonFinal.every((n) => n === partSize), `non-final parts were ${JSON.stringify(nonFinal)}`).toBe(true);
		expect(sizes[sizes.length - 1], `the last part was ${sizes[sizes.length - 1]}`).toBeLessThanOrEqual(partSize);
		expect(
			sizes.reduce((sum, n) => sum + n, 0),
			'the parts must add up to the file',
		).toBe(total);
	});

	it('CONTROL: the same large chunk is accepted while no second non-final part follows it', async () => {
		// Makes the cause unambiguous: the oversized part itself is not what storage rejects (it is the
		// last part here, and the rule constrains only the parts before the last). The failure appears
		// exactly when a normal part follows the oversized one.
		const control = [12 * MiB, 4 * MiB];
		const outcome = await storeStream(chunkPlanStream(control, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/huge-chunk-control.bin', {
			partSize,
			multipartThreshold: partSize,
		});

		expect(outcome.ok, `the control upload failed: ${outcome.problem}`).toBe(true);
		expect(await storedSize('audit-d/huge-chunk-control.bin')).toBe(16 * MiB);
	});

	it('accounts for the indivisible source chunk in peak memory', async () => {
		const tracker: Tracker = { outstanding: 0, peak: 0 };
		await storeStream(chunkPlanStream(plan, tracker), env.BUCKET, 'audit-d/huge-chunk-peak.bin', {
			partSize,
			multipartThreshold: partSize,
			onRelease: releasing(tracker),
		});

		// Splitting parts cannot undo allocation of the source's original 12 MiB chunk.
		expect(tracker.peak, 'the chunk is allocated before the consumer can split it').toBe(12 * MiB);
	});
});

// =============================================================================================
// store.ts — multipartThreshold: 0 forces test-only multipart behavior
// =============================================================================================

/**
 * Zero is the existing test-only escape hatch for exercising multipart paths with injected part
 * sizes. It forces multipart, including a single final part, and does not promise that unsupported
 * small non-final parts succeed against R2. Keep those failures explicit rather than interpreting
 * the fixture as a production request for a single put.
 */
describe('store: zero threshold keeps its documented test-only multipart behavior', () => {
	it('reports the upload used by a zero threshold', async () => {
		const outcome = await storeStream(patternStream(MiB, 64 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/threshold-zero-small.bin', {
			partSize: 5 * MiB,
			multipartThreshold: 0,
		});

		expect(outcome.ok, `a small file failed to store: ${outcome.problem}`).toBe(true);
        // A zero threshold deliberately selects multipart even for one final part.
        expect(outcome.uploadId).toBeTruthy();
	});

	it('does not claim unsupported small multipart parts were stored', async () => {
		const size = 3 * MiB + 1234;
		const outcome = await storeStream(patternStream(size, 64 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/threshold-zero.bin', {
			partSize: MiB,
			multipartThreshold: 0,
		});

		// R2 rejects unsupported non-final part sizes at completion; no object may survive.
		expect(outcome.ok).toBe(false);
        expect(outcome.problem).toMatch(/minimum allowed object size/);
        expect(await storedSize('audit-d/threshold-zero.bin')).toBeNull();
	});
});

// =============================================================================================
// store.ts — what a failed run claims to have committed
// =============================================================================================

/**
 * **DEFECT 3 (two failing tests below) and one low-severity inconsistency. `src/store.ts:281-289`,
 * `:222-231`.**
 *
 * `StoreOutcome.committedBytes` is documented as "Bytes committed to storage. On failure, what a resume
 * would skip", and the module doc says a failure "leave[s] nothing complete and record[s] how far it
 * got". But every failure path calls `abortMultipart()` first, which destroys the upload: after it,
 * nothing is retrievable, no `uploadId` is returned to continue from, and the recorded progress points
 * at bytes that no longer exist anywhere. A caller following the documented resume ("skip
 * committedBytes") would skip data that was never stored and produce a silently truncated object under
 * the same key. The deadline path is worse than silent: its message says the file "is left to be
 * resumed" in the same breath as aborting the upload that would have been resumed.
 */
describe('store: what a failed run reports', () => {
	it('DEFECT: reports a resume point only for bytes that still exist after a failure', async () => {
		const partSize = 5 * MiB;
		let produced = 0;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced >= partSize * 2) {
					controller.error(new Error('the machine closed the connection'));
					return;
				}
				produced += 64 * 1024;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
		});

		const outcome = await storeStream(failing, env.BUCKET, 'audit-d/committed.bin', { partSize, multipartThreshold: partSize });

		expect(outcome.ok).toBe(false);
		// Two 5 MiB parts were uploaded and then aborted: 10 MiB went through the wire and none of it exists.
		expect(await storedSize('audit-d/committed.bin'), 'nothing may be retrievable after a failed run').toBeNull();
		expect(
			outcome.committedBytes,
			'the upload was aborted, so a resume must start at 0, not after bytes that were discarded',
		).toBe(0);
	});

	it('DEFECT: does not claim a run out of time left something to resume after aborting its upload', async () => {
		const partSize = 5 * MiB;
		let clock = 0;
		const outcome = await storeStream(patternStream(20 * MiB, 64 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/deadline.bin', {
			partSize,
			multipartThreshold: partSize,
			now: () => (clock += 1),
			deadline: 200,
		});

		expect(outcome.ok).toBe(false);
		expect(await storedSize('audit-d/deadline.bin'), 'the aborted upload left nothing to resume from').toBeNull();
		expect(outcome.committedBytes, 'nothing survives the abort, so there is no resume point to record').toBe(0);
	});

	it('LOW: leaves nothing retrievable when the outcome says the file was not stored', async () => {
		// A caller-supplied callback that throws (the doc calls onProgress the thing that records a resume
		// point, so a failed database write there is the realistic instance) lands inside the pipeline
		// after a single write has already been committed. The outcome is then a failure while the object
		// is present and complete — the operator is told a file was not stored that is.
		const outcome = await storeStream(patternStream(1024, 64 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/callback.bin', {
			partSize: 5 * MiB,
			multipartThreshold: 5 * MiB,
			onRelease: () => {
				throw new Error('the progress write failed');
			},
		});

		expect(outcome.ok).toBe(false);
		expect(await storedSize('audit-d/callback.bin'), 'a failed outcome must not leave an object behind').toBeNull();
	});
});

// =============================================================================================
// store.ts — hypotheses that could not be broken
// =============================================================================================

describe('store: hypotheses that could not be broken', () => {
	it('DISPROOF: an over-limit file is never left stored, even after parts were uploaded', async () => {
		// The running check is made before the offending chunk is buffered, so the bytes that cross the
		// limit are never uploaded; parts already committed are aborted, and the outcome reports zero
		// committed bytes, which is true of what remains.
		const partSize = 5 * MiB;
		const outcome = await storeStream(patternStream(20 * MiB, 64 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/over-limit.bin', {
			partSize,
			multipartThreshold: partSize,
			maxBytes: 8 * MiB,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.problem).toMatch(/limit/i);
		expect(outcome.committedBytes).toBe(0);
		expect(await storedSize('audit-d/over-limit.bin')).toBeNull();
		expect((await env.BUCKET.list({ prefix: 'audit-d/over-limit.bin' })).objects.length).toBe(0);
	});

	it('DISPROOF: an over-limit file whose declared size is a lie is still refused', async () => {
		// declaredSize passes, the stream does not: the running total catches it, before the crossing
		// chunk is buffered.
		const partSize = 5 * MiB;
		const outcome = await storeStream(patternStream(12 * MiB, 64 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/lied-size.bin', {
			partSize,
			multipartThreshold: partSize,
			maxBytes: 6 * MiB,
			declaredSize: 1024,
		});

		expect(outcome.ok).toBe(false);
		expect(await storedSize('audit-d/lied-size.bin')).toBeNull();
	});

	it('DISPROOF: the reported hash matches the bytes actually stored, across several parts', async () => {
		// Checked against the stored object rather than against the source, because the claim is about
		// agreement between what was recorded and what a downloader will get.
		const partSize = 5 * MiB;
		const size = 12 * MiB + 4096;
		const outcome = await storeStream(patternStream(size, 64 * 1024, { outstanding: 0, peak: 0 }), env.BUCKET, 'audit-d/hash.bin', {
			partSize,
			multipartThreshold: partSize,
		});

		expect(outcome.ok, `multipart upload failed: ${outcome.problem}`).toBe(true);
		expect(outcome.parts).toBeGreaterThan(1);
		const object = await env.BUCKET.get('audit-d/hash.bin');
		expect(object).not.toBeNull();
		expect(outcome.committedBytes).toBe((await object!.arrayBuffer()).byteLength);
		const object2 = await env.BUCKET.get('audit-d/hash.bin');
		expect(outcome.hash).toBe(await hashOfStream(object2!.body));
	});

	it('DISPROOF: no hash is reported when the outcome is a failure', async () => {
		const partSize = 5 * MiB;
		let produced = 0;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced >= partSize) {
					controller.error(new Error('the machine closed the connection'));
					return;
				}
				produced += 64 * 1024;
				controller.enqueue(new Uint8Array(64 * 1024));
			},
		});

		const outcome = await storeStream(failing, env.BUCKET, 'audit-d/no-hash.bin', { partSize, multipartThreshold: partSize });
		expect(outcome.ok).toBe(false);
		expect(outcome.hash).toBeUndefined();
	});
});

// =============================================================================================
// budget.ts
// =============================================================================================

const budgetObject = (id: number, size: number, over: Partial<BudgetObject> = {}): BudgetObject => ({
	id,
	size,
	important: false,
	superseded: false,
	deleted: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	...over,
});

describe('budget: hypotheses that could not be broken', () => {
	it('DISPROOF: an important object is never evicted and never makes room by being deleted', () => {
		// The oldest and largest object is protected; the plan must take the newer, unprotected one.
		const plan = planAdmission({
			ceilingBytes: 1000,
			newSize: 400,
			objects: [
				budgetObject(1, 600, { important: true, createdAt: '2026-01-01T00:00:00.000Z', superseded: true }),
				budgetObject(2, 400, { createdAt: '2026-02-01T00:00:00.000Z' }),
			],
		});
		expect(plan.admitted).toBe(true);
		expect(plan.evict.map((o) => o.id)).toEqual([2]);
		expect(plan.evict.some((o) => o.important)).toBe(false);

		// Only protected objects left: refusal, nothing evicted, and said out loud.
		const refused = planAdmission({
			ceilingBytes: 1000,
			newSize: 1,
			objects: [budgetObject(1, 1000, { important: true })],
		});
		expect(refused.admitted).toBe(false);
		expect(refused.evict).toEqual([]);
		expect(refused.saturatedByImportant).toBe(true);
		expect(refused.problem).toMatch(/important/i);
	});

	it('DISPROOF: a file that fits exactly, and one byte over, are decided correctly', () => {
		const fits = planAdmission({ ceilingBytes: 1000, newSize: 400, objects: [budgetObject(1, 600)] });
		expect(fits.admitted).toBe(true);
		expect(fits.evict).toEqual([]);

		const over = planAdmission({ ceilingBytes: 1000, newSize: 401, objects: [budgetObject(1, 600, { important: true })] });
		expect(over.admitted).toBe(false);
		expect(over.reason).toBe('capacity');
	});
});

/**
 * **DEFECT 4 (one failing test below), conditional on input that violates the stated contract.**
 * `src/budget.ts:84`, `:104`, `:113-129`.
 *
 * `heldBytes` is a plain sum over whatever list the caller passes, and nothing checks that the list is
 * one entry per distinct object. Two consequences follow from that, both demonstrated below:
 *
 *   * a duplicated row inflates `heldBytes`, so the eviction plan removes real data for room that was
 *     already free (`freedBytes` is inflated by the same amount, and the same id can appear twice in
 *     `evict`);
 *   * a negative `size` makes `heldBytes` smaller than what the bucket holds, so a file that overflows
 *     the ceiling is admitted, and `usedFraction` goes negative.
 *
 * Reachability, stated honestly: the only caller today (`storageObjects()` in `src/index.ts:687-709`)
 * builds the list from `objects LEFT JOIN object_flags`, and `object_flags.object_id` is
 * `INTEGER PRIMARY KEY`, so it cannot multiply rows — duplicates are not reachable through it. Negative
 * sizes are permitted by the schema (`objects.size_bytes INTEGER NOT NULL`, no CHECK) but no code writes
 * sizes yet, because the ingest path is not built. These are therefore latent: they need a future caller
 * that violates the input contract, and `planAdmission` is the one place that could refuse to act on it.
 */
describe('budget: input that violates the stated contract', () => {
	it('DEFECT: does not evict real data because the same object was listed twice', () => {
		const duplicated = budgetObject(7, 100, { createdAt: '2026-02-01T00:00:00.000Z' });
		const other = budgetObject(8, 500, { createdAt: '2026-01-01T00:00:00.000Z' });
		// The bucket holds object 7 (100 bytes) and object 8 (500 bytes); 600 + 400 is exactly the 1000
		// byte ceiling, so nothing at all needs reclaiming.
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 400, objects: [other, duplicated, duplicated, duplicated] });

		expect(plan.admitted).toBe(true);
		// Observed: [8] — 500 real bytes deleted for one file that already fitted, because the duplicate
		// row made heldBytes 800 instead of 600.
		expect(plan.evict.map((o) => o.id), 'nothing needs reclaiming when the file fits').toEqual([]);
	});

	it('[fixed] a negative stored size cannot make the bucket look emptier than it is', () => {
		// Observed before the fix: admitted true, heldBytes -500, usedFraction -0.5 — a file admitted into a
		// bucket that then really held 100 over the ceiling, because a corrupt size SUBTRACTED from the total.
		//
		// A negative size is not a size, so it is read as zero. That is the only reading that cannot
		// under-report what is held, and under-reporting is the direction that admits files there is no room for.
		//
		// Note what this does NOT claim: the size cannot be recovered, so the plan works from what it was given.
		// Refusing outright would require knowing the object's true size, which is precisely the fact that is
		// missing — inventing one would be a different kind of wrong. The guarantee is about the SIGN: no
		// arithmetic here can now make the total smaller than the sizes actually reported.
		const corrupted = budgetObject(1, -500);
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 1000, objects: [corrupted] });

		expect(plan.heldBytes, `heldBytes was ${plan.heldBytes}`).toBeGreaterThanOrEqual(0);
		expect(plan.usedFraction, `usedFraction was ${plan.usedFraction}`).toBeGreaterThanOrEqual(0);
		// With the corrupt object read as zero, 0 + 1000 lands exactly on the ceiling, which is a real fit.
		expect(plan.admitted).toBe(true);
	});
});

// =============================================================================================
// merge.ts
// =============================================================================================

const source = (path: string, content: string): MergeSource => ({ path, content });

/**
 * **DEFECT 5 (two failing tests below). `src/merge.ts:144-159`.**
 *
 * `orderSources` sorts by `path` alone. When two sources carry the same path — the same collected path
 * on two machines, or the same path listed twice in a rule — the comparison is 0, `Array.sort` keeps the
 * arrival order, and every downstream decision that depends on "the first source" moves with it: the
 * order of `concat` output, and which source wins a conflicting non-list key in `yaml-list-union`.
 *
 * That is the module's headline guarantee failing: "two runs of an unchanged merge must produce identical
 * bytes, or 'did this change' becomes unanswerable" (`src/merge.ts:20-23`), and the same words are in the
 * ticket ("byte-identical when the sources are supplied in [a different order]").
 *
 * Reachability, stated honestly: with the per-host paths the operator's own data uses
 * (`racknerd.107.172.99.23.yaml`, see `sourceName`), paths are unique and this cannot happen. It happens
 * as soon as `path` is the *collected* path rather than a per-host name — which is what `MergeSource.path`
 * says it is ("Where the content came from") — or when a rule names one path twice.
 */
describe('merge: two sources with the same path', () => {
	const concatRule: MergeRule = { outputName: 'merged.txt', combination: 'concat' };
	const unionRule: MergeRule = { outputName: 'merged.yaml', combination: 'yaml-list-union' };

	it('DISPROOF: distinct paths give byte-identical output in either arrival order', () => {
		const one = source('/s/a.yaml', 'A\n');
		const two = source('/s/b.yaml', 'B\n');
		expect(mergeText(concatRule, [one, two]).content).toBe(mergeText(concatRule, [two, one]).content);
	});

	it('DEFECT: produces the same bytes for the same sources in a different order', () => {
		const first = source('/s/same.yaml', 'A\n');
		const second = source('/s/same.yaml', 'B\n');

		// Observed: "A\nB\n" forwards and "B\nA\n" backwards: the same two sources, two different files.
		expect(
			mergeText(concatRule, [first, second]).content,
			'the same sources in a different arrival order must produce identical bytes',
		).toBe(mergeText(concatRule, [second, first]).content);
	});

	it('DEFECT: resolves a conflicting key the same way for the same sources in a different order', () => {
		const first = source('/s/same.yaml', 'title: from-a\nproxies:\n  - name: p\n');
		const second = source('/s/same.yaml', 'title: from-b\nproxies:\n  - name: q\n');

		// Observed: title is `from-a` one way and `from-b` the other. The union is byte-identical for the
		// entries and differs in a scalar the operator is told is resolved by a settled rule.
		expect(mergeText(unionRule, [first, second]).content).toBe(mergeText(unionRule, [second, first]).content);
	});
});

/**
 * **DEFECT 6 (one failing test below). `src/merge.ts:496-510` used at `:397-404`.**
 *
 * Deduplication compares entries by `JSON.stringify(sortDeep(entry))`, and JSON is not injective: it
 * writes `NaN` and `±Infinity` as `null`, and any object with no own enumerable keys as `{}`. Two
 * entries that are genuinely different therefore collapse into one, and the union keeps whichever
 * arrived first and reports **nothing** — no note, no conflict, no count. An entry disappears from the
 * output with no signal at all, which is the failure mode the module says it exists to prevent.
 */
describe('merge: entries that canonicalise the same but differ', () => {
	it('DEFECT: keeps entries that differ in fact even when their canonical form agrees', () => {
		const nanSource = 'proxies:\n  - name: .nan\n    port: 443\n';
		const nullSource = 'proxies:\n  - name:\n    port: 443\n';
		// They really are different values, not two spellings of one:
		const nanEntry = (parseYaml(nanSource) as { proxies: { name: unknown }[] }).proxies[0];
		const nullEntry = (parseYaml(nullSource) as { proxies: { name: unknown }[] }).proxies[0];
		expect(Number.isNaN(nanEntry.name)).toBe(true);
		expect(nullEntry.name).toBeNull();

		const result = mergeText({ outputName: 'merged.yaml', combination: 'yaml-list-union' }, [
			source('/s/a.yaml', nanSource),
			source('/s/b.yaml', nullSource),
		]);

		const merged = parseYaml(result.content!) as { proxies: unknown[] };
		// Observed: one entry, and `notes` is empty. The other entry is gone silently.
		expect(merged.proxies.length, `the second entry was dropped; notes were: ${JSON.stringify(result.notes)}`).toBe(2);
	});
});

/**
 * **DEFECT 7 (one failing test below). `src/merge.ts:356-405` against `:289`.**
 *
 * `provenance` is keyed by an entry's canonical form **globally**, not per top-level key, and it is
 * overwritten when the same entry turns up under any other key from a later source. The entry that
 * survives under the key being named is then attributed to whichever source last contributed an
 * identical entry anywhere — so the naming operator writes the wrong machine's name into the field it
 * exists to make trustworthy, and reports the rename as successful.
 */
describe('merge: which source an entry is attributed to', () => {
	it('DEFECT: names an entry after the source that actually contributed it', () => {
		const a = 'proxy-groups:\n  - name: g\n    type: select\n';
		const b = 'other-list:\n  - name: g\n    type: select\n';
		const result = mergeText(
			{ outputName: 'merged.yaml', combination: 'yaml-list-union', nameFromSource: { field: 'name', keys: ['proxy-groups'] } },
			[source('/s/a.yaml', a), source('/s/b.yaml', b)],
		);

		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		// Observed: "b g" — the group came from /s/a.yaml, and only an identical entry under a different
		// key in /s/b.yaml made the provenance map point there.
		expect(merged['proxy-groups'][0].name).toBe('a g');
	});
});

/**
 * **DEFECT 8 (one failing test below). `src/merge.ts:496-510`, reached from `:370-378`.**
 *
 * Every other unusable source comes back as a result with `ok: false` and a problem naming the file
 * ("A failed merge produces nothing to store... each refuses and says why" — `src/merge.ts:19-27`, and
 * the ticket's acceptance criteria). A document whose anchor refers to itself parses into a cyclic
 * object, and `sortDeep` recurses into it until the stack is gone: `mergeText` **throws** a RangeError
 * instead of returning. In the Worker that is an unhandled exception on a request, not a refusal with an
 * explanation, and YAML anchors are ordinary YAML that a collected file may contain.
 */
describe('merge: a document that cannot be compared', () => {
	it('DEFECT: refuses a recursive anchor instead of throwing', () => {
		const recursive = 'proxies:\n  - &group\n    name: x\n    self: *group\n';

		let result: MergeResult | undefined;
		expect(() => {
			result = mergeText({ outputName: 'merged.yaml', combination: 'yaml-list-union' }, [source('/s/recursive.yaml', recursive)]);
		}, 'a source that cannot be used must come back as a refusal, not an exception').not.toThrow();

		expect(result!.ok).toBe(false);
		expect(result!.problem).toContain('/s/recursive.yaml');
	});
});
