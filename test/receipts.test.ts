import { describe, expect, it } from 'vitest';
import {
	clampReason,
	orderRuns,
	runDetail,
	runOutcome,
	summarizeRuns,
	MAX_REASON_LENGTH,
	type IssueRow,
	type RunRow,
} from '../src/receipts';

/**
 * Receipts: what a run did, and what went wrong.
 *
 * The properties that matter here are about honesty rather than features. A run that never finished must
 * not look like one that finished with nothing to do; a successful file must not appear as a problem, or
 * the list of problems stops being readable exactly when it is longest; and a large file skipped for its
 * size must be distinguishable from one that failed, because the first needs no investigation.
 */

const run = (over: Partial<RunRow> = {}): RunRow => ({
	id: 1,
	host_id: 'h1',
	state: 'finished',
	started_at: '2026-01-01T10:00:00.000Z',
	finished_at: '2026-01-01T10:02:00.000Z',
	stored_count: 3,
	skipped_count: 1,
	failed_count: 0,
	bytes_stored: 4096,
	...over,
});

const issue = (over: Partial<IssueRow> = {}): IssueRow => ({
	id: 1,
	run_id: 1,
	host_id: 'h1',
	path: '/var/log/app.log',
	kind: 'too_large',
	reason: 'the file is larger than the limit',
	size_bytes: 200 * 1024 * 1024,
	created_at: '2026-01-01T10:01:00.000Z',
	...over,
});

describe('describing a run', () => {
	it('reports its counts and its duration', () => {
		const detail = runDetail(run());
		expect(detail.stored).toBe(3);
		expect(detail.skipped).toBe(1);
		expect(detail.failed).toBe(0);
		expect(detail.seconds).toBe(120);
	});

	it('does not invent a duration for a run that never finished', () => {
		// A missing end time is not a zero-second run. Reporting one would make an interrupted run look like
		// one that completed instantly, which is the opposite of what happened.
		const detail = runDetail(run({ state: 'running', finished_at: null }));
		expect(detail.seconds).toBeNull();
		expect(detail.outcome).toBe('unfinished');
	});

	it('calls a finished run with no problems a success', () => {
		expect(runOutcome(run({ skipped_count: 0 }))).toBe('success');
	});

	it('calls a finished run with problems a partial failure, not a success', () => {
		expect(runOutcome(run({ failed_count: 2 }))).toBe('problems');
	});

	it('treats skipped files as worth reporting even when nothing failed', () => {
		// A skip is a decision the operator may need to revisit, so it must not be hidden behind the word
		// "success".
		expect(runOutcome(run({ skipped_count: 1, failed_count: 0 }))).toBe('problems');
	});

	it('describes a run that stored nothing and had nothing to do', () => {
		const detail = runDetail(run({ stored_count: 0, skipped_count: 0, failed_count: 0 }));
		expect(detail.outcome).toBe('success');
		expect(detail.stored).toBe(0);
	});
});

describe('listing runs', () => {
	it('lists newest first, because the latest run is what is being asked about', () => {
		const ordered = orderRuns([
			run({ id: 1, started_at: '2026-01-01T10:00:00.000Z' }),
			run({ id: 3, started_at: '2026-01-03T10:00:00.000Z' }),
			run({ id: 2, started_at: '2026-01-02T10:00:00.000Z' }),
		]);
		expect(ordered.map((r) => r.id)).toEqual([3, 2, 1]);
	});

	it('breaks a tie deterministically, so the order does not depend on the database', () => {
		const same = '2026-01-01T10:00:00.000Z';
		const ordered = orderRuns([run({ id: 5, started_at: same }), run({ id: 2, started_at: same })]);
		expect(ordered.map((r) => r.id)).toEqual([5, 2]);
	});

	it('summarises each run with its issue count, so a run with problems is visible without opening it', () => {
		const summaries = summarizeRuns([run({ id: 1 }), run({ id: 2, failed_count: 2 })], [
			issue({ run_id: 2 }),
			issue({ run_id: 2, id: 2 }),
		]);
		expect(summaries.length).toBe(2);
		expect(summaries.find((s) => s.id === 1)!.issueCount).toBe(0);
		expect(summaries.find((s) => s.id === 2)!.issueCount).toBe(2);
	});

	it('does not lose a run that has no issues', () => {
		const summaries = summarizeRuns([run({ id: 9 })], []);
		expect(summaries.length).toBe(1);
		expect(summaries[0].issueCount).toBe(0);
	});

	it('orders the summaries too, not just the input', () => {
		const summaries = summarizeRuns(
			[run({ id: 1, started_at: '2026-01-01T00:00:00.000Z' }), run({ id: 2, started_at: '2026-01-05T00:00:00.000Z' })],
			[],
		);
		expect(summaries.map((s) => s.id)).toEqual([2, 1]);
	});
});

