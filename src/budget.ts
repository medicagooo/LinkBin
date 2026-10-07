/**
 * The storage budget: admission control and what to reclaim.
 *
 * ## Why the total is not "live objects"
 *
 * The ceiling is a limit on what the bucket **holds**, and superseded and soft-deleted objects still
 * occupy it and are still charged. A total that counted only live objects would report a healthy store
 * while the real figure was already over the ceiling — and the failure would arrive as a storage bill or a
 * hard write error rather than as a decision anyone made. Everything held is therefore counted.
 *
 * ## Nothing is deleted to make room unless it is both unprotected and necessary
 *
 * Two rules, in this order, because the order is what makes them safe:
 *
 *   1. **A file larger than the whole ceiling is refused first.** Reclaiming the entire store to admit one
 *      file that still would not fit destroys data for nothing.
 *   2. **An important object is never evicted, under any condition** — including when doing so is the only
 *      way to admit the incoming file, and including when it is already superseded. The consequence is
 *      deliberate: when only important objects remain and the budget is full, new files are **refused**,
 *      and that refusal is stated rather than silent. Doing nothing quietly would read as "nothing new to
 *      sync", which sends the operator looking for a fault on the machine instead of at the budget.
 *
 * ## Why this is a decision rather than an action
 *
 * `planAdmission` computes what should happen and touches nothing. That keeps the policy testable without
 * a database, and keeps the execution — deleting the record and the stored bytes together — somewhere it
 * can be made idempotent, which matters because this database has no transactions.
 */

export interface BudgetObject {
	id: number;
	size: number;
	important: boolean;
	/** True when a newer version replaced this one. It still occupies storage. */
	superseded: boolean;
	/** True when soft-deleted. It still occupies storage until the bytes are gone. */
	deleted: boolean;
	/**
	 * True when the bytes have actually been removed — evicted to make room.
	 *
	 * Distinct from `deleted`, and the distinction is load-bearing rather than tidy: a soft-deleted object still
	 * occupies storage and is still charged, while a reclaimed one occupies nothing. One bit cannot answer both,
	 * and the two answers are opposites.
	 */
	reclaimed?: boolean;
	createdAt: string;
}

export interface BudgetInput {
	ceilingBytes: number;
	/** The size of the file being considered for admission. */
	newSize: number;
	/** Everything the bucket holds, in any state. */
	objects: BudgetObject[];
}

export interface AdmissionPlan {
	admitted: boolean;
	/** Bytes the bucket currently holds, including superseded and deleted objects. */
	heldBytes: number;
	/** Share of the ceiling in use, for the interface. */
	usedFraction: number;
	/** Objects to evict, oldest first, to make room. Empty when nothing should be reclaimed. */
	evict: BudgetObject[];
	/** Bytes that evicting will free. */
	freedBytes: number;
	/** Why admission was refused. `capacity` covers both "no room" and "nothing may be reclaimed". */
	reason?: 'capacity';
	/** A sentence for the operator, not an error code. */
	problem?: string;
	/**
	 * True when the refusal is because only protected objects are left.
	 *
	 * The interface needs this distinctly: "the store is full of files you protected" is a different
	 * situation from "the store is full", and only the first is resolved by unmarking something.
	 */
	saturatedByImportant: boolean;
}

/** Oldest first. Ties break on id so the same input always produces the same decision. */
function oldestFirst(a: BudgetObject, b: BudgetObject): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return a.id - b.id;
}

/**
 * Decides whether a file can be admitted, and what must be reclaimed to fit it.
 *
 * Pure: it reads the objects it is given and returns a plan. Nothing is deleted here.
 */
