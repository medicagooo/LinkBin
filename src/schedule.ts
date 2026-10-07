/**
 * Scheduling: one machine's incremental scan per invocation, rotating fairly, resuming from a cursor.
 *
 * ## Why one machine and not all of them
 *
 * A single invocation has a wall-clock ceiling, and there are up to fifty machines. Sweeping all of them in
 * one call is not possible, so collection is a **rotation**: each invocation covers one machine, and the
 * next covers the next. That makes "how fresh is this file" a property of the rotation rather than of any
 * single run, which is why freshness is reported here rather than left to be inferred.
 *
 * ## The property that makes rotation work
 *
 * If the next machine were "the one whose last *success* is oldest", a machine that always fails would be
 * chosen every single time and the machines that work would never run. **Attempts** therefore order the
 * rotation, not successes — a failing machine goes to the back of the queue like any other, and is retried
 * when its turn comes round again.
 *
 * ## Why a skipped trigger is not an error
 *
 * Scheduled triggers are best-effort: a minute can be missed entirely, and nothing guarantees a run follows
 * the one before it. So no decision here depends on every scheduled minute having happened, and a cursor is
 * treated as a claim to be verified — checked against the machine it names — rather than as fact.
 *
 * ## Why the budget leaves room
 *
 * The platform kills an invocation at its ceiling **with no chance to record anything**. A run that stops on
 * its budget rather than before it has nothing to write, so the budget is a point to leave by, not a target
 * to reach.
 */

export type RunOutcome = 'succeeded' | 'failed' | 'unfinished';

export interface MachineState {
	id: string;
	enabled: boolean;
	/** When this machine was last attempted, whatever the outcome. This is what orders the rotation. */
	lastStartedAt: string | null;
	lastSucceededAt: string | null;
	lastOutcome: RunOutcome | null;
}

export interface RunCursor {
	hostId: string;
	/** Opaque position within one machine's scan. Never interpreted here, only carried. */
	position: string;
	startedAt: string;
}

export interface RunPlanInput {
	machines: MachineState[];
	/** The cursor a previous run left, if any. */
	cursor?: RunCursor | null;
	now: number;
	startedAt: number;
	budgetMs: number;
}

export type NoRunReason = 'nothing-to-do' | 'out-of-time';

export interface RunPlan {
	run: boolean;
	machineId?: string;
	/** Where to resume, or null to start from the beginning of the machine's scan. */
	resumeFrom?: string | null;
	reason?: NoRunReason;
	notes: string[];
}

/** Time that must remain before starting a machine, so the run has something to show for itself. */
const MINIMUM_USEFUL_MS = 30_000;

/**
 * The machine that should run next: the one attempted longest ago, ignoring disabled machines.
 *
 * Ordered by attempt rather than by success — see the note above about a failing machine starving the rest.
 * Ties break on id so two invocations cannot disagree and pick different machines.
 */
