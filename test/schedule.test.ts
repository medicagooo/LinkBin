import { describe, expect, it } from 'vitest';
import {
	freshness,
	nextMachine,
	parseCursor,
	planRun,
	shouldStop,
	advanceCursor,
	type MachineState,
	type RunPlanInput,
} from '../src/schedule';

/**
 * Scheduling one machine's incremental scan, and picking up where the last one stopped.
 *
 * ## Why the same machine runs and runs
 *
 * One invocation covers one machine, so "collect everything" is a rotation rather than a loop. The property
 * that matters is that a slow machine cannot starve the others: if the choice were "the machine with the
 * oldest successful collection", a machine that always times out would be chosen every time and nothing else
 * would ever run.
 *
 * ## Why a skipped minute is not an error
 *
 * Scheduled triggers are best-effort: a minute can be skipped entirely. Nothing here may assume that every
 * scheduled minute happened, because the first thing that assumption breaks is the cursor — a run that
 * believes it follows another will resume from a position nothing wrote.
 */

/**
 * A machine's state as the database would actually hold it.
 *
 * `lastStartedAt` and `lastSucceededAt` are given together, because in production a machine that has been
 * collected has necessarily been attempted: a success implies a start. Leaving `lastStartedAt` null while
 * setting `lastSucceededAt` describes a state that cannot occur, and it silently changes which machine the
 * rotation picks — `null` sorts first as "never attempted".
 */
const machine = (over: Partial<MachineState> = {}): MachineState => ({
	id: 'h1',
	enabled: true,
	lastStartedAt: null,
	lastSucceededAt: null,
	lastOutcome: null,
	...over,
});

/** A machine that was both attempted and collected, at the same moment. */
const collected = (id: string, at: string, over: Partial<MachineState> = {}): MachineState =>
	machine({ id, lastStartedAt: at, lastSucceededAt: at, lastOutcome: 'succeeded', ...over });

const plan = (over: Partial<RunPlanInput> = {}): RunPlanInput => ({
	machines: [],
	now: Date.parse('2026-06-01T12:00:00.000Z'),
	budgetMs: 10 * 60 * 1000,
	startedAt: Date.parse('2026-06-01T12:00:00.000Z'),
	...over,
});

describe('choosing which machine runs next', () => {
	it('picks the one that has never been collected', () => {
		const chosen = nextMachine([collected('h1', '2026-06-01T11:00:00.000Z'), machine({ id: 'h2' })]);
		expect(chosen!.id).toBe('h2');
	});

	it('picks the least recently attempted when all have been', () => {
		const chosen = nextMachine([
			collected('h1', '2026-06-01T11:30:00.000Z'),
			collected('h2', '2026-06-01T11:00:00.000Z'),
			collected('h3', '2026-06-01T11:45:00.000Z'),
		]);
		expect(chosen!.id).toBe('h2');
	});

	it('does not let a machine that keeps failing starve the others', () => {
		// The property the whole rotation exists for. h1 was attempted most recently and failed, so it must
		// NOT be chosen again just because it has never succeeded — otherwise the machines that work never run.
		const chosen = nextMachine([
			machine({ id: 'h1', lastStartedAt: '2026-06-01T11:59:00.000Z', lastOutcome: 'failed' }),
			machine({ id: 'h2', lastStartedAt: '2026-06-01T10:00:00.000Z', lastSucceededAt: '2026-06-01T10:00:00.000Z' }),
		]);
		expect(chosen!.id).toBe('h2');
	});

	it('still retries a failing machine when it is the only one, so a transient fault recovers', () => {
		const chosen = nextMachine([machine({ id: 'h1', lastStartedAt: '2026-06-01T11:59:00.000Z', lastOutcome: 'failed' })]);
		expect(chosen!.id).toBe('h1');
	});

	it('ignores a disabled machine entirely', () => {
		const chosen = nextMachine([machine({ id: 'h1', enabled: false }), machine({ id: 'h2' })]);
		expect(chosen!.id).toBe('h2');
	});

	it('returns nothing when there is no machine to run, rather than throwing', () => {
		// An empty deployment is a normal state, not an error.
		expect(nextMachine([])).toBeNull();
		expect(nextMachine([machine({ enabled: false })])).toBeNull();
	});

	it('is deterministic when two machines are equally stale', () => {
		// Otherwise two invocations could disagree, and the same machine could be chosen twice while another
		// is never reached.
		const same = '2026-06-01T11:00:00.000Z';
		const chosen = nextMachine([machine({ id: 'h9', lastSucceededAt: same }), machine({ id: 'h3', lastSucceededAt: same })]);
		expect(chosen!.id).toBe('h3');
	});
});

