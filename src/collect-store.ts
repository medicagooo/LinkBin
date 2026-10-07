/**
 * The storage side of a collection run: the object rows, the issues, and the run record.
 *
 * `collect.ts` decides *what happens* and takes plain callbacks rather than a database, so the decision is
 * testable with no D1 at all. This module is the other half — the part that talks to D1 and R2 — kept separate
 * for the same reason `evict.ts` is separate from `budget.ts`: a policy that writes as it decides cannot be
 * tested without writing.
 *
 * ## The one ordering rule, restated where it is implemented
 *
 * **Bytes before the row.** An object's row is inserted only after `storeStream` has reported the bytes durable.
 * The reverse — a row first, then an upload that fails — leaves the listing offering a file that is not there,
 * which is the one state a later run cannot repair because nothing distinguishes it from a file that was stored
 * and then evicted. Bytes without a row are invisible and get reclaimed by the budget, which is recoverable.
 */

import type { CollectedFile } from './collect';
import { storeStream } from './store';
import { nowIso } from './db';
import { closeSession, recordMultipartSession } from './multipart';

import { MAX_FILE_BYTES, STORAGE_BUDGET_BYTES, measureStorage, reclaimFor, publishVersion, withStorageWriter } from './storage';

/** Prefix only; each upload appends a random version id so failure and reclamation cannot touch its predecessor. */
export function objectKeyFor(hostId: string, path: string): string {
    return `objects/${hostId}${path}`;
}

