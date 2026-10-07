import { describe, expect, it } from 'vitest';
import { evictForRoom, makeRoomFor, mayEvict, type EvictionPorts } from '../src/evict';
import { planAdmission, type BudgetObject } from '../src/budget';

/**
 * Carrying out the retention policy.
 *
 * The policy itself — what should be reclaimed — is `budget.ts` and is tested there. What is tested here is
 * what happens when the plan is ACTED ON, and the properties that only exist at that point: the order of the
 * two steps, that a refusal touches nothing, and that a protected file survives.
 *
 * Every test drives a real plan rather than a hand-built one, because a plan is what the caller will have, and
 * a hand-built one could describe a state the policy never produces.
 */

function object(id: number, size: number, over: Partial<BudgetObject> = {}): BudgetObject {
	return {
		id,
		size,
		important: false,
		superseded: false,
		deleted: false,
		// Older ids are older files, which matches how the fixtures read.
		createdAt: `2026-01-${String(id).padStart(2, '0')}T00:00:00.000Z`,
		...over,
	};
}

/** Records what happened and in what order, and can be made to fail on demand. */
function portsFor(keys: Map<number, string>, log: string[] = [], failOn?: string): EvictionPorts {
	return {
		async objectKey(id) {
			log.push(`key:${id}`);
			return keys.get(id) ?? null;
		},
		async deleteBytes(key) {
			log.push(`bytes:${key}`);
			if (failOn === `bytes:${key}`) throw new Error('storage refused the delete');
		},
		async markDeleted(id, at) {
			log.push(`record:${id}@${at}`);
			if (failOn === `record:${id}`) throw new Error('the row could not be marked');
		},
	};
}

const AT = '2026-02-01T00:00:00.000Z';
const KEYS = new Map([
	[1, 'objects/h1/one'],
	[2, 'objects/h1/two'],
	[3, 'objects/h1/three'],
	[4, 'objects/h1/four'],
]);

describe('what may be reclaimed', () => {
	it('never allows a protected object, whatever else is true of it', () => {
		expect(mayEvict(object(1, 10, { important: true }))).toBe(false);
		// Including when it is superseded, deleted, the oldest, or the only candidate — the rule has no
		// exceptions, and this is asserted rather than left to the plan's ordering to imply.
		expect(mayEvict(object(1, 10, { important: true, superseded: true }))).toBe(false);
		expect(mayEvict(object(1, 10, { important: true, deleted: true }))).toBe(false);
		expect(mayEvict(object(1, 0, { important: true }))).toBe(false);
	});

	it('allows anything unprotected', () => {
		expect(mayEvict(object(1, 10))).toBe(true);
		expect(mayEvict(object(1, 10, { superseded: true }))).toBe(true);
	});
});