export function nextMachine(machines: MachineState[]): MachineState | null {
	const candidates = machines.filter((m) => m.enabled);
	if (candidates.length === 0) return null;

	return [...candidates].sort((a, b) => {
		// Never attempted sorts before everything: it has waited the longest by definition.
		if (a.lastStartedAt === null && b.lastStartedAt !== null) return -1;
		if (a.lastStartedAt !== null && b.lastStartedAt === null) return 1;
		if (a.lastStartedAt !== null && b.lastStartedAt !== null && a.lastStartedAt !== b.lastStartedAt) {
			return a.lastStartedAt < b.lastStartedAt ? -1 : 1;
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	})[0];
}

/**
 * Whether the run has reached the point it must leave by.
 *
 * Strictly: a run stops *at* its budget rather than being allowed to use it up, because the time after
 * stopping is what writing a cursor costs.
 */
export function shouldStop(input: Pick<RunPlanInput, 'startedAt' | 'budgetMs'>, now: number): boolean {
	return now - input.startedAt >= input.budgetMs;
}

/**
 * Reads a stored cursor, treating anything unreadable as absent.
 *
 * A half-written JSON value must not be mistaken for a position: the next run would then resume from
 * nonsense and skip files that were never scanned, which is silent data loss rather than a visible error.
 */
export function parseCursor(stored: string | null | undefined): RunCursor | null {
	if (!stored) return null;
	try {
		const parsed = JSON.parse(stored) as Partial<RunCursor>;
		if (typeof parsed?.hostId !== 'string' || typeof parsed?.position !== 'string' || typeof parsed?.startedAt !== 'string') {
			return null;
		}
		if (!parsed.hostId || !parsed.position) return null;
		return { hostId: parsed.hostId, position: parsed.position, startedAt: parsed.startedAt };
	} catch {
		return null;
	}
}

/** Moves a cursor forward, keeping the machine it belongs to. */
export function advanceCursor(cursor: RunCursor, position: string): RunCursor {
	return { ...cursor, position };
}

/**
 * Decides whether to run, on which machine, and from where.
 *
 * Returns a decision rather than performing anything, so the choice can be tested without a machine, and so
 * the caller can record the receipt that explains it.
 */
export function planRun(input: RunPlanInput): RunPlan {
	const notes: string[] = [];

	const chosen = nextMachine(input.machines);
	if (!chosen) {
		return { run: false, reason: 'nothing-to-do', notes: ['no enabled machine to collect'] };
	}

	const remaining = input.budgetMs - (input.now - input.startedAt);
	if (remaining < MINIMUM_USEFUL_MS) {
		// Starting now would open a connection, record nothing and stop — work to redo, plus a receipt that
		// says nothing. Declining is the honest answer.
		return {
			run: false,
			reason: 'out-of-time',
			notes: [`${Math.max(0, Math.round(remaining / 1000))}s left, too little to start a machine`],
		};
	}

	const cursor = input.cursor ?? null;
	let resumeFrom: string | null = null;

	if (cursor) {
		if (cursor.hostId === chosen.id) {
			resumeFrom = cursor.position;
			notes.push(`resuming ${chosen.id} from ${cursor.position}`);
		} else {
			// A cursor names a position on ONE machine. Applying it elsewhere would skip files that were never
			// scanned, so it is ignored — and said out loud, because silently starting over looks like the
			// cursor was never written.
			notes.push(`the stored cursor belongs to ${cursor.hostId}, not ${chosen.id}; starting this machine from the beginning`);
		}
	}

	return { run: true, machineId: chosen.id, resumeFrom, notes };
}

export interface FreshnessEntry {
	id: string;
	secondsSinceSuccess: number | null;
	/** True when this machine has never been collected successfully. */
	never: boolean;
	lastOutcome: RunOutcome | null;
}

export interface FreshnessReport extends Array<FreshnessEntry> {
	/** The worst known staleness, or null when some machine has never succeeded. */
	worstSeconds: number | null;
	neverCount: number;
}

/**
 * How stale each machine is, and the worst case.
 *
 * Reports the worst rather than an average, because an average hides the machine that is never collected and
 * that is the one worth knowing about. A machine that has never succeeded reports `null` rather than zero:
 * zero would read as "just now", which is the opposite of the truth.
 */
export function freshness(machines: MachineState[], now: number): FreshnessReport {
	const entries: FreshnessEntry[] = machines.map((machine) => {
		if (!machine.lastSucceededAt) {
			return { id: machine.id, secondsSinceSuccess: null, never: true, lastOutcome: machine.lastOutcome };
		}
		const at = Date.parse(machine.lastSucceededAt);
		return {
			id: machine.id,
			secondsSinceSuccess: Number.isFinite(at) ? Math.round((now - at) / 1000) : null,
			never: !Number.isFinite(at),
			lastOutcome: machine.lastOutcome,
		};
	});

	const report = entries as FreshnessReport;
	report.neverCount = entries.filter((e) => e.never).length;
	const known = entries.filter((e) => !e.never).map((e) => e.secondsSinceSuccess!);
	report.worstSeconds = report.neverCount > 0 ? null : known.length ? Math.max(...known) : null;
	return report;
}
