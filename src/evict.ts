/**
 * Carrying out the retention policy: reclaiming stored bytes, and deciding what may be reclaimed.
 *
 * `budget.ts` computes what *should* happen and touches nothing — that split is deliberate, because a policy
 * that deletes as it decides cannot be tested without deleting. This module is the other half: it takes a plan
 * and performs it, and it owns the two decisions that only matter once something is actually being removed.
 *
 * ## Why the bytes go first and the record second
 *
 * Eviction has two irreversible-ish steps and D1 has no transactions, so an interruption between them is a real
 * possibility that has to be reasoned about rather than assumed away. The order is chosen so that being
 * interrupted leaves the **safe** state:
 *
 *   - Bytes deleted, record not yet marked: the row looks live but has nothing behind it. Browsing reports it
 *     as no longer stored, which is true, and the space really was reclaimed, which is the point.
 *   - Record marked first, bytes not deleted: the row says reclaimed while the bytes are still charged against
 *     the budget. The store would be full of space that nothing accounts for.
 *
 * The first is a visible inconsistency; the second is an invisible one that also loses capacity. Only one of
 * those is acceptable, and it is not the second.
 *
 * ## Why there is no partial-eviction mode
 *
 * Either the incoming file fits after reclaiming, or nothing is evicted. Freeing some space and then still
 * refusing would have deleted files for no benefit, and the operator would have lost data to a failed
 * operation. `planAdmission` answers "is there enough to reclaim" before anything is touched, and that answer
 * is what gates the deletions.
 */

import { planAdmission, type AdmissionPlan, type BudgetObject } from './budget';

/** The minimum an eviction needs from the runtime. Both are structural, so a test can pass a plain object. */
export interface EvictionPorts {
	/** Marks a row as no longer stored. Must be idempotent: running it twice is not an error. */
	markDeleted(objectId: number, at: string): Promise<void>;
	/** Removes the bytes. Must tolerate a key that is already absent. */
	deleteBytes(objectKey: string): Promise<void>;
	/** The stored key for an object id, or null when the row has gone. */
	objectKey(objectId: number): Promise<string | null>;
}

export interface EvictionOutcome {
	/** True when the incoming file now fits. */
	admitted: boolean;
	/** Ids whose bytes were removed. Empty whenever `admitted` is false. */
	evicted: number[];
	freedBytes: number;
	/** The policy's own explanation, passed through rather than re-worded here. */
	problem?: string;
	/** True when the only thing left is protected, which is the case the operator has to act on. */
	saturatedByImportant: boolean;
}

/**
 * Whether an object may be reclaimed, as a function of what is known about it.
 *
 * Split out from the plan so the rule can be asserted directly rather than inferred from a list of survivors.
 * The rule has no exceptions: an important object is never evicted, not when it is the oldest, not when it is
 * the only thing left, not when the alternative is refusing everything forever. Failing closed is the choice
 * this whole ticket is built around — silently deleting a file the operator protected is worse than refusing
 * new ones, because the refusal is visible and the deletion is not.
 */
export function mayEvict(object: BudgetObject): boolean {
	return !object.important;
}

/**
 * Reclaims the room a plan asked for, or declines without touching anything.
 *
 * `plan` is passed in rather than recomputed so the caller and this function cannot disagree about the same
 * input — the mistake `measureStorage` was written to avoid, where the number the operator sees and the number
 * the policy acts on drifted apart because each computed it independently.
 *
 * **`plan.admitted` does not mean "nothing to do".** `planAdmission` returns `admitted: true` TOGETHER WITH a
 * non-empty `evict` when the file fits only after reclaiming — "this fits, once you have taken those". Reading
 * `admitted` alone as "no work needed" made this function silently perform no eviction at all while reporting
 * success, which its own test caught. The question that decides whether there is work is `evict.length`.
 */
