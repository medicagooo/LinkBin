import { describe, expect, it } from 'vitest';
import { planAdmission, type BudgetObject } from '../src/budget';

/**
 * The storage budget: what fits, what is refused, and what gets reclaimed to make room.
 *
 * Two decisions live here and both are the kind that go wrong quietly. Admitting too much means the
 * ceiling is exceeded while the interface still looks healthy; evicting too eagerly means deleting files
 * the operator wanted and only noticing later.
 *
 * The figure everything is measured against is **what the bucket holds**, not what is live. Superseded
 * and soft-deleted objects still occupy storage and are still charged, so a total that counted only live
 * objects could pass the ceiling while the billable size was already over it.
 */

const GB = 1024 * 1024 * 1024;

const obj = (id: number, size: number, over: Partial<BudgetObject> = {}): BudgetObject => ({
	id,
	size,
	important: false,
	superseded: false,
	deleted: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	...over,
});

const budget = (over: Partial<Parameters<typeof planAdmission>[0]> = {}) => ({
	ceilingBytes: 10 * GB,
	newSize: 100,
	objects: [] as BudgetObject[],
	...over,
});

describe('measuring what is held', () => {
	it('counts live objects', () => {
		const plan = planAdmission(budget({ objects: [obj(1, 1000), obj(2, 2000)] }));
		expect(plan.heldBytes).toBe(3000);
	});

	it('counts superseded and deleted objects too, because they are still charged', () => {
		// The failure this prevents: a total counting only live objects reports plenty of room while the
		// bucket is already at the ceiling.
		const plan = planAdmission(
			budget({
				objects: [obj(1, 1000), obj(2, 2000, { superseded: true }), obj(3, 4000, { deleted: true })],
			}),
		);
		expect(plan.heldBytes).toBe(7000);
	});

	it('reports the share of the budget used', () => {
		const plan = planAdmission(budget({ ceilingBytes: 1000, objects: [obj(1, 250)] }));
		expect(plan.usedFraction).toBeCloseTo(0.25, 5);
	});

	it('does not divide by zero when no ceiling is set', () => {
		const plan = planAdmission(budget({ ceilingBytes: 0, objects: [obj(1, 250)] }));
		expect(Number.isFinite(plan.usedFraction)).toBe(true);
	});
});

describe('admitting a new file', () => {
	it('admits a file that fits', () => {
		const plan = planAdmission(budget({ ceilingBytes: 1000, objects: [obj(1, 500)], newSize: 400 }));
		expect(plan.admitted).toBe(true);
		expect(plan.evict).toEqual([]);
	});

	it('admits a file that exactly reaches the ceiling', () => {
		// Exactly at the ceiling is not over it. Refusing here would make the stated limit a lie.
		//
		// The store is deliberately NOT already full: with slack present, reaching the ceiling exactly takes
		// the "it fits" branch, which is what is under test. A full store would instead go through the reclaim
		// path, where the boundary never matters.
		//
		// Noted for whoever mutation-tests this next: changing that comparison from `<=` to `<` is
		// behaviour-preserving and cannot be caught here. It falls through to the reclaim path, which needs to
		// free zero bytes and therefore also admits the file, and a later guard returns the same answer. The
		// redundant guard exists so that the harmful version of this mistake — evicting something in order to
		// free zero bytes — cannot happen silently; that property is what the assertions below pin down.
		const plan = planAdmission(budget({ ceilingBytes: 1000, objects: [obj(1, 600)], newSize: 400 }));
		expect(plan.admitted).toBe(true);
		expect(plan.evict, 'nothing needs reclaiming when the file lands exactly on the ceiling').toEqual([]);
		expect(plan.freedBytes).toBe(0);
	});

	it('refuses a file one byte over, and says capacity is the reason', () => {
		const plan = planAdmission(budget({ ceilingBytes: 1000, objects: [obj(1, 600, { important: true })], newSize: 401 }));
		expect(plan.admitted).toBe(false);
		expect(plan.reason).toBe('capacity');
		expect(plan.problem).toMatch(/space|budget|capacity/i);
	});

	it('makes room by evicting rather than refusing, when there is something evictable', () => {
		const plan = planAdmission(
			budget({ ceilingBytes: 1000, objects: [obj(1, 700, { createdAt: '2026-01-01T00:00:00.000Z' })], newSize: 400 }),
		);
		expect(plan.admitted).toBe(true);
		expect(plan.evict.map((o) => o.id)).toEqual([1]);
		expect(plan.freedBytes).toBe(700);
	});

	it('evicts the oldest first', () => {
		const plan = planAdmission(
			budget({
				ceilingBytes: 1000,
				newSize: 300,
				objects: [
					obj(1, 300, { createdAt: '2026-03-01T00:00:00.000Z' }),
					obj(2, 300, { createdAt: '2026-01-01T00:00:00.000Z' }),
					obj(3, 300, { createdAt: '2026-02-01T00:00:00.000Z' }),
				],
			}),
		);
		// 900 held + 300 new = 1200, so 200 must be freed; the oldest alone covers it.
		expect(plan.admitted).toBe(true);
		expect(plan.evict.map((o) => o.id)).toEqual([2]);
	});

	it('evicts only as many as needed, oldest first', () => {
		const plan = planAdmission(
			budget({
				ceilingBytes: 1000,
				newSize: 500,
				objects: [
					obj(1, 200, { createdAt: '2026-01-01T00:00:00.000Z' }),
					obj(2, 200, { createdAt: '2026-02-01T00:00:00.000Z' }),
					obj(3, 200, { createdAt: '2026-03-01T00:00:00.000Z' }),
					obj(4, 300, { createdAt: '2026-04-01T00:00:00.000Z' }),
				],
			}),
		);
		// Held 900 + 500 = 1400, need to free 400: the two oldest give exactly that and stop.
		expect(plan.freedBytes).toBeGreaterThanOrEqual(400);
		expect(plan.evict.map((o) => o.id)).toEqual([1, 2]);
	});

	it('breaks a tie on age deterministically, so eviction is not arbitrary', () => {
		const same = '2026-01-01T00:00:00.000Z';
		const plan = planAdmission(
			budget({ ceilingBytes: 1000, newSize: 500, objects: [obj(7, 300, { createdAt: same }), obj(3, 400, { createdAt: same })] }),
		);
		// Ordered by id when the timestamps match, so the same input always evicts the same object.
		expect(plan.evict.map((o) => o.id)).toEqual([3]);
	});
});