describe('the machine\u2019s own words', () => {
	it('are kept, so a permission problem can be diagnosed without guessing', () => {
		const detail = runDetail(run(), [issue({ kind: 'error', reason: 'Permission denied (publickey).' })]);
		expect(detail.issues[0].reason).toBe('Permission denied (publickey).');
	});

	it('are kept even when they are long, up to the stored limit', () => {
		const long = 'x'.repeat(2000);
		expect(clampReason(long).length).toBe(2000);
	});

	it('are truncated rather than allowed to grow a row without bound', () => {
		// Stored rows have a hard size limit, and a machine can emit an arbitrarily long message. Truncating
		// keeps the beginning, which is where the useful part is, and records that it was cut so nobody
		// wonders whether the message really ended there.
		const huge = 'y'.repeat(100_000);
		const clamped = clampReason(huge);
		expect(clamped.length).toBeLessThanOrEqual(MAX_REASON_LENGTH + 20);
		expect(clamped).toMatch(/truncated/i);
		expect(clamped.startsWith('y')).toBe(true);
	});

	it('leaves a normal message exactly as it was', () => {
		expect(clampReason('No such file or directory')).toBe('No such file or directory');
	});
});

describe('a run\u2019s issues', () => {
	it('are counted by kind, so a pattern is visible at a glance', () => {
		const detail = runDetail(run(), [
			issue({ id: 1, kind: 'too_large' }),
			issue({ id: 2, kind: 'too_large' }),
			issue({ id: 3, kind: 'capacity' }),
		]);
		expect(detail.byKind.too_large).toBe(2);
		expect(detail.byKind.capacity).toBe(1);
		expect(detail.byKind.error).toBeUndefined();
	});

	it('separate a size skip from a failure, because only one needs investigating', () => {
		const skipped = issue({ kind: 'too_large', size_bytes: 200 * 1024 * 1024 });
		const failed = issue({ kind: 'error', reason: 'connection reset', size_bytes: null });
		const detail = runDetail(run(), [skipped, failed]);

		const sized = detail.issues.find((i) => i.kind === 'too_large')!;
		expect(sized.sizeBytes).toBe(200 * 1024 * 1024);
		expect(sized.deliberate).toBe(true);

		const broken = detail.issues.find((i) => i.kind === 'error')!;
		expect(broken.deliberate).toBe(false);
		expect(broken.sizeBytes).toBeNull();
	});

	it('mark a capacity refusal as deliberate, so a full store reads as a reason not as silence', () => {
		const detail = runDetail(run(), [issue({ kind: 'capacity', reason: 'the store is full' })]);
		expect(detail.issues[0].deliberate).toBe(true);
	});

	it('keep each issue with the machine it came from, so they can be filtered', () => {
		const detail = runDetail(run(), [issue({ host_id: 'h1' }), issue({ id: 2, host_id: 'h2' })]);
		expect(detail.issues.map((i) => i.hostId)).toEqual(['h1', 'h2']);
	});

	it('order deterministically within a run', () => {
		const detail = runDetail(run(), [
			issue({ id: 3, created_at: '2026-01-01T10:01:03.000Z' }),
			issue({ id: 1, created_at: '2026-01-01T10:01:01.000Z' }),
			issue({ id: 2, created_at: '2026-01-01T10:01:02.000Z' }),
		]);
		expect(detail.issues.map((i) => i.id)).toEqual([1, 2, 3]);
	});

	it('is an empty list for a run with no problems, not an absent one', () => {
		// The interface reads this directly; an absent list would render as nothing rather than as "none".
		expect(runDetail(run()).issues).toEqual([]);
	});
});
