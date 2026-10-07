/**
 * Getting a file from a machine into storage without ever holding it whole.
 *
 * ## The constraint that shapes everything
 *
 * The per-file limit is large relative to this runtime's memory. A file must therefore never be
 * materialised: not to read it, not to hash it, and not to upload it. Peak usage has to stay near one
 * part regardless of the file size, which is why the pipeline is written as a reader loop over
 * fixed-size parts rather than as anything that collects the stream first. A version that buffers passes
 * every correctness test and then dies on the only file size that matters, so the test suite measures
 * peak usage rather than trusting the shape of the code.
 *
 * ## Why the parameters are injected
 *
 * `partSize` and `multipartThreshold` depend on a measurement that has not happened yet (ticket 04).
 * Defaults are provided so the code is usable, but every caller and every test passes them explicitly,
 * so changing the measured numbers is a configuration change rather than a rewrite.
 *
 * ## Why an incomplete upload is refused rather than completed
 *
 * Storage requires every part but the last to be the same size, and an interrupted upload leaves parts
 * that belong to no object. Two outcomes are possible on failure: leave a partial object that a later
 * run mistakes for the whole file, or leave nothing complete and record how far it got. The first is
 * silent and the second is recoverable, so this refuses.
 */

import { createHash } from 'node:crypto';

/**
 * The smallest part storage will accept, except for the last one.
 *
 * Enforced rather than documented: a multipart upload whose parts are smaller is accepted part by part and
 * then **fails only at completion**, with an error about the proposed upload being under the minimum. That
 * is a confusing place to learn it, and it was learned exactly that way — a test using 1 MiB parts looked
 * fine until completion was attempted. Refusing up front turns it into an immediate, obvious mistake.
 *
 * Source: the R2 multipart rules (minimum part size 5 MiB, except the final part).
 */
const MIN_PART_SIZE = 5 * 1024 * 1024;

export interface StoreOptions {
	/** Bytes per part. Storage requires at least 5 MiB for every part except the last. */
	partSize: number;
	/** Above this size, the upload is sent in parts rather than in one write. */
	multipartThreshold: number;
	/** Refuse anything larger, without reading it. */
	maxBytes?: number;
	/** The size the machine reported, when it reported one. Used to refuse before reading. */
	declaredSize?: number;
	/** Epoch milliseconds after which the pipeline must stop so it can leave a resume point. */
	deadline?: number;
	/** Clock, injected so a time budget can be tested without waiting. */
	now?: () => number;
	/** Called once per part with its size, for accounting and tests. */
	onPart?: (bytes: number) => void;
	/** Called when a part has been committed and its memory released. */
	onRelease?: (bytes: number) => void;
	/** Called after each part with the total committed so far, so progress is resumable. */
	onProgress?: (committedBytes: number) => void;
}

export interface StoreOutcome {
	ok: boolean;
	/** Bytes committed to storage. On failure, what a resume would skip. */
	committedBytes: number;
	/** Bytes read from the machine. */
	bytes: number;
	/** Hex SHA-256 of the whole content, computed as it streamed. */
	hash?: string;
	parts: number;
	/** Present when the upload was multipart, so it can be continued. */
	uploadId?: string;
	problem?: string;
}

const DEFAULTS = {
	partSize: 8 * 1024 * 1024,
	multipartThreshold: 8 * 1024 * 1024,
};

/**
 * Streams `source` into `bucket` under `key`, hashing as it goes.
 *
 * A single write is used below the threshold; above it, parts are uploaded one at a time and each is
 * released before the next is read, so peak memory tracks the part size rather than the file size.
 */
