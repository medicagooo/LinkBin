/**
 * Splitting a migration file into executable statements.
 *
 * This lives on its own because it is pure logic with a real failure mode, and it is cheaper to test
 * directly than through a database.
 *
 * The failure mode, which actually happened: comments were removed *after* splitting on `;` rather
 * than before. A comment containing a semicolon then split mid-sentence and the leftover prose was
 * executed as SQL, producing `near "the": syntax error` — an error naming an ordinary English word
 * and giving no hint which migration was at fault. It went unnoticed until a migration used a
 * semicolon in prose.
 *
 * Not a full SQL lexer: `--` to end of line and `/* ... *\/` blocks are handled; string literals are
 * not understood, so a semicolon inside a quoted literal would still split a statement in two.
 * Migrations should not contain one.
 */
export function statementsOf(sql: string): string[] {
	const withoutComments = sql
		// Block comments first, so a `--` inside one is not mistaken for a line comment.
		.replace(/\/\*[\s\S]*?\*\//g, '\n')
		// Then line comments to end of line.
		.replace(/--[^\n]*/g, '');

	return withoutComments
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}
