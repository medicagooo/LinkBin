/**
 * Collecting: reading the files the rules select, and recording what happened.
 *
 * The two halves that already existed meet here. `resolveRules` decides *which* paths a machine's rules select,
 * `storeStream` puts *one* file's bytes into storage safely, and `budget.ts` decides whether there is room. What
 * was missing is the part that walks the list, and — more importantly — the part that records the outcome, so
 * that "why did this stop syncing" has an answer instead of silence.
 *
 * ## Why this is written against ports rather than against a machine
 *
 * Everything below takes a `RemoteHost` and plain callbacks instead of a database and a bucket. That is not
 * tidiness: it is what makes the whole pipeline testable with no host, no network and no credentials, which is
 * the difference between a ticket that can be finished and one that waits for infrastructure. The `RemoteHost`
 * port was built for exactly this, and `TEST_REMOTE` is the deployment-side half of the same idea.
 *
 * ## The order of the writes
 *
 * D1 has no transactions, so a run can be interrupted at any point and the state it leaves has to be reasoned
 * about rather than assumed away. The order below is chosen so an interruption is always recoverable:
 *
 *   1. the run row is created as `running`, so an interrupted run is visibly unfinished rather than absent;
 *   2. each issue is written as its own row the moment it is known, so a run killed partway still explains
 *      everything it had already decided;
 *   3. each file's object row is written only after its bytes are durable;
 *   4. the run is marked `finished` last, with its counts.
 *
 * A row without a finished run is an unfinished run, which is true. Bytes without a row are invisible to the
 * listing and reclaimed by the budget, which is the safe direction. A row claiming a file that was never stored
 * would be the one unrecoverable state, and step 3 is what prevents it.
 */

import { COLLECTION_MATCH_LIMIT, filesToCollect, resolveRules, type RemoteHost } from './remote';
import type { RuleEvaluation } from './remote';

/** One file the rules selected. */
export interface CollectedFile {
	path: string;
	/** The rule that selected it, so a later report can say why it was taken. */
	pattern: string;
}

/**
 * What the walk decided about one file.
 *
 * `skipped` is deliberately its own outcome rather than a kind of failure. A file too large for the per-file
 * limit needs a decision about the limit; a file that could not be read needs investigating. Collapsing them
 * would hide which one the operator is looking at.
 */
export type FileOutcome =
	| { path: string; kind: 'stored'; bytes: number; hash: string; mtime: number | null }
	| { path: string; kind: 'unchanged'; hash: string }
	| { path: string; kind: 'skipped'; reason: string; size: number | null }
	| { path: string; kind: 'failed'; reason: string };

export interface RunTotals {
	stored: number;
	skipped: number;
	failed: number;
	unchanged: number;
	bytesStored: number;
}

export interface CollectionPorts {
	/** The rules to resolve against the machine. */
	rules: { pattern: string; is_exclude: number; host_id: string | null }[];
	/**
	 * Stores one file's bytes, returning what happened.
	 *
	 * Returns the content hash on success so the caller does not have to hash the file a second time, and so the
	 * hash recorded is the one computed over the bytes that were actually stored rather than over a second read
	 * that might have raced a change on the machine.
	 */
	store(input: {
		path: string;
		stream: ReadableStream<Uint8Array>;
		mtime: number | null;
	}): Promise<{ ok: true; bytes: number; hash: string; unchanged: boolean } | { ok: false; reason: string; skipped: boolean; size: number | null }>;
	/** Records one issue the moment it is known. Called at most once per file. */
	recordIssue(input: { path: string | null; kind: string; reason: string; size: number | null }): Promise<void>;
	/** Called after each file so a run's progress survives an interruption. */
	recordProgress?(totals: RunTotals): Promise<void>;
	/** A wall-clock budget, so the walk leaves before the invocation is killed. */
	deadline?: number;
	now?: () => number;
}

/** The largest number of files one run will walk, so a machine with a huge directory cannot run away. */
export const MAX_FILES_PER_RUN = 2000;

/**
 * Resolves the rules and walks the files they select.
 *
 * Returns the totals and the per-file outcomes; it does NOT decide what a run row looks like, because that is
 * storage shape and belongs to the caller. What it does own is the order of the calls, which is the part with the
 * correctness argument.
 */