describe('an important object', () => {
	it('is never evicted, even when it is the oldest', () => {
		// Ceiling 1000. Held 600 (protected, oldest) + 400 (unprotected) = 1000; the new 400 needs 400
		// freed, which the unprotected object supplies exactly. The oldest object is the protected one, so
		// an implementation that simply took the oldest would take the wrong one.
		const plan = planAdmission(
			budget({
				ceilingBytes: 1000,
				newSize: 400,
				objects: [
					obj(1, 600, { important: true, createdAt: '2026-01-01T00:00:00.000Z' }),
					obj(2, 400, { createdAt: '2026-02-01T00:00:00.000Z' }),
				],
			}),
		);
		expect(plan.admitted).toBe(true);
		expect(plan.evict.map((o) => o.id)).toEqual([2]);
		expect(plan.evict.some((o) => o.important)).toBe(false);
	});

	it('is not evicted even when doing so is the only way to admit the new file', () => {
		// Both objects protected, and the new file does not fit: refusing is the only correct answer.
		const plan = planAdmission(
			budget({
				ceilingBytes: 1000,
				newSize: 400,
				objects: [obj(1, 600, { important: true }), obj(2, 400, { important: true })],
			}),
		);
		expect(plan.admitted).toBe(false);
		expect(plan.evict).toEqual([]);
		expect(plan.reason).toBe('capacity');
	});

	it('is excluded from eviction even when it is already superseded', () => {
		// Marking a file important protects it regardless of its state, which is what "never, under any
		// condition" has to mean to be worth anything.
		const plan = planAdmission(
			budget({ ceilingBytes: 1000, newSize: 400, objects: [obj(1, 700, { important: true, superseded: true })] }),
		);
		expect(plan.admitted).toBe(false);
		expect(plan.evict).toEqual([]);
	});
});

describe('when only important objects remain', () => {
	it('refuses rather than deleting anything', () => {
		const plan = planAdmission(
			budget({ ceilingBytes: 1000, newSize: 1, objects: [obj(1, 1000, { important: true })] }),
		);
		expect(plan.admitted).toBe(false);
		expect(plan.evict).toEqual([]);
		expect(plan.reason).toBe('capacity');
	});

	it('says the store is refusing new files, so the interface can say it too', () => {
		// Silence here reads as "nothing new to sync", which is the wrong conclusion and an expensive one:
		// the operator would look for a fault on the machine rather than at the budget.
		const plan = planAdmission(budget({ ceilingBytes: 1000, newSize: 1, objects: [obj(1, 1000, { important: true })] }));
		expect(plan.problem).toMatch(/important/i);
		expect(plan.problem).toMatch(/refus/i);
		expect(plan.saturatedByImportant).toBe(true);
	});

	it('is not reported as saturated when there is simply no room and nothing held', () => {
		const plan = planAdmission(budget({ ceilingBytes: 1000, newSize: 2000, objects: [] }));
		expect(plan.admitted).toBe(false);
		expect(plan.saturatedByImportant).toBe(false);
	});

	it('admits a smaller file that fits alongside the important ones', () => {
		const plan = planAdmission(budget({ ceilingBytes: 1000, newSize: 100, objects: [obj(1, 800, { important: true })] }));
		expect(plan.admitted).toBe(true);
		expect(plan.evict).toEqual([]);
	});
});

describe('marking a file important', () => {
	it('changes what would be evicted, immediately', () => {
		// The decision must follow the flag, not a cached total or a stale ordering.
		const before = planAdmission(
			budget({
				ceilingBytes: 1000,
				newSize: 400,
				objects: [obj(1, 600, { createdAt: '2026-01-01T00:00:00.000Z' }), obj(3, 200, { createdAt: '2026-03-01T00:00:00.000Z' })],
			}),
		);
		expect(before.evict.map((o) => o.id)).toEqual([1]);

		// The same store, with the oldest now protected. Held 600 protected + 400 unprotected; the new 400
		// must come from the unprotected one, which is the newer object.
		const after = planAdmission(
			budget({
				ceilingBytes: 1000,
				newSize: 400,
				objects: [
					obj(1, 600, { important: true, createdAt: '2026-01-01T00:00:00.000Z' }),
					obj(2, 400, { createdAt: '2026-02-01T00:00:00.000Z' }),
				],
			}),
		);
		expect(after.evict.map((o) => o.id)).toEqual([2]);
	});
});

describe('a file larger than the whole ceiling', () => {
	it('is refused without evicting everything to make room for it', () => {
		// Evicting the entire store to admit one file that still would not fit would destroy data for
		// nothing. The order of the checks matters: the size is judged before anything is reclaimed.
		const plan = planAdmission(
			budget({
				ceilingBytes: 1000,
				newSize: 5000,
				objects: [obj(1, 300, { createdAt: '2026-01-01T00:00:00.000Z' }), obj(2, 300)],
			}),
		);
		expect(plan.admitted).toBe(false);
		expect(plan.evict).toEqual([]);
		expect(plan.problem).toMatch(/larger than/i);
	});
});
