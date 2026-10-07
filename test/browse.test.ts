import { describe, expect, it } from 'vitest';
import { buildObjectQuery, type BrowseFilter } from '../src/browse';

/**
 * Browsing and searching stored files.
 *
 * ## Why the query is assembled from a whitelist rather than from the request
 *
 * Everything here comes from a query string, which anyone can write. A column name or an ORDER BY clause
 * taken from a request and interpolated into SQL is the classic injection, and it is not prevented by the
 * values being parameterised — parameters protect values, not identifiers. So the sort and the direction are
 * looked up in a fixed table, and anything unrecognised becomes the default rather than an error, because a
 * bad sort is not worth failing a page over.
 *
 * ## Why the filter semantics are tests rather than implementation details
 *
 * Two of them decide whether search is usable at all. A pattern containing a wildcard means something
 * different from one that does not, and a search term that matches a path must match the *whole* path rather
 * than the last segment — otherwise searching for a directory name finds nothing, which is the most likely
 * thing anyone types.
 */

const filters = (over: Partial<BrowseFilter> = {}): BrowseFilter => ({ ...over });

describe('what is listed', () => {
	it('lists only live files by default', () => {
		// Superseded and deleted rows still occupy storage, but they are not what the operator is browsing.
		// The budget page is where they are accounted for; this list is what can actually be downloaded.
		const { sql, params } = buildObjectQuery(filters());
		expect(sql).toMatch(/o\.superseded_by IS NULL/);
		expect(sql).toMatch(/o\.deleted_at IS NULL/);
		// The only parameter is the page size: nothing was filtered on.
		expect(params).toEqual([50]);
	});

	it('can include superseded versions when asked', () => {
		const { sql } = buildObjectQuery(filters({ includeSuperseded: true }));
		expect(sql).not.toMatch(/superseded_by IS NULL/);
		expect(sql).toMatch(/o\.deleted_at IS NULL/);
	});

	it('always excludes deleted files, even when history is requested', () => {
		// A deleted file has no bytes to serve, so listing it would offer a download that cannot happen.
		const { sql } = buildObjectQuery(filters({ includeSuperseded: true }));
		expect(sql).toMatch(/o\.deleted_at IS NULL/);
	});

	it('qualifies its columns, so the join to the importance flag cannot be ambiguous', () => {
		// `object_flags` has its own `object_id` and `created_at`; an unqualified column in a join is at best a
		// confusing error and at worst the wrong column silently.
		const { sql } = buildObjectQuery(filters({ hostId: 'h1', search: 'x' }));
		expect(sql).toMatch(/o\.host_id = \?/);
		expect(sql).toMatch(/o\.path LIKE \?/);
	});
});

describe('filtering', () => {
	it('filters by machine', () => {
		const { sql, params } = buildObjectQuery(filters({ hostId: 'web-01' }));
		expect(sql).toMatch(/host_id = \?/);
		expect(params).toContain('web-01');
	});

	it('treats a wildcard in the pattern as a pattern', () => {
		const { sql, params } = buildObjectQuery(filters({ pattern: '/var/log/*.log' }));
		expect(sql).toMatch(/path (LIKE|GLOB)/i);
		expect(params.some((p) => String(p).includes('%') || String(p).includes('*'))).toBe(true);
	});

	it('treats a pattern with no wildcard as a prefix, not as an exact name', () => {
		// Typing a directory should find what is under it. An exact match would return nothing, which is the
		// single most likely way for this feature to look broken.
		const { sql, params } = buildObjectQuery(filters({ pattern: '/var/log' }));
		expect(sql).toMatch(/LIKE/i);
		expect(params).toContain('/var/log%');
	});

	it('never treats a pattern as SQL, even when it contains quotes or a comment', () => {
		// The value is parameterised, so this cannot change the statement; asserted because it is the property
		// that matters and a future refactor could break it silently.
		const nasty = "' OR 1=1; DROP TABLE objects; --";
		const { sql, params } = buildObjectQuery(filters({ pattern: nasty }));
		expect(sql).not.toContain('DROP TABLE');
		expect(sql).not.toContain('OR 1=1');
		expect(params.some((p) => String(p).includes('DROP TABLE'))).toBe(true);
	});

	it('searches the whole path, not only the file name', () => {
		// Searching for a directory name is an obvious thing to do and must work.
		const { sql, params } = buildObjectQuery(filters({ search: 'nginx' }));
		expect(sql).toMatch(/path LIKE \?/i);
		expect(params).toContain('%nginx%');
	});

	it('escapes a search term so a literal percent sign is searched for rather than matching everything', () => {
		// Without escaping, searching for "100%" matches every row and looks like the filter was ignored.
		const { params } = buildObjectQuery(filters({ search: '100%' }));
		const term = params.find((p) => String(p).includes('100'));
		expect(String(term)).toContain('\\%');
	});

	it('escapes a literal underscore too, which is a single-character wildcard', () => {
		const { params } = buildObjectQuery(filters({ search: 'a_b' }));
		const term = params.find((p) => String(p).includes('a'));
		expect(String(term)).toContain('\\_');
	});

	it('ignores a blank search rather than matching everything by accident', () => {
		const { sql, params } = buildObjectQuery(filters({ search: '   ' }));
		expect(sql).not.toMatch(/o\.path LIKE/i);
		expect(params).toEqual([50]);
	});

	it('combines a machine and a search', () => {
		const { sql, params } = buildObjectQuery(filters({ hostId: 'h1', search: 'conf' }));
		expect(sql).toMatch(/o\.host_id = \?/);
		expect(sql).toMatch(/o\.path LIKE \?/i);
		// Two filters plus the page size.
		expect(params).toEqual(['h1', '%conf%', 50]);
	});
});