describe('reclaiming room', () => {
	it('evicts the oldest unprotected first, and only as many as needed', async () => {
		// Ceiling 1000, holding 900 across four files, and 400 more is coming. The oldest single file frees
		// enough — 900 - 300 + 400 = 1000, exactly the ceiling — so only that one may go.
		//
		// Note what the plan reports here: `admitted: true` TOGETHER WITH a non-empty `evict`. That combination
		// means "this fits, once you have taken those", and reading `admitted` alone as "no work needed" made
		// this module silently evict nothing while reporting success. The first version of this test asserted
		// `admitted` was false, which was simply wrong about the policy.
		const objects = [object(1, 300), object(2, 200), object(3, 200), object(4, 200)];
		const log: string[] = [];
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 400, objects });
		expect(plan.admitted, 'it fits after reclaiming, and the plan says so').toBe(true);
		expect(plan.evict.map((o) => o.id), 'which is why evict is non-empty').toEqual([1]);

		const outcome = await evictForRoom(plan, objects, portsFor(KEYS, log), AT);

		expect(outcome.admitted).toBe(true);
		expect(outcome.evicted, 'the oldest, and no more').toEqual([1]);
		expect(outcome.freedBytes).toBe(300);
		// Nothing younger was touched: reclaiming more than necessary loses data for no benefit.
		expect(outcome.evicted).not.toContain(2);
		expect(outcome.evicted).not.toContain(3);
	});

	it('removes the bytes before marking the record, so an interruption leaves the safe state', async () => {
		// The order is the whole reason this module exists separately from the policy. If the record were marked
		// first and the bytes delete then failed, the store would be full of space nothing accounts for.
		const objects = [object(1, 600), object(2, 300)];
		const log: string[] = [];
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 400, objects });

		await evictForRoom(plan, objects, portsFor(KEYS, log), AT);

		const bytesAt = log.indexOf('bytes:objects/h1/one');
		const recordAt = log.indexOf(`record:1@${AT}`);
		expect(bytesAt, 'the bytes were deleted').toBeGreaterThanOrEqual(0);
		expect(recordAt, 'the record was marked').toBeGreaterThanOrEqual(0);
		expect(bytesAt, 'bytes first, record second').toBeLessThan(recordAt);
	});

	it('touches nothing at all when the file already fits', async () => {
		const objects = [object(1, 100)];
		const log: string[] = [];
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 400, objects });
		expect(plan.admitted).toBe(true);

		const outcome = await evictForRoom(plan, objects, portsFor(KEYS, log), AT);

		expect(outcome.admitted).toBe(true);
		expect(outcome.evicted).toEqual([]);
		expect(log, 'no storage call was made').toEqual([]);
	});

	it('touches nothing when the file is larger than the whole ceiling', async () => {
		// No amount of reclaiming helps, so reclaiming would delete files for a file that is still refused.
		const objects = [object(1, 500)];
		const log: string[] = [];
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 2000, objects });

		const outcome = await evictForRoom(plan, objects, portsFor(KEYS, log), AT);

		expect(outcome.admitted).toBe(false);
		expect(outcome.evicted).toEqual([]);
		expect(log, 'a hopeless refusal must not delete anything').toEqual([]);
	});

	it('refuses without deleting when every remaining object is protected', async () => {
		// The case the whole ticket is built around. Refusing is visible and recoverable; deleting a protected
		// file is neither.
		const objects = [object(1, 600, { important: true }), object(2, 300, { important: true })];
		const log: string[] = [];
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 400, objects });

		const outcome = await evictForRoom(plan, objects, portsFor(KEYS, log), AT);

		expect(outcome.admitted).toBe(false);
		expect(outcome.evicted).toEqual([]);
		expect(outcome.saturatedByImportant, 'the operator has to be told this is why').toBe(true);
		expect(log, 'nothing was touched').toEqual([]);
	});

	it('takes the unprotected ones and stops when only protected ones remain', async () => {
		// A mixed store: 900 protected and 200 reclaimable, with 400 wanted, against a 1000 ceiling. Even taking
		// the reclaimable one leaves 900 + 400 = 1300, so this is a refusal — and the refusal must have left the
		// protected file alone, which is the property under test rather than the arithmetic.
		const objects = [object(1, 900, { important: true }), object(2, 200)];
		const log: string[] = [];
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 400, objects });

		const outcome = await evictForRoom(plan, objects, portsFor(KEYS, log), AT);

		expect(outcome.admitted).toBe(false);
		expect(outcome.evicted, 'nothing was reclaimed, because reclaiming could not have helped').toEqual([]);
		expect(log.some((line) => line.includes('record:1')), 'the protected record was never marked').toBe(false);
	});

	it('refuses to act on a plan that names a protected object', async () => {
		// A hand-built plan naming a protected object is a policy bug, not a state the policy can produce. The
		// refusal is the behaviour that keeps such a bug from deleting data, so it is asserted directly.
		const objects = [object(1, 600, { important: true })];
		const log: string[] = [];
		const bogus = {
			admitted: false,
			heldBytes: 600,
			usedFraction: 0.6,
			evict: [objects[0]],
			freedBytes: 600,
			saturatedByImportant: false,
			reason: 'capacity' as const,
		};

		const outcome = await evictForRoom(bogus, objects, portsFor(KEYS, log), AT);

		expect(outcome.admitted).toBe(false);
		expect(outcome.evicted).toEqual([]);
		expect(log).toEqual([]);
	});

	it('drops a target whose row cannot be found rather than marking it blind', async () => {
		// Without the key the bytes cannot be removed, and marking the record while the bytes remain is the
		// invisible failure: capacity charged against a budget that believes it was freed.
		//
		// The plan has to name BOTH objects for this to test anything, so the shortfall is made large enough:
		// 1300 held against a 1000 ceiling with 400 wanted needs 700 freed, which takes both oldest files. An
		// earlier version of this test used two files and the plan named only the first, so the assertion below
		// could not have passed however the code behaved.
		const objects = [object(1, 600), object(2, 300), object(3, 400)];
		const partial = new Map([
			[2, 'objects/h1/two'],
			[3, 'objects/h1/three'],
		]);
		const log: string[] = [];
		const plan = planAdmission({ ceilingBytes: 1000, newSize: 400, objects });
		expect(plan.evict.map((o) => o.id), 'the plan names both oldest').toEqual([1, 2]);

		const outcome = await evictForRoom(plan, objects, portsFor(partial, log), AT);

		// Object 1 is unreachable and is dropped; object 2 was reachable and was taken. Reporting the plan's
		// intention as if it had happened would have the caller believe 600 more bytes were free than really are.
		expect(outcome.evicted, 'only the reachable one').toEqual([2]);
		expect(outcome.freedBytes, 'what was actually freed, not what was intended').toBe(300);
		expect(log.some((line) => line.startsWith('record:1')), 'the unreachable row was not marked deleted').toBe(false);
	});
});