describe('the wall-clock budget', () => {
	it('stops before the platform ceiling rather than at it', () => {
		// The platform kills an invocation at its ceiling with no chance to record anything, so the run has to
		// leave early enough to write its cursor. A budget equal to the ceiling would be a budget that is
		// never honoured.
		const input = plan({ budgetMs: 10 * 60 * 1000 });
		expect(shouldStop(input, input.startedAt + 10 * 60 * 1000)).toBe(true);
		expect(shouldStop(input, input.startedAt + 9 * 60 * 1000)).toBe(false);
	});

	it('has left room to write the cursor when it stops', () => {
		// Expressed as: the run stops strictly before its budget, not exactly on it.
		const input = plan({ budgetMs: 60_000 });
		expect(shouldStop(input, input.startedAt + 59_999)).toBe(false);
		expect(shouldStop(input, input.startedAt + 60_000)).toBe(true);
	});

	it('does not stop when there is time left', () => {
		const input = plan({ budgetMs: 60_000 });
		expect(shouldStop(input, input.startedAt + 1000)).toBe(false);
	});
});

describe('planning a run', () => {
	it('names the machine it will cover', () => {
		const result = planRun(plan({ machines: [machine({ id: 'web-01' })] }));
		expect(result.run).toBe(true);
		expect(result.machineId).toBe('web-01');
	});

	it('declines to run when there is nothing to collect, saying so rather than failing', () => {
		const result = planRun(plan({ machines: [] }));
		expect(result.run).toBe(false);
		expect(result.reason).toBe('nothing-to-do');
	});

	it('resumes from the cursor the previous run left', () => {
		const result = planRun(
			plan({
				machines: [machine({ id: 'h1' })],
				cursor: { hostId: 'h1', position: 'dir:/var/log', startedAt: '2026-06-01T11:00:00.000Z' },
			}),
		);
		expect(result.run).toBe(true);
		expect(result.resumeFrom).toBe('dir:/var/log');
	});

	it('does not resume from another machine\u2019s cursor', () => {
		// A cursor names a position on one machine. Applying it to a different one would skip files that were
		// never scanned, which is a silent data loss rather than an error.
		const result = planRun(
			plan({
				machines: [machine({ id: 'h2' })],
				cursor: { hostId: 'h1', position: 'dir:/var/log', startedAt: '2026-06-01T11:00:00.000Z' },
			}),
		);
		expect(result.run).toBe(true);
		expect(result.resumeFrom).toBeNull();
		// And it says the cursor was not usable, rather than silently starting fresh.
		expect(result.notes.join(' ')).toMatch(/cursor/i);
	});

	it('starts fresh when there is no cursor', () => {
		const result = planRun(plan({ machines: [machine({ id: 'h1' })] }));
		expect(result.resumeFrom).toBeNull();
	});

	it('declines to start a new machine when there is no time left to finish anything', () => {
		// Beginning a machine with a second of budget produces a run that opens a connection, records nothing
		// and stops — work that has to be redone, plus a needless receipt.
		const result = planRun(
			plan({
				machines: [machine({ id: 'h1' })],
				budgetMs: 1000,
				startedAt: Date.parse('2026-06-01T12:00:00.000Z'),
				now: Date.parse('2026-06-01T12:00:01.000Z'),
			}),
		);
		expect(result.run).toBe(false);
		expect(result.reason).toBe('out-of-time');
	});
});

