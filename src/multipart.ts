/**
 * Recording and cleaning up multipart uploads that outlive the invocation that started them.
 *
 * ## Why this exists at all
 *
 * R2 multipart parts are **already uploaded** — they are not bytes sitting in a Worker's memory waiting to be
 * sent. So an upload abandoned part way does not merely lose work: **the parts occupy storage and count against
 * the quota** until something completes or aborts them. Nothing in R2 expires them.
 *
 * A Worker invocation cannot hold that state. It can be killed between parts, and the parts it already sent are
 * only reachable through the `uploadId` — which is why this is a table rather than a variable.
 *
 * ## What this does and does not do, stated plainly
 *
 * It records the id, and it ABORTS abandoned uploads so their parts stop holding quota. It does not yet RESUME
 * one: continuing would mean re-reading the source from the beginning to skip the bytes already stored, and the
 * value of that depends on the answer to ticket 04 — what throughput a real machine gives, and whether a file
 * large enough to be interrupted is even reachable in one run. Recording the id is what makes resumption
 * possible later without another schema change; until then a retry starts the file again, which is waste rather
 * than corruption.
 *
 * That distinction is the whole reason this module is honest about being half: `store.test.ts` already records a
 * KNOWN VERIFIED GAP around the abort, because the local simulator keeps incomplete uploads invisible to `list`.
 * So "cleaned up" and "left behind" look identical there, and the tests below assert what IS observable — that
 * the session is no longer open, and that its id is no longer offered for reuse.
 */

import { nowIso } from './db';

export interface MultipartSession {
	id: string;
	hostId: string;
	path: string;
	objectKey: string;
	uploadId: string;
	partSize: number;
	partsJson: string;
	state: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * How long an open session may sit before it is treated as abandoned.
 *
 * Generous, because a slow upload is not an abandoned one — and the cost of being wrong in this direction is
 * quota held a little longer, while the cost of the other is aborting an upload that was still progressing.
 */
export const ABANDONED_AFTER_MS = 3 * 60 * 60 * 1000;

/** The row id for one upload. Deterministic, so re-recording the same upload updates rather than duplicates. */
export function sessionIdFor(hostId: string, objectKey: string): string {
	return `${hostId}\u0000${objectKey}`;
}

/**
 * Records an upload that a caller must be able to find again.
 *
 * `INSERT OR REPLACE` on a deterministic id, so recording the same upload twice is one row. The alternative — an
 * autoincrement id — would let a retried file leave a second row pointing at the same upload, and cleanup would
 * then abort it twice and count it twice.
 */
export async function recordMultipartSession(
	db: D1Database,
	input: { hostId: string; path: string; objectKey: string; uploadId: string; partSize: number; totalBytes: number },
): Promise<void> {
	const now = nowIso();
	await db
		.prepare(
			`INSERT OR REPLACE INTO multipart_sessions
			   (id, host_id, path, object_key, upload_id, total_bytes, part_size, parts_json, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'open', ?, ?)`,
		)
		.bind(sessionIdFor(input.hostId, input.objectKey), input.hostId, input.path, input.objectKey, input.uploadId, input.totalBytes, input.partSize, now, now)
		.run();
}

/** The sessions still open for one machine, oldest first. */
export async function openSessions(db: D1Database, hostId: string): Promise<MultipartSession[]> {
	const { results } = await db
		.prepare(
			`SELECT id, host_id AS hostId, path, object_key AS objectKey, upload_id AS uploadId,
			        part_size AS partSize, parts_json AS partsJson, state,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM multipart_sessions
			 WHERE host_id = ? AND state = 'open'
			 ORDER BY created_at`,
		)
		.bind(hostId)
		.all<MultipartSession>();
	return results ?? [];
}

/**
 * Abandons open sessions whose parts are holding quota for nothing.
 *
 * Called at the START of a run for the machine about to be scanned, and that timing is deliberate: the only
 * uploads that can still be live are ones from an invocation that has already ended, because a run for this
 * machine is not running concurrently with itself. Aborting them first means a file that keeps failing cannot
 * accumulate parts run after run — which is the failure this prevents, and it is a slow one: each attempt adds
 * parts, none are released, and the store fills with uploads nothing will ever complete.
 *
 * `age` is injected so the rule can be tested without waiting three hours.
 */
export async function abandonStaleSessions(
	db: D1Database,
	bucket: R2Bucket,
	hostId: string,
	options: { now?: number; olderThanMs?: number } = {},
): Promise<{ abandoned: string[]; failed: string[] }> {
	const now = options.now ?? Date.now();
	const age = options.olderThanMs ?? ABANDONED_AFTER_MS;

	const abandoned: string[] = [];
	const failed: string[] = [];

	for (const session of await openSessions(db, hostId)) {
		const started = Date.parse(session.createdAt);
		// An unparseable timestamp is treated as OLD rather than as new. A row whose age cannot be established is
		// one nothing will ever clean up, so the safe reading is the one that releases its quota.
		const stale = !Number.isFinite(started) || now - started >= age;
		if (!stale) continue;

		try {
			await bucket.resumeMultipartUpload(session.objectKey, session.uploadId).abort();
			abandoned.push(session.id);
		} catch {
			// Already aborted, already completed, or expired at storage. Either way there is nothing left to
			// release, so the row is marked rather than retried forever — a cleanup that never converges is worse
			// than one that gives up and says so.
			failed.push(session.id);
		}

		await db
			.prepare("UPDATE multipart_sessions SET state = 'abandoned', updated_at = ? WHERE id = ?")
			.bind(nowIso(), session.id)
			.run();
	}

	return { abandoned, failed };
}

/** Marks a session finished, so cleanup stops looking at it. */
export async function closeSession(db: D1Database, hostId: string, objectKey: string): Promise<void> {
	await db
		.prepare("UPDATE multipart_sessions SET state = 'complete', updated_at = ? WHERE id = ?")
		.bind(nowIso(), sessionIdFor(hostId, objectKey))
		.run();
}