export function planAdmission(input: BudgetInput): AdmissionPlan {
	// Two malformed inputs are neutralised here, both found by an adversarial audit, and both cheap to guard
	// because the alternative is arithmetic that is quietly wrong in the direction that loses data:
	//
	//   - **A repeated object id.** Listing one object twice inflated the total, so a plan could evict a real
	//     object that nothing needed evicting for — deleting data to make room that was already free.
	//   - **A negative size.** A stored size below zero subtracted from the total, so a file could be admitted
	//     into a bucket that then exceeded its ceiling. A size counts bytes; anything less than zero is not a
	//     size, and reading it as zero is the only option that cannot under-report what is held.
	//
	// Neither is reachable from the current caller — the join cannot duplicate a primary key, and nothing writes
	// sizes yet — which is exactly why they are worth guarding rather than documenting. The code that would make
	// them reachable is the ingest path, and it is not written.
	const seen = new Set<number>();
	const objects: BudgetObject[] = [];
	for (const object of input.objects) {
		if (seen.has(object.id)) continue;
		seen.add(object.id);

		// **An object whose bytes have been RECLAIMED is not held.**
		//
		// This is the distinction the whole field set turns on, and getting it wrong in either direction is a
		// real defect:
		//
		//   - A soft-deleted object still occupies storage. Its row carries `deleted_at` because something asked
		//     for it to go, but nothing has removed the bytes, so it is still charged. Counting only live objects
		//     would report room that does not exist.
		//   - A reclaimed object occupies nothing. Eviction removes the bytes and KEEPS the row, deliberately,
		//     because the row is what makes "this file existed and was removed to make room" answerable. Counting
		//     those meant the store reported itself full forever after the first reclaim: the space was freed and
		//     the figure never noticed.
		//
		// `reclaimed` is the flag that tells them apart. Without it there is one bit for two states, and the two
		// states want opposite answers.
		if (object.reclaimed) continue;

		objects.push(object.size < 0 ? { ...object, size: 0 } : object);
	}

	const heldBytes = objects.reduce((total, object) => total + object.size, 0);
	const usedFraction = input.ceilingBytes > 0 ? heldBytes / input.ceilingBytes : 0;

	const base = { heldBytes, usedFraction, evict: [] as BudgetObject[], freedBytes: 0, saturatedByImportant: false };

	// A ceiling of zero means no ceiling is configured, so nothing is refused on capacity.
	if (input.ceilingBytes <= 0) {
		return { ...base, admitted: true };
	}

	// Judge the size before reclaiming anything: see the note above about a file larger than the ceiling.
	if (input.newSize > input.ceilingBytes) {
		return {
			...base,
			admitted: false,
			reason: 'capacity',
			problem: `this file is ${input.newSize} bytes, larger than the whole ${input.ceilingBytes} byte budget, so no amount of reclaiming would make room for it`,
		};
	}

	if (heldBytes + input.newSize <= input.ceilingBytes) {
		// Fits as it stands, including landing exactly on the ceiling. Stated as its own branch rather than
		// left to the reclaim path below: that path also accepts this case, because it needs to free zero
		// bytes, but relying on that would make the boundary a coincidence of other comparisons rather than a
		// rule. It is spelled out here so the rule is readable and so a change to it is detectable.
		return { ...base, admitted: true };
	}

	// Room is needed. Only unprotected objects are candidates, in age order.
	const candidates = objects.filter((object) => !object.important).sort(oldestFirst);
	const needed = heldBytes + input.newSize - input.ceilingBytes;

	if (needed <= 0) {
		// Unreachable while the check above is present and correct. Kept as a guard so a later change there
		// cannot silently turn "this fits" into "evict something for no reason", which would delete files
		// while reporting success.
		return { ...base, admitted: true };
	}

	const evict: BudgetObject[] = [];
	let freedBytes = 0;
	for (const candidate of candidates) {
		if (freedBytes >= needed) break;
		evict.push(candidate);
		freedBytes += candidate.size;
	}

	if (freedBytes >= needed) {
		return { ...base, admitted: true, evict, freedBytes };
	}

	// Not enough reclaimable space. Everything protected stays, and the incoming file is refused.
	const protectedBytes = objects.filter((o) => o.important).reduce((total, o) => total + o.size, 0);
	const stillHeld = heldBytes - freedBytes;
	const saturatedByImportant = stillHeld > 0 && stillHeld <= protectedBytes;

	return {
		heldBytes,
		usedFraction,
		admitted: false,
		evict: [],
		freedBytes: 0,
		reason: 'capacity',
		saturatedByImportant,
		problem: saturatedByImportant
			? `the store is full and every remaining file is marked important, so nothing may be reclaimed; this file is refused rather than deleting one of them. Unmark a file, or raise the budget.`
			: `the store is full and there is not enough reclaimable space for this file; it is refused rather than deleting protected files.`,
	};
}