describe('the cursor', () => {
	it('records the machine and the position reached', () => {
		const cursor = advanceCursor({ hostId: 'h1', position: 'file:3', startedAt: '2026-06-01T12:00:00.000Z' }, 'file:7');
		expect(cursor).toEqual({ hostId: 'h1', position: 'file:7', startedAt: '2026-06-01T12:00:00.000Z' });
	});

	it('keeps the machine, so a cursor cannot be applied elsewhere', () => {
		const cursor = advanceCursor({ hostId: 'h1', position: 'file:3', startedAt: '2026-06-01T12:00:00.000Z' }, 'file:7');
		expect(cursor!.hostId).toBe('h1');
	});

	it('is a value that survives being stored as JSON, since that is how it is kept', () => {
		const cursor = { hostId: 'h1', position: 'dir:/var/log', startedAt: '2026-06-01T12:00:00.000Z' };
		expect(JSON.parse(JSON.stringify(cursor))).toEqual(cursor);
	});

	it('treats a corrupt stored cursor as no cursor rather than as a position', () => {
		// A half-written JSON value must not be read as a position, or the next run resumes from nonsense.
		expect(parseCursor('not json at all')).toBeNull();
		expect(parseCursor('{"hostId":')).toBeNull();
		expect(parseCursor(null)).toBeNull();
		expect(parseCursor('{}')).toBeNull();
	});

	it('reads back a cursor it wrote', () => {
		const cursor = { hostId: 'h1', position: 'file:7', startedAt: '2026-06-01T12:00:00.000Z' };
		expect(parseCursor(JSON.stringify(cursor))).toEqual(cursor);
	});
});

describe('freshness, so the target can be checked rather than assumed', () => {
	it('reports how long ago each machine last succeeded', () => {
		const now = Date.parse('2026-06-01T12:00:00.000Z');
		const report = freshness(
			[
				machine({ id: 'h1', lastSucceededAt: '2026-06-01T11:30:00.000Z' }),
				machine({ id: 'h2', lastSucceededAt: '2026-06-01T11:00:00.000Z' }),
			],
			now,
		);
		expect(report.find((r) => r.id === 'h1')!.secondsSinceSuccess).toBe(1800);
		expect(report.find((r) => r.id === 'h2')!.secondsSinceSuccess).toBe(3600);
	});

	it('reports a machine that has never succeeded as never, not as zero seconds', () => {
		// Zero would read as "just now", which is the opposite of the truth.
		const report = freshness([machine({ id: 'h1' })], Date.parse('2026-06-01T12:00:00.000Z'));
		expect(report[0].secondsSinceSuccess).toBeNull();
		expect(report[0].never).toBe(true);
	});

	it('reports the worst case, which is the number the target is about', () => {
		// An average hides the machine that is never collected, and that is the one worth knowing about.
		const now = Date.parse('2026-06-01T12:00:00.000Z');
		const report = freshness(
			[
				machine({ id: 'h1', lastSucceededAt: '2026-06-01T11:59:00.000Z' }),
				machine({ id: 'h2', lastSucceededAt: '2026-06-01T10:00:00.000Z' }),
				machine({ id: 'h3' }),
			],
			now,
		);
		expect(report.worstSeconds).toBeNull(); // unknown, because one has never succeeded
		expect(report.neverCount).toBe(1);
	});

	it('reports the worst known staleness when every machine has succeeded', () => {
		const now = Date.parse('2026-06-01T12:00:00.000Z');
		const report = freshness(
			[
				machine({ id: 'h1', lastSucceededAt: '2026-06-01T11:59:00.000Z' }),
				machine({ id: 'h2', lastSucceededAt: '2026-06-01T10:00:00.000Z' }),
			],
			now,
		);
		expect(report.worstSeconds).toBe(7200);
		expect(report.neverCount).toBe(0);
	});
});
