/**
 * Browsing and searching stored files.
 *
 * ## Why the statement is built here rather than in the route
 *
 * Two reasons, and both are about being able to check the result rather than hope.
 *
 * The first is injection. Every value in a browse request comes from a query string that anyone can write,
 * and a column name or an ORDER BY clause taken from a request and interpolated into SQL is the classic
 * form of it. **Parameterising values does not protect identifiers**, so sorts are looked up in a fixed
 * table below and anything unrecognised becomes the default. A test asserts that a sort value containing
 * `DROP TABLE` cannot reach the statement.
 *
 * The second is that filter semantics are decisions worth stating. A pattern containing a wildcard means
 * something different from one that does not: `"/var/log"` must find what is *under* that directory, because
 * typing a directory is the most likely thing anyone does, and an exact match would return nothing and make
 * the feature look broken. A search term is escaped, because otherwise searching for `100%` matches every
 * row and looks like the filter was ignored.
 *
 * ## Why the count is a second query
 *
 * A window function would return the total on every row, which is more data for the same answer. Two bounded
 * queries are cheaper here, and this module returns both so the interface can say how many there are without
 * a third round trip.
 */

export interface BrowseFilter {
	hostId?: string;
	/** A path, possibly with `*` wildcards. */
	pattern?: string;
	/** Free text matched against the whole path. */
	search?: string;
	/** Include superseded versions. Deleted files are never included. */
	includeSuperseded?: boolean;
	sort?: BrowseSort;
	limit?: number;
	/** How many matching rows to skip. See `buildObjectQuery` for why this is an offset and not a cursor. */
	offset?: number;
}

export type BrowseSort = 'newest' | 'oldest' | 'largest' | 'smallest' | 'path';

export interface ObjectRow {
	id: number;
	host_id: string;
	path: string;
	object_key: string;
	size_bytes: number;
	content_hash: string;
	mtime: number | null;
	superseded_by: number | null;
	deleted_at: string | null;
	created_at: string;
	important?: number;
}

/**
 * The sorts the interface offers, each with its tie-break.
 *
 * A **null-prototype object**, and that is load-bearing rather than stylistic. As a plain object literal this
 * lookup answered `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf` and `__proto__`
 * with inherited members of `Object.prototype`: `?sort=constructor` resolved to the `Object` function, the
 * template literal stringified its source into the statement, and the result was `ORDER BY o.function
 * Object() { [native code] }` — a syntax error rather than the documented fallback. An adversarial audit
 * found it, along with the fact that the error carried a stack trace to an anonymous caller.
 *
 * With no prototype there is nothing to inherit, so the lookup finds only the sorts listed here.
 *
 * The tie-break is not cosmetic either: rows sharing a timestamp come back in whatever order the database
 * chooses, so without one two identical requests can disagree and the list appears to shuffle on refresh.
 */
const SORTS: Record<BrowseSort, string> = Object.assign(Object.create(null) as Record<BrowseSort, string>, {
	newest: 'created_at DESC, id DESC',
	oldest: 'created_at ASC, id ASC',
	largest: 'size_bytes DESC, id DESC',
	smallest: 'size_bytes ASC, id ASC',
	path: 'path ASC, id ASC',
});

const DEFAULT_SORT: BrowseSort = 'newest';

/** One page. A browse read is bounded, because an unbounded one grows until it stops fitting in a response. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The most bytes a LIKE pattern may occupy.
 *
 * D1 refuses a longer pattern with `LIKE or GLOB pattern too complex`, and the refusal arrives as an **error**
 * rather than as "no match" — so an ordinary 49-character search term, or a 50-byte directory prefix, turned
 * the objects page into a 500. An adversarial audit measured the boundary exactly: 48 characters pass, 49
 * fail.
 *
 * A term long enough to exceed this cannot match anything a person meant to type, so it is answered with an
 * empty result instead of an error. Measured in **bytes** rather than characters, because the limit is on the
 * pattern as bytes — a non-ASCII search term reaches it sooner, and counting characters would let those
 * through to the same 500.
 *
 * Source: https://developers.cloudflare.com/d1/platform/limits/ — "Maximum characters (bytes) in a LIKE or
 * GLOB pattern: 50 bytes".
 */
const MAX_LIKE_BYTES = 50;

/** True when a LIKE pattern is short enough for the database to accept. */
export function likePatternFits(pattern: string): boolean {
	return new TextEncoder().encode(pattern).length <= MAX_LIKE_BYTES;
}

/**
 * Escapes a LIKE pattern so the user's characters are matched literally.
 *
 * `%` and `_` are wildcards in LIKE and a backslash escapes them. Without this, searching for "100%" matches
 * everything, which is indistinguishable from the filter being ignored.
 */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Turns a path pattern into a LIKE pattern.
 *
 * `*` becomes `%`, so `"/var/log/*.log"` matches files in that directory. A pattern with **no** wildcard
 * becomes a prefix, so `"/var/log"` finds everything under it rather than only a file with exactly that
 * name — an exact match there would return nothing and read as a broken search.
 */
