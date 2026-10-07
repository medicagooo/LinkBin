/**
 * Checks the migration files, from outside the Workers runtime.
 *
 * Kept separate from the test suite on purpose: tests run inside the Workers runtime, which has no
 * filesystem, so a check about *source files* belongs here rather than in a test that cannot read
 * them.
 *
 * The invariant being enforced: **every migration statement must be safe to apply twice.** The
 * schema bootstrap promises this, and the interface exposes it as a button, so a migration that
 * breaks it turns a second press into a failure.
 *
 * `CREATE ... IF NOT EXISTS` is naturally repeatable. `ALTER TABLE ... ADD COLUMN` is not, and the
 * database offers no `ADD COLUMN IF NOT EXISTS`. An earlier draft used one and failed its own
 * "safe to run again" test; the fix was a new table instead of a new column. This check catches the
 * next one before it reaches a database.
 *
 * Also reports statements that are not comment-free SQL, which catches the other bug found the same
 * way: splitting on `;` before removing comments left prose to be executed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = 'migrations';

/** Mirrors the runtime splitter; see src/sql.ts for why comments are removed before splitting. */
function statementsOf(sql) {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, '\n')
		.replace(/--[^\n]*/g, '')
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

const problems = [];
const files = readdirSync(MIGRATIONS_DIR)
	.filter((f) => f.endsWith('.sql'))
	.sort();

let total = 0;
for (const file of files) {
	const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
	for (const [index, statement] of statementsOf(sql).entries()) {
		total += 1;
		const where = `${file} statement ${index + 1}`;

		if (/^\s*ALTER\s+TABLE\b/i.test(statement)) {
			problems.push(
				`${where}: adds or changes a column, which cannot be applied twice. Prefer a new table, ` +
					`or make the change repeatable another way.`,
			);
		}

		if (!/^\s*(CREATE|INSERT|UPDATE|DELETE|DROP|SELECT|WITH)\b/i.test(statement)) {
			problems.push(`${where}: does not begin with a SQL keyword, so it is probably leftover text: ${statement.slice(0, 80)}`);
		}
	}
}

if (problems.length) {
	console.error(`\nMigration guard: ${problems.length} problem(s) across ${files.length} file(s)\n`);
	for (const p of problems) console.error(`  ${p}`);
	console.error('');
	process.exit(1);
}

console.log(`Migration guard: ${total} statements across ${files.length} files, all repeatable and well-formed`);