describe('sorting', () => {
	it('sorts newest first by default, because the latest is usually what is wanted', () => {
		const { sql } = buildObjectQuery(filters());
		expect(sql).toMatch(/ORDER BY o\.created_at DESC/i);
	});

	it('supports the sorts the interface offers', () => {
		for (const sort of ['newest', 'oldest', 'largest', 'smallest', 'path'] as const) {
			const { sql } = buildObjectQuery(filters({ sort }));
			expect(sql, `sort ${sort}`).toMatch(/ORDER BY/i);
		}
	});

	it('falls back to the default for an unrecognised sort instead of failing or interpolating it', () => {
		// A sort value arrives from a query string. It is never interpolated: an unknown one becomes the
		// default, because a bad sort should not break a page, and an interpolated identifier is injection.
		const injected = 'created_at; DROP TABLE objects; --';
		const { sql } = buildObjectQuery(filters({ sort: injected as never }));
		expect(sql).not.toContain('DROP TABLE');
		expect(sql).toMatch(/ORDER BY o\.created_at DESC/i);
	});

	it('always breaks ties the same way, so paging through results does not shuffle', () => {
		// Without a tie-break, rows with the same timestamp come back in whatever order the database chooses,
		// and two identical requests can disagree.
		for (const sort of ['newest', 'oldest', 'largest', 'smallest', 'path'] as const) {
			const { sql } = buildObjectQuery(filters({ sort }));
			expect(sql, `sort ${sort} tie-break`).toMatch(/id (DESC|ASC)/i);
		}
	});
});

describe('how much is returned', () => {
	it('is bounded, because an unbounded read grows until it stops fitting in a response', () => {
		const { sql, params } = buildObjectQuery(filters());
		expect(sql).toMatch(/LIMIT \?/);
		expect(params).toContain(50);
	});

	it('honours a requested limit inside the maximum', () => {
		const { params } = buildObjectQuery(filters({ limit: 10 }));
		expect(params).toContain(10);
	});

	it('refuses to exceed the maximum however large a limit is asked for', () => {
		const { params } = buildObjectQuery(filters({ limit: 100000 }));
		expect(params).toContain(200);
	});

	it('refuses a limit that is not a positive number', () => {
		expect(buildObjectQuery(filters({ limit: 0 })).params).toContain(50);
		expect(buildObjectQuery(filters({ limit: -5 })).params).toContain(50);
		expect(buildObjectQuery(filters({ limit: Number.NaN })).params).toContain(50);
	});

	it('asks for the total separately, so the interface can say how many there are', () => {
		// A count is a second query rather than a window function, because the row limit matters more here
		// than the query count and a window function would return the count on every row.
		const { countSql } = buildObjectQuery(filters({ hostId: 'h1', search: 'log' }));
		expect(countSql).toMatch(/SELECT COUNT\(\*\)/i);
		expect(countSql).not.toMatch(/LIMIT/i);
		expect(countSql).toMatch(/host_id = \?/);
	});
});