describe('planning, reclaiming and confirming', () => {
	it('reports what was actually freed, and confirms the file now fits', async () => {
		const objects = [object(1, 600), object(2, 300)];
		const outcome = await makeRoomFor({
			ceilingBytes: 1000,
			newSize: 400,
			objects,
			ports: portsFor(KEYS),
			at: AT,
		});

		expect(outcome.admitted).toBe(true);
		// 900 held + 400 wanted = 1300, so 300 must be freed: the oldest file is exactly enough.
		expect(outcome.freedBytes).toBe(600);
		expect(outcome.evicted).toEqual([1]);
	});

	it('re-checks the fit against what remains rather than trusting the plan', async () => {
		// Here the plan's arithmetic is not the question: the question is whether the state AFTER the deletions
		// fits. Driving it through the same function that made the original decision is what keeps one ceiling
		// rule rather than two that drift.
		const objects = [object(1, 200), object(2, 200), object(3, 200), object(4, 200)];
		const outcome = await makeRoomFor({
			ceilingBytes: 1000,
			newSize: 300,
			objects,
			ports: portsFor(KEYS),
			at: AT,
		});

		expect(outcome.admitted).toBe(true);
		// 800 + 300 = 1100, so 100 must be freed: the oldest single file suffices.
		expect(outcome.freedBytes).toBeGreaterThanOrEqual(100);
		expect(800 - outcome.freedBytes + 300).toBeLessThanOrEqual(1000);
	});

	it('does not touch storage when the file fits as it stands', async () => {
		const log: string[] = [];
		const outcome = await makeRoomFor({
			ceilingBytes: 1000,
			newSize: 100,
			objects: [object(1, 100)],
			ports: portsFor(KEYS, log),
			at: AT,
		});
		expect(outcome.admitted).toBe(true);
		expect(log).toEqual([]);
	});

	it('handles a store that is exactly at the ceiling', async () => {
		// One byte more than the ceiling allows must reclaim; the boundary is where an off-by-one would live.
		const atCeiling = [object(1, 1000)];
		const exact = await makeRoomFor({ ceilingBytes: 1000, newSize: 0, objects: atCeiling, ports: portsFor(KEYS), at: AT });
		expect(exact.admitted).toBe(true);
		expect(exact.evicted, 'a zero-byte file at the ceiling needs nothing reclaimed').toEqual([]);

		const over = await makeRoomFor({ ceilingBytes: 1000, newSize: 1, objects: atCeiling, ports: portsFor(KEYS), at: AT });
		expect(over.admitted, 'one byte over needs room').toBe(true);
		expect(over.evicted).toEqual([1]);
	});

	it('keeps the protected file when the only other one is smaller than the shortfall', async () => {
		const objects = [object(1, 900, { important: true }), object(2, 50)];
		const outcome = await makeRoomFor({
			ceilingBytes: 1000,
			newSize: 100,
			objects,
			ports: portsFor(KEYS),
			at: AT,
		});

		// 950 held + 100 = 1050. Evicting the 50 leaves 900 + 100 = 1000, which fits exactly. So this IS
		// admitted — and the point is that the protected 900 was never a candidate.
		expect(outcome.admitted).toBe(true);
		expect(outcome.evicted).toEqual([2]);
	});
});
