import { describe, expect, it } from 'vitest';
import { createdObjectsOf, REQUIRED_SCHEMA, SCHEMA_MIGRATIONS } from '../src/migrations';
import { statementsOf } from '../src/sql';

/**
 * The schema the Worker declares, checked against the schema it actually applies.
 *
 * This exists because the same drift has already caused two defects here. Two features added tables without
 * extending the required list, and the result was `/api/status` reporting a healthy schema while a route
 * could not run at all — a readiness check that under-reports is worse than none, because it is believed.
 *
 * Both defects were invisible to the rest of the suite, which exercises routes with the schema already
 * applied. A check against the migration files runs on every build instead.
 */

/** Everything the migration files create, across all of them. */
function createdByMigrations(): Set<string> {
	const created = new Set<string>();
	for (const migration of SCHEMA_MIGRATIONS) {
		for (const name of createdObjectsOf(migration.sql)) created.add(name);
	}
	return created;
}

describe('what the migrations create', () => {
	it('parses tables and indexes out of the statements', () => {
		const names = createdObjectsOf(`
			CREATE TABLE IF NOT EXISTS alpha (id INTEGER);
			CREATE INDEX IF NOT EXISTS idx_alpha ON alpha (id);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_unique ON alpha (id);
			CREATE TABLE beta (id INTEGER);
		`);
		expect(names).toEqual(['alpha', 'idx_alpha', 'idx_alpha_unique', 'beta']);
	});

	it('is not fooled by a comment that mentions creating something', () => {
		// Comments are removed before splitting, so prose cannot be read as a statement — the bug that once
		// executed a comment's second half as SQL.
		const names = createdObjectsOf(`
			-- CREATE TABLE ghost (id INTEGER);
			/* CREATE TABLE phantom (id INTEGER); */
			CREATE TABLE real_one (id INTEGER);
		`);
		expect(names).toEqual(['real_one']);
	});
});

describe('the required list matches what is applied', () => {
	it('every required object is actually created by a migration', () => {
		// A name in this list that no migration creates means `/api/status` can never report ready, and the
		// schema guard refuses every route for ever.
		const created = createdByMigrations();
		const phantom = REQUIRED_SCHEMA.filter((name) => !created.has(name));
		expect(phantom, `required but never created: ${phantom.join(', ')}`).toEqual([]);
	});

	it('every object a migration creates is either required or deliberately optional', () => {
		// The direction that caught the real defect: a feature adds a table, forgets the list, and the
		// readiness check keeps reporting ready while its routes fail.
		//
		// Some objects are deliberately not required, and each is listed here with its reason rather than
		// silently excluded.
		const OPTIONAL = new Set([
			// Lookup indexes and uniqueness spines: their absence costs speed, not correctness, except for
			// `idx_objects_live` whose uniqueness is enforced by the constraint itself.
			'idx_hosts_enabled',
			'idx_objects_hash',
			'idx_objects_host_path',
			'idx_multipart_state',
			'idx_multipart_lookup',
			'idx_source_rules_host',
			'idx_source_rules_enabled',
			'idx_objects_live',
			'idx_shares_object',
			'idx_shares_expiry',
			'idx_auth_attempts_at',
			'idx_issues_run',
			'idx_issues_host',
			'idx_object_sources_source',
			'idx_runs_state',
		]);

		const created = createdByMigrations();
		const undeclared = [...created].filter((name) => !REQUIRED_SCHEMA.includes(name as never) && !OPTIONAL.has(name));
		expect(
			undeclared,
			`created by a migration but missing from REQUIRED_SCHEMA, so /api/status would report ready while these are absent: ${undeclared.join(', ')}`,
		).toEqual([]);
	});

	it('lists no object twice', () => {
		expect(new Set(REQUIRED_SCHEMA).size, 'a duplicate in the required list hides a missing entry').toBe(
			REQUIRED_SCHEMA.length,
		);
	});
});

describe('every migration is applied', () => {
	it('covers every migration the Worker holds, with a usable name for each', () => {
		// Which FILES exist is checked by `scripts/check-migrations.mjs`, because the Workers runtime has no
		// filesystem — a test here attempting it fails with `no such file or directory, readdir`. What can be
		// checked here is that the list the Worker actually carries is well formed, since a migration with no
		// name is one `applySchema` cannot report.
		expect(SCHEMA_MIGRATIONS.length).toBeGreaterThan(0);

		for (const migration of SCHEMA_MIGRATIONS) {
			expect(migration.name, 'a migration with no name cannot be reported').toBeTruthy();
			expect(migration.sql.length, `${migration.name} is empty`).toBeGreaterThan(0);
			// The numbering is the ordering contract; a gap usually means a file was never listed.
			expect(migration.name, `${migration.name} does not start with a number`).toMatch(/^\d{4}_/);
		}
	});

	it('is in ascending order, because the Worker applies them in the order given', () => {
		const names = SCHEMA_MIGRATIONS.map((m) => m.name);
		expect([...names].sort(), 'the migrations are not in ascending order').toEqual(names);
	});
});

describe('every migration statement is repeatable', () => {
	it('contains no ALTER TABLE, which cannot be applied twice', () => {
		// The database has no `ADD COLUMN IF NOT EXISTS`, and unlike `CREATE ... IF NOT EXISTS` a repeat is
		// an error. Prefer a new table — which is why the importance flag lives in `object_flags`.
		const offenders: string[] = [];
		for (const migration of SCHEMA_MIGRATIONS) {
			for (const statement of statementsOf(migration.sql)) {
				if (/^\s*ALTER\s+TABLE\b/i.test(statement)) offenders.push(`${migration.name}: ${statement.slice(0, 60)}`);
			}
		}
		expect(offenders, `a migration adds a column, which fails on the second application:\n${offenders.join('\n')}`).toEqual([]);
	});

	it('creates everything with IF NOT EXISTS, so a repeat is a no-op rather than an error', () => {
		const offenders: string[] = [];
		for (const migration of SCHEMA_MIGRATIONS) {
			for (const statement of statementsOf(migration.sql)) {
				if (/^\s*CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)\b/i.test(statement) && !/IF\s+NOT\s+EXISTS/i.test(statement)) {
					offenders.push(`${migration.name}: ${statement.slice(0, 70)}`);
				}
			}
		}
		expect(offenders, `a migration creates something without IF NOT EXISTS:\n${offenders.join('\n')}`).toEqual([]);
	});
});
