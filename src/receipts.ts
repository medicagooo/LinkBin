/**
 * Receipts: what a run did, and what went wrong.
 *
 * ## Why this is a separate module rather than three queries in a route
 *
 * Three properties here are about honesty rather than features, and each is cheap to get wrong:
 *
 *   - **A run that never finished must not look like one that finished with nothing to do.** "Nothing
 *     found" and "we stopped halfway" lead to opposite conclusions, and the second is invisible if the
 *     summary only counts what happened.
 *   - **A successful file must not be recorded as an issue.** A list that includes successes stops being a
 *     list of problems exactly when it is longest and most needed.
 *   - **A file skipped for its size is not a failure.** It is a decision, it needs no investigation, and
 *     mixing it in with errors sends the operator looking for a fault that does not exist.
 *
 * ## Why the reason text is clamped
 *
 * A machine can emit an arbitrarily long error, and a stored row has a hard size limit. Truncating keeps
 * the beginning, which is where the useful part is, and says that it was cut — so nobody has to wonder
 * whether the message really ended there.
 */

export interface RunRow {
	id: number;
	host_id: string;
	state: string;
	started_at: string;
	finished_at: string | null;
	stored_count: number;
	skipped_count: number;
	failed_count: number;
	bytes_stored: number;
}

export interface IssueRow {
	id: number;
	run_id: number;
	host_id: string;
	path: string | null;
	kind: string;
	reason: string;
	size_bytes: number | null;
	created_at: string;
}

/** A run either succeeded, finished with things worth looking at, or did not finish at all. */
export type RunOutcome = 'success' | 'problems' | 'unfinished';

export interface IssueDetail {
	id: number;
	hostId: string;
	path: string | null;
	kind: string;
	reason: string;
	sizeBytes: number | null;
	createdAt: string;
	/**
	 * True when the file was skipped on purpose — too large, or refused for capacity — rather than failing.
	 * The interface uses this to separate "worth a look" from "nothing to do".
	 */
	deliberate: boolean;
}

export interface RunDetail {
	id: number;
	hostId: string;
	state: string;
	startedAt: string;
	finishedAt: string | null;
	/** Null for a run that never finished: a missing end time is not a zero-second run. */
	seconds: number | null;
	outcome: RunOutcome;
	stored: number;
	skipped: number;
	failed: number;
	bytesStored: number;
	issues: IssueDetail[];
	/** Issue counts by kind, so a pattern is visible without opening the run. */
	byKind: Record<string, number>;
}

export interface RunSummary {
	id: number;
	hostId: string;
	startedAt: string;
	finishedAt: string | null;
	seconds: number | null;
	outcome: RunOutcome;
	stored: number;
	skipped: number;
	failed: number;
	bytesStored: number;
	issueCount: number;
}

/** Kinds that represent a decision rather than a fault. */
const DELIBERATE_KINDS = new Set(['too_large', 'capacity', 'excluded', 'unchanged']);

/**
 * The longest reason kept.
 *
 * Comfortably above any real error message and far below the row limit, so a machine cannot fill the
 * database by being verbose.
 */
export const MAX_REASON_LENGTH = 2000;

/**
 * Truncates a reason to what can be stored, saying so when it cuts.
 *
 * The beginning is kept rather than the end: error messages lead with the problem, and the tail is
 * usually repetition or a path.
 */
export function clampReason(reason: string): string {
	if (reason.length <= MAX_REASON_LENGTH) return reason;
	return `${reason.slice(0, MAX_REASON_LENGTH)}… (truncated)`;
}

/** How a run ended, judged from what it recorded rather than from a flag that could disagree. */
export function runOutcome(row: RunRow): RunOutcome {
	if (row.state !== 'finished' || !row.finished_at) return 'unfinished';
	// A skip counts as worth reporting: it is a decision the operator may want to revisit, so hiding it
	// behind the word "success" would be a small lie in the direction of false reassurance.
	if (row.failed_count > 0 || row.skipped_count > 0) return 'problems';
	return 'success';
}

/** Newest first, with a deterministic tie-break so the order does not depend on the database. */
export function orderRuns(runs: RunRow[]): RunRow[] {
	return [...runs].sort((a, b) => {
		if (a.started_at !== b.started_at) return a.started_at < b.started_at ? 1 : -1;
		return b.id - a.id;
	});
}

/** One issue in the shape the interface reads. Exported so a flat issue list needs no run to convert it. */
export function toIssueDetail(row: IssueRow): IssueDetail {
	return {
		id: row.id,
		hostId: row.host_id,
		path: row.path,
		kind: row.kind,
		reason: row.reason,
		sizeBytes: row.size_bytes,
		createdAt: row.created_at,
		deliberate: DELIBERATE_KINDS.has(row.kind),
	};
}

/**
 * Everything the interface needs about one run.
 *
 * `issues` is always an array, never absent: the interface reads it directly, and an absent list would
 * render as nothing rather than as "none".
 */
export function runDetail(row: RunRow, issues: IssueRow[] = []): RunDetail {
	const mine = issues.filter((issue) => issue.run_id === row.id).sort((a, b) => {
		if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
		return a.id - b.id;
	});

	const byKind: Record<string, number> = {};
	for (const issue of mine) byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;

	const finished = row.finished_at ? Date.parse(row.finished_at) : null;
	const started = Date.parse(row.started_at);
	const seconds =
		finished !== null && Number.isFinite(finished) && Number.isFinite(started) ? Math.round((finished - started) / 1000) : null;

	return {
		id: row.id,
		hostId: row.host_id,
		state: row.state,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		seconds,
		outcome: runOutcome(row),
		stored: row.stored_count,
		skipped: row.skipped_count,
		failed: row.failed_count,
		bytesStored: row.bytes_stored,
		issues: mine.map(toIssueDetail),
		byKind,
	};
}

/**
 * One line per run, with its issue count.
 *
 * The count is included so a run with problems is visible without opening it — otherwise the operator has
 * to click through every run to find the one that went wrong.
 */
export function summarizeRuns(runs: RunRow[], issues: IssueRow[] = []): RunSummary[] {
	const counts = new Map<number, number>();
	for (const issue of issues) counts.set(issue.run_id, (counts.get(issue.run_id) ?? 0) + 1);

	return orderRuns(runs).map((row) => ({
		id: row.id,
		hostId: row.host_id,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		seconds:
			row.finished_at !== null && Number.isFinite(Date.parse(row.finished_at))
				? Math.round((Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000)
				: null,
		outcome: runOutcome(row),
		stored: row.stored_count,
		skipped: row.skipped_count,
		failed: row.failed_count,
		bytesStored: row.bytes_stored,
		issueCount: counts.get(row.id) ?? 0,
	}));
}

/** Issues for one machine, newest first, so a machine's history can be read on its own. */
export function issuesForHost(issues: IssueRow[], hostId: string): IssueDetail[] {
	return issues
		.filter((issue) => issue.host_id === hostId)
		.sort((a, b) => {
			if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
			return b.id - a.id;
		})
		.map(toIssueDetail);
}