export async function evictForRoom(
	plan: AdmissionPlan,
	candidates: BudgetObject[],
	ports: EvictionPorts,
	at: string,
): Promise<EvictionOutcome> {
	// Refused for a reason other than capacity — too large for the ceiling, or a malformed size. Nothing to
	// reclaim and nothing to do.
	if (!plan.admitted && plan.reason !== 'capacity') {
		return {
			admitted: false,
			evicted: [],
			freedBytes: 0,
			saturatedByImportant: plan.saturatedByImportant,
			...(plan.problem === undefined ? {} : { problem: plan.problem }),
		};
	}

	// Nothing to reclaim, and the plan is content. A no-op reported as a success rather than treated as an
	// error: "it already fits" is not a failure the caller should have to distinguish.
	if (plan.evict.length === 0) {
		return { admitted: plan.admitted, evicted: [], freedBytes: 0, saturatedByImportant: plan.saturatedByImportant, ...(plan.problem === undefined ? {} : { problem: plan.problem }) };
	}

	// Re-checked here rather than trusted from the plan. The plan says what it would evict; this says what is
	// ALLOWED to be evicted, and if the two ever disagree the refusal wins. A `plan.evict` that somehow named a
	// protected object would be a policy bug, and refusing to act on it is the behaviour that keeps a bug from
	// deleting data.
	const byId = new Map(candidates.map((object) => [object.id, object]));
	const targets = plan.evict.filter((object) => {
		const known = byId.get(object.id);
		return known !== undefined && mayEvict(known);
	});

	// A target whose row cannot be found is dropped rather than guessed at: without the key its bytes cannot be
	// removed, and marking the record deleted while the bytes remain would be the invisible failure described
	// above. The plan is then re-checked below against what was actually freed.
	const evicted: number[] = [];
	let freedBytes = 0;

	for (const target of targets) {
		const key = await ports.objectKey(target.id);
		if (key === null) continue;

		await ports.deleteBytes(key);
		await ports.markDeleted(target.id, at);
		evicted.push(target.id);
		freedBytes += target.size;
	}

	if (evicted.length === 0) {
		return {
			admitted: false,
			evicted: [],
			freedBytes: 0,
			saturatedByImportant: plan.saturatedByImportant,
			problem:
				plan.problem ??
				'room was needed but nothing could be reclaimed, so the file is refused rather than deleting a protected one',
		};
	}

	// Reported as what was freed, not as what the plan intended to free. If a target turned out to be
	// unreachable the two differ, and the caller acting on the intention would believe there is more room than
	// there is.
	return { admitted: plan.admitted, evicted, freedBytes, saturatedByImportant: plan.saturatedByImportant };
}

/**
 * Plans a reclaim, performs it, and re-plans to confirm it worked.
 *
 * The re-plan is the part worth having: it answers "does the file fit NOW" from the same function that made the
 * original decision, using the state after the deletions. Checking the arithmetic by hand instead would be a
 * second implementation of the ceiling rule, and the two would drift.
 */
export async function makeRoomFor(input: {
	ceilingBytes: number;
	newSize: number;
	objects: BudgetObject[];
	ports: EvictionPorts;
	at: string;
}): Promise<EvictionOutcome> {
	const plan = planAdmission({ ceilingBytes: input.ceilingBytes, newSize: input.newSize, objects: input.objects });
	const outcome = await evictForRoom(plan, input.objects, input.ports, input.at);
	if (!outcome.admitted) return outcome;

	// Nothing was evicted, so the first plan already answered it and there is nothing to confirm.
	if (outcome.evicted.length === 0) return outcome;

	const gone = new Set(outcome.evicted);
	const remaining = input.objects.filter((object) => !gone.has(object.id));
	const after = planAdmission({ ceilingBytes: input.ceilingBytes, newSize: input.newSize, objects: remaining });

	if (after.admitted) return outcome;

	// The deletions happened and the file still does not fit. Reported honestly rather than as success: the
	// bytes are gone, so saying otherwise would leave the caller unable to explain where the space went.
	return {
		admitted: false,
		evicted: outcome.evicted,
		freedBytes: outcome.freedBytes,
		saturatedByImportant: after.saturatedByImportant,
		problem:
			after.problem ??
			`${outcome.freedBytes} bytes were reclaimed and the file still does not fit, so it is refused; the reclaimed space remains available`,
	};
}
