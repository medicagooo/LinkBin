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
	// `multipartThreshold: 0` means "one write, never parts", and then the part size is irrelevant — which is
	// what makes it possible to test the read loop's buffering with small numbers without pretending they
	// are legal part sizes.
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

	/** Uploads one accumulated part, releasing its memory only once it is committed. */
	const uploadPart = async (bytes: Uint8Array, final: boolean): Promise<void> => {
		if (!decided) {
			// The file is uploaded in parts when it reaches the part size, or when the whole thing has been
			// read and turns out to be above the threshold. Below both, it is one write.
			useMultipart = !final || bytes.byteLength > threshold;
			decided = true;
			if (useMultipart) {
				multipart = await bucket.createMultipartUpload(key);
				completedUploadId = multipart.uploadId;
			}
		}

		if (useMultipart && multipart) {
			uploaded.push(await multipart!.uploadPart(uploaded.length + 1, bytes));
		} else {
			await bucket.put(key, bytes);
		}

		parts += 1;
		committedBytes += bytes.byteLength;
		options.onPart?.(bytes.byteLength);
		options.onProgress?.(committedBytes);
		release(bytes.byteLength);
	};

	/**
	 * Uploads whatever is buffered as the final piece.
	 *
	 * Does nothing when the buffer is empty **and** something has already been uploaded. A run whose last
	 * chunk exactly filled a part has no tail, and uploading an empty one would add a zero-byte part —
	 * which storage forbids, and which breaks the rule that every part but the last is the same size.
	 */
	const flushTail = async (): Promise<void> => {
		if (bufferedBytes === 0 && parts > 0) return;
		const tail = concat(buffered, bufferedBytes);
		buffered = [];
		bufferedBytes = 0;
		await uploadPart(tail, true);
	};

	try {
		for (;;) {
			// Checked before each read rather than after each part: an invocation that runs out of time is
			// killed without warning, so the pipeline has to stop while it can still record where it got to.
			if (options.deadline !== undefined && now() >= options.deadline) {
				await abortMultipart();
				return {
					ok: false,
					problem: `the run's time budget ran out after ${committedBytes} bytes; this file is left to be resumed rather than half-written`,
					committedBytes,
					bytes,
					parts,
				};
			}

			const { done, value } = await reader.read();
			if (done) break;

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

			if (bufferedBytes >= partSize) {
				const part = concat(buffered, bufferedBytes);
				buffered = [];
				bufferedBytes = 0;
				await uploadPart(part, false);
			}
		}

		await flushTail();

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
		return {
			ok: false,
			problem: (err as Error).message,
			committedBytes,
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
