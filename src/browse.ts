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
 * The tie-break is not cosmetic: rows sharing a timestamp come back in whatever order the database chooses,
 * so without one two identical requests can disagree and a list appears to shuffle on refresh.
 */
const SORTS: Record<BrowseSort, string> = {
	newest: 'created_at DESC, id DESC',
	oldest: 'created_at ASC, id ASC',
	largest: 'size_bytes DESC, id DESC',
	smallest: 'size_bytes ASC, id ASC',
	path: 'path ASC, id ASC',
};

const DEFAULT_SORT: BrowseSort = 'newest';

/** One page. A browse read is bounded, because an unbounded one grows until it stops fitting in a response. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

function conditions(filter: BrowseFilter): { clauses: string[]; params: unknown[] } {
	const clauses: string[] = [];
	const params: unknown[] = [];

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
		clauses.push("path LIKE ? ESCAPE '\\'");
		params.push(patternToLike(pattern));
	}

	const search = (filter.search ?? '').trim();
	if (search) {
		// The whole path, not the last segment: searching for a directory name is an obvious thing to do.
		clauses.push("path LIKE ? ESCAPE '\\'");
		params.push(`%${escapeLike(search)}%`);
	}

	return { clauses, params };
}

export interface ObjectQuery {
	sql: string;
	params: unknown[];
	countSql: string;
	countParams: unknown[];
	limit: number;
}

/** Assembles the listing query, and the count that goes with it. */
export function buildObjectQuery(filter: BrowseFilter): ObjectQuery {
	const { clauses, params } = conditions(filter);
	const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

	// Looked up, never interpolated. An unrecognised value becomes the default rather than an error, since a
	// bad sort should not break a page.
	const order = SORTS[filter.sort as BrowseSort] ?? SORTS[DEFAULT_SORT];

	const requested = Number(filter.limit);
	const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;

	return {
		sql: `SELECT o.*, CASE WHEN f.object_id IS NULL THEN 0 ELSE 1 END AS important
		      FROM objects o
		      LEFT JOIN object_flags f ON f.object_id = o.id
		      ${where.replace(/\b(host_id|path|deleted_at|superseded_by)\b/g, 'o.$1')}
		      ORDER BY o.${order} LIMIT ?`,
		params: [...params, limit],
		countSql: `SELECT COUNT(*) AS n FROM objects o ${where.replace(/\b(host_id|path|deleted_at|superseded_by)\b/g, 'o.$1')}`,
		countParams: params,
		limit,
	};
}