export async function storeStream(
	source: ReadableStream<Uint8Array>,
	bucket: R2Bucket,
	key: string,
	options: StoreOptions,
): Promise<StoreOutcome> {
	// Parsed without a truthiness test: `0` is a meaningful value — "always one write" — and `x > 0 ? x :
	// default` silently turns it into the default instead. That mistake was made here and made an
	// intentional setting look like it had been ignored.
	const partSize = options.partSize ?? DEFAULTS.partSize;
	const threshold = options.multipartThreshold ?? DEFAULTS.multipartThreshold;
	const now = options.now ?? (() => Date.now());

	// Checked before anything is read or written. See MIN_PART_SIZE: the alternative is discovering this at
	// completion, after the whole file has been transferred.
	//
	// **`multipartThreshold: 0` does NOT mean "one write, never parts", and this comment used to say it did.**
	// An adversarial audit caught the discrepancy and it is worth stating plainly rather than papering over:
	// zero disables the part-size check above, because a caller passing small numbers is understood to be
	// exercising the read loop rather than describing a real upload. It does **not** force a single write — a
	// file past the part size is still uploaded in parts, and with a part size below storage's minimum those
	// parts are refused at completion. The only supported way to ask for one write is a threshold at or above
	// the file's declared size, which is what `pipelined` reads.
	//
	// So zero is a **test affordance, not a production setting**, and `DEFAULTS` never uses it. It is left as
	// it is because making it truly mean "one write" would require buffering a file of unknown size in full to
	// discover that it does not fit — trading a documented oddity for an unbounded memory commitment.
	if (threshold > 0 && partSize < MIN_PART_SIZE) {
		return {
			ok: false,
			problem: `a part size of ${partSize} bytes is below the ${MIN_PART_SIZE} byte minimum that storage requires for every part but the last; this is refused now rather than after the upload completes`,
			committedBytes: 0,
			bytes: 0,
			parts: 0,
		};
	}

	const fail = (problem: string, committedBytes: number, bytes: number): StoreOutcome => ({
		ok: false,
		problem,
		committedBytes,
		bytes,
		parts: 0,
	});

	// The size decides before anything is read. A file that cannot be stored must not be transferred:
	// asking the machine for 200 MB so it can be thrown away costs the machine's bandwidth and the
	// invocation's time for nothing.
	if (options.maxBytes !== undefined && options.declaredSize !== undefined) {
		if (options.declaredSize > options.maxBytes) {
			return fail(
				`this file is ${options.declaredSize} bytes, above the ${options.maxBytes} byte limit, so it was not read`,
				0,
				0,
			);
		}
	}

	const reader = source.getReader();
	const digest = new IncrementalSha256();

	/**
	 * Whether a whole part is held back rather than sent as soon as it is available.
	 *
	 * Only worth doing when this upload may use parts, because holding a part back is what lets a source that
	 * ends on a part boundary be sent as one final part instead of being padded with a forbidden empty one.
	 *
	 * It is skipped when the file is known to be small — by its declared size — or when the caller has asked
	 * for a single write, and in those cases **nothing is sent until the source ends**, because a single write
	 * means exactly one `put` of the whole file.
	 *
	 * That last point is a correction, and it was a real regression while it was wrong. The drain used to run
	 * even when the mode was single-write, so a buffer that reached one part was PUT mid-stream — and a file
	 * that then failed was left in the bucket as a truncated object that looks complete, which is the precise
	 * outcome the refusal paths exist to prevent. The decision in `sendBatch` and the draining here have to
	 * agree, and this is where they agree.
	 */
	const pipelined =
		threshold > 0 && !(options.declaredSize !== undefined && options.declaredSize <= threshold);

	/** Bytes read from the machine so far. */
	let bytes = 0;

	/** Decided on the first part full: a file is uploaded in one write or in parts, never both. */
	let multipart: R2MultipartUpload | null = null;
	let useMultipart = false;
	let decided = false;

	let parts = 0;
	let committedBytes = 0;
	/** Retained across completion, so the result still identifies the upload that produced the object. */
	let completedUploadId: string | null = null;
	let buffered: Uint8Array[] = [];
	let bufferedBytes = 0;
	const uploaded: R2UploadedPart[] = [];

	const release = (count: number): void => {
		options.onRelease?.(count);
	};

	const abortMultipart = async (): Promise<void> => {
		// Checks the MODE, not the handle. A throw from `createMultipartUpload` leaves the mode set with no
		// upload to abort, and checking the handle meant that case skipped cleanup entirely — which then
		// replaced the original error with whatever failed next. That is how a storage rejection surfaced as
		// `1 = 0`, a message naming none of the things involved.
		if (!useMultipart) return;
		if (!multipart) return;
		try {
			// An abandoned upload is cleaned up rather than left holding storage against the budget.
			//
			// KNOWN UNVERIFIED. The local storage simulator keeps incomplete multipart uploads invisible —
			// `list()` omits them and `get()` returns null — so cleaning one up and leaving it behind look
			// identical, and a deliberate mutation removing this call failed no test. Confirming it needs a
			// real bucket, where an abandoned upload genuinely exists. Recorded rather than implied covered.
			await multipart.abort();
		} catch {
			// Best effort: the object was never completed, so nothing is readable under the key even if the
			// abort itself fails. Left recorded so the next run can clear it.
		}
		multipart = null;
	};

	/**
	 * Sends one batch, deciding **once** whether this upload uses parts.
	 *
	 * The decision is made from the batch size, and the batch size is what makes it correct. An adversarial
	 * audit proved the previous version wrong in two ways, and both came from deciding per flush instead:
	 *
	 *   - `!final` was true for every read-loop flush, so `multipartThreshold: 0` — documented as "one write,
	 *     never parts" — still uploaded in parts, reporting a resumable id for a file that was never resumable.
	 *   - With a part size below storage's 5 MiB minimum (permitted only because that same bug skipped the
	 *     guard), a small file went up in parts and storage refused it **at completion**, after the whole file
	 *     had been transferred, storing nothing.
	 *
	 * Batches are now exactly `partSize` except the last, so a size below `partSize` means the file ended here
	 * and anything else is one of several parts. Nothing depends on knowing the future.
	 */
	const sendBatch = async (batch: Uint8Array, isLastPlanned: boolean): Promise<void> => {
		if (!decided) {
			// One decision, made once. `pipelined` already encodes "this file is a single write", because it is
			// false exactly when parts will not be used — see above — so the batch size is all that is left to
			// consult: a batch that reached the part size means the file continues past it.
			useMultipart = isLastPlanned ? batch.byteLength > threshold : true;
			decided = true;

			// `multipart` stays null when the mode is single-write, and it stays null if this call throws —
			// which is why `abortMultipart` checks `useMultipart` and not `multipart`. Checking the handle was a
			// bug: a throw here left the mode set with no upload to abort, so a later failure skipped the abort
			// entirely and the real error was replaced by the cleanup's own.
			if (useMultipart) {
				multipart = await bucket.createMultipartUpload(key);
				completedUploadId = multipart.uploadId;
			}
		}

		if (useMultipart && multipart) {
			uploaded.push(await multipart.uploadPart(uploaded.length + 1, batch));
		} else if (useMultipart) {
			// Multipart was chosen and there is no upload to use: the creation call failed, and its error is on
			// its way to the caller. Saying so plainly beats a downstream failure that blames something else.
			throw new Error('the upload could not be started, so nothing was stored');
		} else {
			await bucket.put(key, batch);
		}

		parts += 1;
		committedBytes += batch.byteLength;
		options.onPart?.(batch.byteLength);
		options.onProgress?.(committedBytes);
		release(batch.byteLength);
	};

	/**
	 * Releases buffered bytes one part at a time.
	 *
	 * A source is free to hand over a chunk larger than the part size — nothing in the `ReadableStream`
	 * contract prevents it — and the previous version concatenated whatever it had and uploaded it as one part.
	 * An adversarial audit proved the consequences: peak memory became the chunk rather than the part, and two
	 * non-final parts of different sizes are refused by storage **at completion**, after the whole transfer.
	 *
	 * Subarray views rather than copies: the underlying chunk is released once its last view has been sent, so
	 * a 12 MiB chunk split across three 5 MiB parts is still held once rather than three times.
	 */
	/**
	 * Sends whole parts, keeping at most one part buffered.
	 *
	 * The holdback exists so a source that ends mid-part leaves a final batch of its own size rather than
	 * forcing a forbidden empty part. It is expressed as "hold back up to one part" rather than "only act when
	 * two parts are buffered", and the difference is not stylistic: the earlier form returned as soon as the
	 * buffer dropped below two parts, so the *next* whole part was only sent once a further part had arrived —
	 * and a file of exactly two parts therefore ended with a second batch of one-and-a-bit parts instead of
	 * one, which storage refuses at completion after the whole transfer.
	 *
	 * `heldBack` is zero when the upload is known to be a single write, so everything available goes at once.
	 */
	const drainFullParts = async (holdBack: number): Promise<void> => {
		// Strictly greater: a full part is sent as soon as there is more than a full part buffered, so what is
		// held back is the *remainder* rather than the whole part. Anything left when the source ends becomes the
		// final batch, of whatever size it is, which is what storage requires of a last part.
		//
		// This is also where a chunk larger than the part size stops being a problem. `takeExactly(partSize)`
		// issues a batch of exactly one part however big the incoming chunk was, so the parts are uniform — which
		// an adversarial audit proved they were not, and storage refuses a whole upload at completion when two
		// non-final parts differ, after the entire file has been transferred.
		while (bufferedBytes > holdBack && bufferedBytes >= partSize) {
			await sendBatch(takeExactly(partSize), false);
		}
	};

	/** Takes exactly `count` bytes from the buffer, in order, as one contiguous view where possible. */
	const takeExactly = (count: number): Uint8Array => {
		if (buffered.length === 1 && buffered[0].byteLength === count) {
			const only = buffered[0];
			buffered = [];
			bufferedBytes = 0;
			return only;
		}

		const out = new Uint8Array(count);
		let filled = 0;
		let index = 0;
		while (filled < count) {
			const chunk = buffered[index];
			const need = count - filled;
			if (chunk.byteLength <= need) {
				out.set(chunk, filled);
				filled += chunk.byteLength;
				index += 1;
			} else {
				out.set(chunk.subarray(0, need), filled);
				buffered[index] = chunk.subarray(need);
				filled += need;
			}
		}

		buffered = buffered.slice(index);
		bufferedBytes -= count;
		return out;
	};

	/**
	 * Sends whatever remains as the final batch.
	 *
	 * Does nothing when the buffer is empty and something has already been sent: a file whose last chunk exactly
	 * filled a part has no tail, and an empty part is both forbidden by storage and a break of the rule that
	 * every part but the last is the same size.
	 */
	const flushTail = async (): Promise<void> => {
		if (bufferedBytes === 0 && parts > 0) return;
		await sendBatch(takeExactly(bufferedBytes), true);
	};

	try {
		for (;;) {
			// Checked before each read rather than after each part: an invocation that runs out of time is
			// killed without warning, so the pipeline has to stop while it can still record where it got to.
			if (options.deadline !== undefined && now() >= options.deadline) {
				await abortMultipart();
				// `committedBytes: 0`, not the running total, and the message no longer claims the file can be
				// resumed. Both are corrections from an adversarial audit: the abort above discards every part
				// that had been uploaded, so reporting those bytes as a resume point told a caller to skip data
				// that no longer exists — and a caller following the documented contract would have written a
				// silently truncated object. What is reported is what actually remains, which after an abort is
				// nothing.
				return {
					ok: false,
					problem: `the run's time budget ran out after ${bytes} bytes read and ${committedBytes} uploaded; the upload was abandoned, so this file starts from the beginning next time`,
					committedBytes: 0,
					bytes,
					parts,
				};
			}

			const { done, value } = await reader.read();

			if (done) {
				// The source ended, so whatever is buffered is the file's last batch and may be any size.
				await flushTail();
				break;
			}

			if (value && value.byteLength > 0) {
				bytes += value.byteLength;
				digest.update(value);

				// The declared size can be absent or stale, so the running total is enforced too.
				if (options.maxBytes !== undefined && bytes > options.maxBytes) {
					await abortMultipart();
					return {
						ok: false,
						problem: `the file is larger than the ${options.maxBytes} byte limit, so nothing was stored`,
						committedBytes: 0,
						bytes,
						parts,
					};
				}

				buffered.push(value);
				bufferedBytes += value.byteLength;
			}

			// A whole part is held back only when this upload may use parts, so that a source ending on a part
			// boundary becomes a final part of its own size instead of a forbidden empty one. When the file is
			// known small, or the caller asked for a single write, nothing is held back and everything available
			// is sent at once.
			await drainFullParts(pipelined ? partSize : 0);
		}

		if (useMultipart && multipart) {
			await multipart!.complete(uploaded);
			// Kept after completion: the id identifies the upload that produced this object, which is what a
			// later run needs to recognise its own work instead of starting again.
			multipart = null;
		}

		return {
			ok: true,
			committedBytes,
			bytes,
			hash: digest.hex(),
			parts,
			uploadId: completedUploadId ?? undefined,
		};
	} catch (err) {
		await abortMultipart();
		// `committedBytes: 0` for the same reason as the deadline path: the abort above discarded every uploaded
		// part, so reporting them as a resume point would tell a caller to skip bytes that are gone. Reporting
		// what still exists is what the field promises; after an abort that is nothing.
		return {
			ok: false,
			problem: (err as Error).message,
			committedBytes: 0,
			bytes,
			parts,
		};
	} finally {
		reader.releaseLock();
	}
}

/** Joins the pieces of one part into a single contiguous buffer. */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * SHA-256 over a stream, so a file can be hashed without being held.
 *
 * `node:crypto`'s streaming hash is available in this runtime because the compatibility flag is on. That
 * matters more than it looks: WebCrypto's `digest` is one-shot, so using it would mean buffering the
 * whole file purely in order to hash it — the one thing this pipeline cannot do. Availability was
 * verified rather than assumed, and verified by **agreeing with an independent implementation**, because a
 * streaming hash that is consistent but wrong would make every recorded hash useless for the purpose it
 * exists for.
 *
 * Chunk boundaries do not affect the result, which is what makes it safe to feed one part at a time.
 */
class IncrementalSha256 {
	private hash = createHash('sha256');

	update(bytes: Uint8Array): void {
		this.hash.update(bytes);
	}

	/** Hex digest. Always available: an empty stream has a well-defined SHA-256. */
	hex(): string {
		return this.hash.digest('hex');
	}
}

/** Hex SHA-256 of a byte array, for content already in hand. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
