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

// --- every migration file is listed by the Worker -----------------------------------------------
//
// A migration file that exists but is not named in `src/migrations.ts` is **never applied** by a
// deployment with no CLI, and nothing the running Worker can see would reveal it: it reports the
// migrations it holds, and it does not hold that one. This has already gone wrong in the other direction
// here — a feature added a table without extending the required list, and the readiness check kept
// reporting a healthy schema while its routes could not run.
//
// Checked by reading the file rather than by importing it, because importing TypeScript here would need a
// build step this guard deliberately does not have.
const registryPath = 'src/migrations.ts';
let registryProblems = [];
try {
	const registry = readFileSync(registryPath, 'utf8');
	const block = /SCHEMA_MIGRATIONS\s*:\s*Migration\[\]\s*=\s*\[([\s\S]*?)\];/.exec(registry);
	if (!block) {
		registryProblems.push(`${registryPath}: could not find the SCHEMA_MIGRATIONS list to check`);
	} else {
		const listed = [...block[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
		// Each migration's SQL is imported from a file; check the imports line up with the list.
		const importedSql = [...registry.matchAll(/from\s+'\.\.\/migrations\/([^']+)\.sql'/g)].map((m) => m[1]);

		for (const file of files) {
			const stem = file.replace(/\.sql$/, '');
			const named = listed.some((name) => name === stem);
			const imported = importedSql.includes(stem);
			if (!named || !imported) {
				registryProblems.push(
					`${file} exists but the Worker does not apply it (named in the list: ${named}, imported: ${imported}); it would never run on a deployment with no CLI`,
				);
			}
		}

		for (const name of listed) {
			if (!files.includes(`${name}.sql`)) {
				registryProblems.push(`${registryPath} lists ${name}, but migrations/${name}.sql does not exist`);
			}
		}
	}
} catch (err) {
	registryProblems.push(`${registryPath}: ${err.message}`);
}

if (registryProblems.length) {
	console.error(`\nMigration guard: ${registryProblems.length} problem(s) with the migration registry\n`);
	for (const p of registryProblems) console.error(`  ${p}`);
	console.error('');
	process.exit(1);
}

console.log(
	`Migration guard: ${total} statements across ${files.length} files, all repeatable, well-formed and applied by the Worker`,
);