export async function collectFrom(
	remote: RemoteHost,
	ports: CollectionPorts,
): Promise<{ totals: RunTotals; outcomes: FileOutcome[]; evaluations: RuleEvaluation[]; stoppedEarly: boolean }> {
	const now = ports.now ?? (() => Date.now());
	const totals: RunTotals = { stored: 0, skipped: 0, failed: 0, unchanged: 0, bytesStored: 0 };
	const outcomes: FileOutcome[] = [];

	// The COLLECTION limit, not the display default. `resolveRules` caps the names it returns at 50 unless told
	// otherwise, and `filesToCollect` consumes exactly those names — so using the default would collect the first
	// 50 files per rule and report a successful run while silently leaving the rest. Found by a test that asked a
	// rule to match more than 50 files.
	const evaluations = await resolveRules(remote, ports.rules, COLLECTION_MATCH_LIMIT);
	const wanted: CollectedFile[] = filesToCollect(evaluations);

	// Rules that could not be resolved are recorded, not silently dropped. "The directory could not be read" and
	// "the directory is empty" look identical in a count of stored files, and only one of them needs fixing.
	for (const evaluation of evaluations) {
		if (evaluation.status === 'error') {
			await ports.recordIssue({
				path: null,
				kind: 'rule_unreadable',
				// The machine's own words, so a permission problem is diagnosable without guessing.
				reason: `could not resolve ${evaluation.pattern}: ${evaluation.detail ?? 'the machine did not say why'}`,
				size: null,
			});
			totals.failed += 1;
		}
	}

	let stoppedEarly = false;

	for (const file of wanted.slice(0, MAX_FILES_PER_RUN)) {
		if (ports.deadline !== undefined && now() >= ports.deadline) {
			// Left rather than killed. The caller marks the run unfinished and records the cursor, so the next run
			// resumes instead of starting again.
			stoppedEarly = true;
			break;
		}

		let stat: { size?: number; mtime?: number; isDirectory: boolean };
		try {
			stat = await remote.stat(file.path);
		} catch (err) {
			// A file that vanished between discovery and reading is an issue, not a crash: it is a normal thing for
			// a log file to be rotated mid-run.
			await ports.recordIssue({
				path: file.path,
				kind: 'vanished',
				reason: (err as Error).message || 'the file could not be read',
				size: null,
			});
			totals.failed += 1;
			outcomes.push({ path: file.path, kind: 'failed', reason: 'vanished' });
			continue;
		}

		// A directory is not a file to store. Skipped with a reason rather than attempted: reading it would fail
		// and the failure would look like a permissions problem.
		if (stat.isDirectory) {
			totals.skipped += 1;
			outcomes.push({ path: file.path, kind: 'skipped', reason: 'it is a directory', size: null });
			continue;
		}

		// A size the machine did not report is `null`, NOT zero. Zero means an empty file and would be stored as
		// one; unknown means "ask the stream", which is what the store does when no size is given.
		const reportedSize = typeof stat.size === 'number' && Number.isFinite(stat.size) && stat.size >= 0 ? stat.size : null;
		const mtime = typeof stat.mtime === 'number' && Number.isFinite(stat.mtime) ? Math.floor(stat.mtime) : null;

		let stream: ReadableStream<Uint8Array>;
		try {
			stream = await remote.read(file.path);
		} catch (err) {
			await ports.recordIssue({ path: file.path, kind: 'unreadable', reason: (err as Error).message || 'the file could not be opened', size: reportedSize });
			totals.failed += 1;
			outcomes.push({ path: file.path, kind: 'failed', reason: 'unreadable' });
			continue;
		}

		const result = await ports.store({ path: file.path, stream, mtime });

		if (result.ok) {
			if (result.unchanged) {
				// Not an issue. A file that has not changed is the normal case for an incremental scan, and
				// recording it as a problem would turn the issue list into a log of everything.
				totals.unchanged += 1;
				outcomes.push({ path: file.path, kind: 'unchanged', hash: result.hash });
			} else {
				totals.stored += 1;
				totals.bytesStored += result.bytes;
				outcomes.push({ path: file.path, kind: 'stored', bytes: result.bytes, hash: result.hash, mtime });
			}
		} else {
			await ports.recordIssue({
				path: file.path,
				// The kind distinguishes a decision from a fault, which `DELIBERATE_KINDS` in receipts.ts reads to
				// decide whether an operator needs to look.
				kind: result.skipped ? 'too_large' : 'failed',
				reason: result.reason,
				size: result.size,
			});
			if (result.skipped) totals.skipped += 1;
			else totals.failed += 1;
			outcomes.push(result.skipped
				? { path: file.path, kind: 'skipped', reason: result.reason, size: result.size }
				: { path: file.path, kind: 'failed', reason: result.reason });
		}

		// After every file, so an interrupted run's counts are close rather than absent.
		if (ports.recordProgress) await ports.recordProgress(totals);
	}

	return { totals, outcomes, evaluations, stoppedEarly };
}
