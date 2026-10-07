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

/** The per-file ceiling and the total capacity budget. Duplicated from the router deliberately; see below. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const STORAGE_BUDGET_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * What the store currently holds, for the capacity check.
 *
 * A narrow read rather than `measureStorage`, so this module does not depend on the router — the two constants
 * above are duplicated for the same reason. A single number with one definition matters more than one location:
 * a mismatch here would be caught by the test that a file above the limit is refused, which asserts the exact
 * figure.
 *
 * Reclaimed objects are excluded, for the reason `planAdmission` documents: their bytes are gone, so charging
 * for them would have the store refuse new files forever after its first eviction.
 */
async function heldBytes(db: D1Database): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(o.size_bytes), 0) AS n
			 FROM objects o
			 LEFT JOIN object_reclaims r ON r.object_id = o.id
			 WHERE r.object_id IS NULL`,
		)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** The key a collected file is stored under. */
export function objectKeyFor(hostId: string, path: string): string {
	// The host is part of the key, not only of the row: two machines holding `/etc/app.conf` are two different
	// files, and a key without the host would have the second overwrite the first.
	//
	// The PATH is the key, with no version component, and that is forced by the schema rather than chosen:
	// `idx_objects_host_path` is a plain unique index over (host_id, path) covering every row, so two versions of
	// one file cannot both have rows — and therefore cannot both have keys worth distinguishing. The consequence
	// is stated because it is easy to assume otherwise: **superseding a file overwrites its predecessor's BYTES.**
	// The older row survives as a record of what the file hash and size were and when it was replaced, and the
	// newer row says what replaced it, but the older CONTENT is gone.
	//
	// That is a deliberate trade rather than an oversight: this is a distribution store for current files, not a
	// version archive, and keeping every previous version of every collected file would spend the 10 GB budget on
	// history. The `history` view in the interface is honest about it — it offers a replaced file's record, not
	// its bytes — and a versioned key would need a schema change and a different retention policy.
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
		/**
		 * Whether this file could be stored, asked before its bytes are requested.
		 *
		 * Two refusals, and both are cheaper to make now than after a transfer:
		 *
		 *   - **Above the per-file limit.** Nothing can make room for a file that is too large, so reading it
		 *     would transfer bytes that are then discarded. The ticket states this as "its bytes are never
		 *     requested", and this is the check that makes that true.
		 *   - **No capacity.** A full store refuses before the read rather than after it. Room is not reclaimed
		 *     here: eviction is a decision with data loss attached, and it belongs where an operator can see it,
		 *     not buried inside a file-sized decision during a collection.
		 *
		 * A size the machine did not report is `null`, and `null` cannot be checked in advance — so the file is
		 * ATTEMPTED, and the store's own running total is what stops it. Treating an unknown size as "small
		 * enough" would let a huge file through the gate; treating it as "too large" would skip files that fit.
		 */
		async canStore({ size }) {
			if (size === null) return { ok: true as const };

			if (size > MAX_FILE_BYTES) {
				return {
					ok: false as const,
					reason: `the file is ${size} bytes, above the ${MAX_FILE_BYTES} byte per-file limit, so its bytes were not requested`,
					skipped: true,
					size,
				};
			}

			const held = await heldBytes(env.DB);
			if (held + size > STORAGE_BUDGET_BYTES) {
				return {
					ok: false as const,
					reason: `storing ${size} bytes would take the bucket past its ${STORAGE_BUDGET_BYTES} byte budget, of which ${Math.max(0, STORAGE_BUDGET_BYTES - held)} bytes remain`,
					skipped: false,
					size,
				};
			}

			return { ok: true as const };
		},

		async store({ path, stream, mtime }) {
			const key = objectKeyFor(hostId, path);

			const outcome = await storeStream(stream, env.BUCKET, key, {
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
				const tooLarge = /larger than|limit/i.test(outcome.problem ?? '');
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
				return { ok: true as const, bytes, hash, unchanged: true };
			}

			// BYTES ARE ALREADY DURABLE at this point — `storeStream` completed. Only now is any row written.
			//
			// A changed file SUPERSEDES its previous version rather than overwriting it, which is what ticket 05
			// asks for. That takes two writes, and their order is dictated by a constraint rather than chosen.
			//
			// **The order here is the opposite of what was first written, and only the database could show why.**
			// The first attempt inserted the new version and then pointed the old one at it, reasoning that
			// superseding first "risks leaving no live version". `idx_objects_host_path` refused the insert
			// outright: it is a PLAIN unique index over (host_id, path) with no partial clause, so two rows for one
			// path are impossible whether or not either is live. The two-row moment was not merely visible, it was
			// unreachable.
			//
			// So the old version is retired FIRST, and "retired" has to mean `deleted_at` rather than
			// `superseded_by`, because `superseded_by` needs the new row's id and the new row cannot exist yet.
			// The new row then takes the path, and the two rows are linked afterwards.
			//
			// What an interruption leaves, in each gap:
			//
			//   - after retiring, before inserting: no live row for the path. The next run scans, finds no live
			//     row, and stores the file again. The bytes from this attempt are orphaned under a key nothing
			//     references — the budget counts them, and evicts them. The FILE is not lost.
			//   - after inserting, before linking: a live row for the newest version and a retired row for the
			//     older one, unlinked. The listing is correct; only the "replaced by" link is missing.
			//
			// Neither is the unrecoverable state, which would be a live row with no bytes behind it — and no
			// ordering can produce that, because `storeStream` has already reported success before either write.
			const now = nowIso();

			if (existing) {
				await env.DB.prepare('UPDATE objects SET deleted_at = ? WHERE id = ?').bind(now, existing.id).run();
			}

			const inserted = await env.DB.prepare(
				`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, mtime, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(hostId, path, key, bytes, hash, mtime, now)
				.run();

			// Linked after the fact, and this write is the one that can be lost without harm: it turns "a retired
			// version and a current one" into "a current one, with its predecessor recorded". A failure here
			// leaves the older row looking deleted rather than superseded, which the history view shows as a
			// removal instead of a replacement — wrong, but recoverable, and better than losing the file.
			if (existing) {
				await env.DB.prepare('UPDATE objects SET superseded_by = ? WHERE id = ?')
					.bind(Number(inserted.meta.last_row_id), existing.id)
					.run();
			}

			return { ok: true as const, bytes, hash, unchanged: false };
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

/** The cursor a stopped run leaves, naming the machine and how far it got. */
export function cursorFor(hostId: string, outcomes: CollectedFile[] | { path: string }[]): string {
	return JSON.stringify({ hostId, reached: outcomes.length });
}
