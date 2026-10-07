/**
 * The Worker's own migrations, as a module rather than three imports inside the router.
 *
 * Extracted so the list can be checked against what the Worker actually requires. That check exists
 * because this exact drift has already caused two defects in this project:
 *
 *   - `/api/status` reported a healthy schema while the sharing routes could not run, because two later
 *     features added tables without extending the required list.
 *   - The same omission meant `/api/status` under-reported, which is worse than no readiness check at all
 *     because it is believed.
 *
 * Both were invisible to the test suite, which exercised the routes with the schema already applied. A
 * check that runs on every build is the right place for it.
 */

import initSchemaSql from '../migrations/0001_init.sql';
import usageIndexSql from '../migrations/0002_usage_index.sql';
import receiptsSql from '../migrations/0003_receipts_importance_and_sources.sql';

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Applied in order, and every statement is safe to apply twice.
 *
 * `ALTER TABLE ... ADD COLUMN` is deliberately absent from every file: it is the one change a migration
 * cannot make repeatable, and the database offers no `ADD COLUMN IF NOT EXISTS`. A new table is preferred,
 * which is why the importance flag lives in `object_flags` rather than on `objects`.
 */
export const SCHEMA_MIGRATIONS: Migration[] = [
	{ name: '0001_init', sql: initSchemaSql },
	{ name: '0002_usage_index', sql: usageIndexSql },
	{ name: '0003_receipts_importance_and_sources', sql: receiptsSql },
];

/**
 * Every object the Worker's own queries depend on.
 *
 * This is what `/api/status` reports and what the schema guard refuses on, so a feature that adds a table
 * has exactly one place to declare it. Indexes appear alongside tables because some of them carry
 * correctness rather than speed — the uniqueness spine over `objects` is what makes collection idempotent —
 * and because a table can exist from an older deployment while a later migration never ran.
 */
export const REQUIRED_SCHEMA = [
	// Core: machines, their rules, stored files, and in-progress uploads.
	'hosts',
	'source_rules',
	'objects',
	'multipart_sessions',
	'idx_objects_usage',
	// Receipts: one row per run, and one per file that was not handled.
	'collection_runs',
	'collection_issues',
	'idx_runs_host_started',
	// Derived objects, and the record of what one was built from.
	'object_sources',
	// The importance flag, in its own table because adding a column is the one migration change that
	// cannot be applied twice.
	'object_flags',
	'idx_objects_eviction',
	// Authentication.
	'auth_secret',
	'auth_attempts',
	// Sharing.
	'shares',
] as const;

/**
 * What the migration files actually create.
 *
 * Parsed from the SQL rather than listed by hand, because a hand-written list is exactly the thing that
 * drifts. `statementsOf` removes comments before splitting, which matters: a comment containing a
 * semicolon otherwise splits mid-sentence and its prose is read as a statement.
 */
export function createdObjectsOf(sql: string): string[] {
	const statements = sql
		.replace(/\/\*[\s\S]*?\*\//g, '\n')
		.replace(/--[^\n]*/g, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean);

	const created: string[] = [];
	for (const statement of statements) {
		const table = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/i.exec(statement);
		if (table) created.push(table[1]);
		const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/i.exec(statement);
		if (index) created.push(index[1]);
	}
	return created;
}