/** One content hash, as lowercase hex. */
export async function hashOf(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The live row for one (machine, path), or null. The idempotency spine of the whole store. */
export async function liveObject(
	db: D1Database,
	hostId: string,
	path: string,
): Promise<{ id: number; content_hash: string; object_key: string; size_bytes: number } | null> {
	return await db
		.prepare('SELECT id, content_hash, object_key, size_bytes FROM objects WHERE host_id = ? AND path = ? AND deleted_at IS NULL AND superseded_by IS NULL')
		.bind(hostId, path)
		.first<{ id: number; content_hash: string; object_key: string; size_bytes: number }>();
}

export interface RunWritePorts {
	/** Adds 1 to a counter on the run row, so an interrupted run's totals are close rather than absent. */
	bumpRun(runId: number, field: 'stored_count' | 'skipped_count' | 'failed_count' | 'bytes_stored', by: number): Promise<void>;
	/** Records one issue. Called at most once per file. */
	addIssue(runId: number, hostId: string, issue: { path: string | null; kind: string; reason: string; size: number | null }): Promise<void>;
}

/**
 * The ports a collection run needs, wired to real storage.
 *
 * `runId` and `hostId` are captured rather than passed per call because every write in one run belongs to the
 * same run and machine — passing them through the walk would be three chances to pass the wrong one.
 */
export function collectionPorts(
	env: { DB: D1Database; BUCKET: R2Bucket },
	hostId: string,
	runId: number,
	options: { deadline?: number; partSize?: number; multipartThreshold?: number } = {},
): {
	store(input: { path: string; stream: ReadableStream<Uint8Array>; mtime: number | null }): Promise<
		{ ok: true; bytes: number; hash: string; unchanged: boolean } | { ok: false; reason: string; skipped: boolean; size: number | null }
	>;
	recordIssue(input: { path: string | null; kind: string; reason: string; size: number | null }): Promise<void>;
	recordProgress(totals: { stored: number; skipped: number; failed: number; unchanged: number; bytesStored: number }): Promise<void>;
} {
	const writes: RunWritePorts = {
		async bumpRun(id, field, by) {
			// Named columns rather than a parameterised one: a column name cannot be a bound parameter, and the
			// field is a closed union so nothing from a request can reach it.
			await env.DB.prepare(`UPDATE collection_runs SET ${field} = ${field} + ? WHERE id = ?`).bind(by, id).run();
		},
		async addIssue(id, host, issue) {
			await env.DB.prepare(
				`INSERT INTO collection_issues (run_id, host_id, path, kind, reason, size_bytes, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(id, host, issue.path, issue.kind, issue.reason, issue.size, nowIso())
				.run();
		},
	};

	return {
        /** Preflight enforces file size and executes the configured oldest-unprotected eviction policy. */
        async canStore({ path, size }) {
            if (size === null) return { ok: true as const };
            if (size > MAX_FILE_BYTES) return { ok: false as const, reason: `the file is ${size} bytes, above the ${MAX_FILE_BYTES} byte per-file limit, so its bytes were not requested`, skipped: true, size };
            return await withStorageWriter(env, async () => {
                const previous = await liveObject(env.DB, hostId, path);
                const room = await reclaimFor(env.DB, env.BUCKET, size, nowIso(), previous?.id);
                return room.admitted ? { ok: true as const } : { ok: false as const, reason: room.problem ?? 'the storage capacity budget is full', skipped: false, size };
            });
        },

        async store({ path, stream, mtime }) {
            return await withStorageWriter(env, async () => {
            const key = `${objectKeyFor(hostId, path)}/${crypto.randomUUID()}`;
            const usage = await measureStorage(env.DB, env.BUCKET);
            const remaining = Math.max(0, STORAGE_BUDGET_BYTES - usage.totalBytes);
            const maxBytes = Math.min(MAX_FILE_BYTES, remaining);

			const outcome = await storeStream(stream, env.BUCKET, key, {
                maxBytes,
                partSize: options.partSize ?? 8 * 1024 * 1024,
                multipartThreshold: options.multipartThreshold ?? 8 * 1024 * 1024,
                deadline: options.deadline ?? Date.now() + 5 * 60 * 1000,
				...(options.deadline === undefined ? {} : { deadline: options.deadline }),
				...(options.partSize === undefined ? {} : { partSize: options.partSize }),
				...(options.multipartThreshold === undefined ? {} : { multipartThreshold: options.multipartThreshold }),
			});

			if (!outcome.ok) {
				// A multipart upload that was started and then failed has already sent parts, and those parts hold
				// quota until something aborts them. The id is recorded HERE, on the failure path, because that is
				// the only moment it exists: `storeStream` aborts internally and does not return a resumable id, so
				// what a later cleanup can do is bounded by what this records.
				if (outcome.uploadId) {
					await recordMultipartSession(env.DB, { hostId, path, objectKey: key, uploadId: outcome.uploadId, partSize: options.partSize ?? 0, totalBytes: outcome.committedBytes });
				}
				// A file refused for size is a SKIP and everything else is a failure. That distinction is what
				// `DELIBERATE_KINDS` reads to decide whether an operator needs to look.
				const tooLarge = maxBytes === MAX_FILE_BYTES && /larger than|limit/i.test(outcome.problem ?? '');
				return { ok: false as const, reason: outcome.problem ?? 'the file was not stored', skipped: tooLarge, size: null };
			}

			// The hash comes from the bytes that were ACTUALLY stored, not from a second read of the machine: a
			// second read can race a change and record a hash of something that was never uploaded.
			const hash = outcome.hash ?? '';
			const bytes = outcome.bytes;

			// A MULTIPART upload that has already been completed leaves its session row behind if one was opened,
			// and an unfinished one is exactly what cleanup exists for. The distinction matters: a completed upload
			// whose row stayed 'open' would be aborted by the next run's cleanup, which for a completed upload is a
			// no-op at storage but a lie in the table.
			await closeSession(env.DB, hostId, key);

			// Content decides whether a file is new, not the timestamp. A touched file is the same file, and an
			// edit is detected even when the modification time did not move — which `mtimes` a size check would
			// get backwards.
			const existing = await liveObject(env.DB, hostId, path);
			if (existing && existing.content_hash === hash) {
                await env.BUCKET.delete(key);
				return { ok: true as const, bytes, hash, unchanged: true };
			}

            await publishVersion(env, { hostId, path, key, bytes, hash, mtime });

			return { ok: true as const, bytes, hash, unchanged: false };
            });
		},

		async recordIssue(issue) {
			// Written the moment it is known, as its own row, so a run killed partway still explains everything it
			// had already decided.
			await writes.addIssue(runId, hostId, issue);
		},

		async recordProgress(totals) {
			// Set to the running totals rather than incremented, because the totals are already cumulative and
			// incrementing them would multiply every count on every file.
			await env.DB.prepare('UPDATE collection_runs SET stored_count = ?, skipped_count = ?, failed_count = ?, bytes_stored = ? WHERE id = ?')
				.bind(totals.stored, totals.skipped, totals.failed, totals.bytesStored, runId)
				.run();
		},
	};
}

/** Opens a run row as `running`, so an interrupted run is visibly unfinished rather than absent. */
export async function openRun(db: D1Database, hostId: string, cursorJson: string | null): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO collection_runs (host_id, state, started_at, cursor_json, stored_count, skipped_count, failed_count, bytes_stored)
			 VALUES (?, 'running', ?, ?, 0, 0, 0, 0)`,
		)
		.bind(hostId, nowIso(), cursorJson)
		.run();
	return Number(result.meta.last_row_id);
}

/**
 * Closes a run.
 *
 * `finished` is the normal case. `stopped` is a run that hit its budget and left deliberately: it is not a
 * failure, and marking it `finished` would claim a scan completed that did not, so the next run would not resume
 * where this one stopped. That distinction is the whole point of recording a cursor.
 */
export async function closeRun(
	db: D1Database,
	runId: number,
	state: 'finished' | 'stopped',
	totals: { stored: number; skipped: number; failed: number; bytesStored: number },
	cursorJson: string | null,
): Promise<void> {
	await db
		.prepare(
			`UPDATE collection_runs
			 SET state = ?, finished_at = ?, stored_count = ?, skipped_count = ?, failed_count = ?, bytes_stored = ?, cursor_json = ?
			 WHERE id = ?`,
		)
		.bind(state, nowIso(), totals.stored, totals.skipped, totals.failed, totals.bytesStored, cursorJson, runId)
		.run();
}

/**
 * The cursor a stopped run leaves, naming the machine and how far it got.
 *
 * ## The shape is fixed by `parseCursor`, and the earlier version did not match it
 *
 * This wrote `{ hostId, reached }` and `parseCursor` requires `{ hostId, position, startedAt }`, rejecting
 * anything else. **So every cursor this project ever wrote was unusable**: `planRun` received `null`, never set
 * `resumeFrom`, and the run started from the beginning — while the route reported a cursor it had stored itself.
 * The defect was invisible because each half was tested on its own and each half was internally consistent.
 *
 * `position` carries the count `collectFrom` reported: how many files from the front of the resolved order this
 * run got through. It is a STRING because `RunCursor.position` is opaque to the scheduler, which only carries it;
 * the walk is what interprets it, and the walk is what produced it.
 *
 * `startedAt` is the run's own start rather than the moment it stopped, because that is what the field means and
 * what the rotation already uses `collection_runs.started_at` for. The two must agree, so the caller passes it in
 * rather than this function reading a clock.
 */
export function cursorFor(hostId: string, resumed: number, startedAt: string): string {
	return JSON.stringify({ hostId, position: String(resumed), startedAt });
}