function patternToLike(pattern: string): string {
	const escaped = escapeLike(pattern);
	if (escaped.includes('*')) return escaped.replace(/\*/g, '%');
	return `${escaped}%`;
}

/**
 * A clause that matches nothing, used where the alternative is an error.
 *
 * The condition is deliberately one the database evaluates as false rather than a placeholder value: the
 * caller asked something that cannot be answered, so the honest reply is an empty result, not a fault and not
 * an unfiltered list.
 */
const MATCHES_NOTHING = '1 = 0';

function conditions(filter: BrowseFilter): { clauses: string[]; params: unknown[]; tooLong: boolean } {
	const clauses: string[] = [];
	const params: unknown[] = [];
	let tooLong = false;

	// Deleted files are never listed, even when history is asked for: their bytes are gone, so offering a
	// download that cannot happen would be worse than omitting them.
	clauses.push('deleted_at IS NULL');
	if (!filter.includeSuperseded) clauses.push('superseded_by IS NULL');

	if (filter.hostId) {
		clauses.push('host_id = ?');
		params.push(filter.hostId);
	}

	const pattern = (filter.pattern ?? '').trim();
	if (pattern) {
		const like = patternToLike(pattern);
		if (likePatternFits(like)) {
			clauses.push("path LIKE ? ESCAPE '\\'");
			params.push(like);
		} else {
			// Refused cleanly instead of handed to a database that answers with an error. See MAX_LIKE_BYTES:
			// this is reachable with an ordinary directory prefix, and it used to turn the page into a 500.
			tooLong = true;
			clauses.push(MATCHES_NOTHING);
		}
	}

	const search = (filter.search ?? '').trim();
	if (search) {
		// The whole path, not the last segment: searching for a directory name is an obvious thing to do.
		const like = `%${escapeLike(search)}%`;
		if (likePatternFits(like)) {
			clauses.push("path LIKE ? ESCAPE '\\'");
			params.push(like);
		} else {
			tooLong = true;
			clauses.push(MATCHES_NOTHING);
		}
	}

	return { clauses, params, tooLong };
}

export interface ObjectQuery {
	sql: string;
	params: unknown[];
	countSql: string;
	countParams: unknown[];
	limit: number;
	offset: number;
	/**
	 * True when a filter term was too long for the database to evaluate, so the result is empty by decision
	 * rather than because nothing matched. The interface says "your search was too long" for this, which is a
	 * different and more useful message than "nothing found".
	 */
	termTooLong: boolean;
}

/** The largest number of rows one request may skip. */
const MAX_OFFSET = 100_000;

/**
 * Assembles the listing query, and the count that goes with it.
 *
 * Paging is an **offset**, not a keyset cursor, and the trade is deliberate. Every sort already ends in a
 * unique tie-break (`id`), so an offset over a fixed ORDER BY is stable for a reader that is not competing with
 * a writer — which is this case: one operator looking at a list. A cursor would need a separate comparison per
 * sort and a tuple comparison across two columns for most of them, and it would still be wrong for the "by
 * path" sort unless the key matched the ordering exactly. The known weakness of an offset is that a file
 * collected between two pages shifts the boundary by one, showing a duplicate or skipping a row; for a
 * collection that runs on a schedule rather than continuously, that is a smaller cost than five bespoke
 * cursors, and it is stated here rather than discovered later.
 */
export function buildObjectQuery(filter: BrowseFilter): ObjectQuery {
	const { clauses, params, tooLong } = conditions(filter);
	const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

	// Looked up, never interpolated, and the lookup is against a prototype-less object so that a value naming
	// an inherited member cannot reach the statement. See SORTS.
	const order = SORTS[filter.sort as BrowseSort] ?? SORTS[DEFAULT_SORT];

	const requested = Number(filter.limit);
	const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;

	const wantedOffset = Number(filter.offset);
	const offset = Number.isFinite(wantedOffset) && wantedOffset > 0 ? Math.min(Math.floor(wantedOffset), MAX_OFFSET) : 0;

	const qualified = where.replace(/\b(host_id|path|deleted_at|superseded_by)\b/g, 'o.$1');

	// `OFFSET` is appended only when it is needed. `OFFSET 0` is a no-op the database still has to plan, and
	// leaving it out keeps the statement for the common first-page case identical to what it was before paging
	// existed — so a reader comparing the two sees a real change rather than a cosmetic one.
	const paging = offset > 0 ? 'LIMIT ? OFFSET ?' : 'LIMIT ?';

	return {
		sql: `SELECT o.*, CASE WHEN f.object_id IS NULL THEN 0 ELSE 1 END AS important
		      FROM objects o
		      LEFT JOIN object_flags f ON f.object_id = o.id
		      ${qualified}
		      ORDER BY o.${order} ${paging}`,
		params: offset > 0 ? [...params, limit, offset] : [...params, limit],
		countSql: `SELECT COUNT(*) AS n FROM objects o ${qualified}`,
		countParams: params,
		limit,
		offset,
		termTooLong: tooLong,
	};
}
