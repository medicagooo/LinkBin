import { describe, expect, it } from 'vitest';
import { statementsOf } from '../src/sql';

/**
 * The migration splitter, tested directly.
 *
 * This exists because the splitter had a real bug that reached a database before anyone noticed: it
 * removed comments after splitting on `;`, so a comment containing a semicolon split mid-sentence and
 * the leftover prose was run as SQL. The database's complaint named an ordinary English word, which
 * pointed at nothing useful. These are the regression tests for that.
 */
describe('statementsOf', () => {
	it('splits on semicolons and drops the empties', () => {
		expect(statementsOf('CREATE TABLE a (x int);\nCREATE TABLE b (y int);')).toEqual([
			'CREATE TABLE a (x int)',
			'CREATE TABLE b (y int)',
		]);
	});

	it('ignores a semicolon inside a line comment', () => {
		// The exact regression: prose with a semicolon must not split the statement.
		const sql = ['-- the only atomic unit is one batch(); every statement below is repeatable', 'CREATE TABLE a (x int);'].join(
			'\n',
		);
		expect(statementsOf(sql)).toEqual(['CREATE TABLE a (x int)']);
	});

	it('ignores a semicolon inside a block comment, including a trailing one', () => {
		const sql = '/* one batch(); nothing more; */\nCREATE TABLE a (x int);';
		expect(statementsOf(sql)).toEqual(['CREATE TABLE a (x int)']);
	});

	it('does not treat a double dash inside a block comment as a line comment', () => {
		// If block comments were removed after line comments, the rest of this line would leak into SQL.
		const sql = '/* see -- this note; and this one */ CREATE TABLE a (x int);';
		expect(statementsOf(sql)).toEqual(['CREATE TABLE a (x int)']);
	});

	it('keeps a statement whose text spans several lines', () => {
		const sql = 'CREATE TABLE a (\n  x int,\n  y int\n);';
		expect(statementsOf(sql)).toEqual(['CREATE TABLE a (\n  x int,\n  y int\n)']);
	});

	it('returns nothing for a file that is only comments', () => {
		expect(statementsOf('-- nothing here;\n-- still nothing;')).toEqual([]);
	});

	it('trims whitespace so statements are clean', () => {
		expect(statementsOf('\n\n  SELECT 1 ;\n\n')).toEqual(['SELECT 1']);
	});
});
