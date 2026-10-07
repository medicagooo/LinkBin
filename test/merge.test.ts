import { describe, expect, it } from 'vitest';
import {
	detectCycle,
	mergeText,
	normalizeLineEndings,
	orderSources,
	previewMerge,
	type MergeRule,
	type MergeSource,
} from '../src/merge';

/**
 * The merge engine, tested as pure logic.
 *
 * Deliberately not wired to storage or to the interface yet: nothing here needs a database, a bucket or
 * a machine, so nothing here should wait for one. The parts that DO need those — storing the result,
 * recording what it was built from, marking it important — are a separate step, and keeping them out
 * means the rules below can be checked without any of it.
 *
 * The properties that matter are the ones where a quiet mistake produces a file that looks fine:
 * non-deterministic ordering (two runs differ for no reason), mixed line endings (output unusable to
 * tools that care), and a failed merge overwriting a good previous result with something empty.
 */

const source = (path: string, content: string): MergeSource => ({ path, content });

describe('line endings', () => {
	it('normalises CRLF and lone CR to LF', () => {
		expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
	});

	it('leaves LF-only content untouched', () => {
		expect(normalizeLineEndings('a\nb\n')).toBe('a\nb\n');
	});

	it('does not double-convert an already normalised string', () => {
		expect(normalizeLineEndings(normalizeLineEndings('a\r\nb'))).toBe('a\nb');
	});
});

describe('ordering sources', () => {
	it('orders by path so an unchanged merge produces identical output', () => {
		const ordered = orderSources([source('/c', 'C'), source('/a', 'A'), source('/b', 'B')]);
		expect(ordered.map((s) => s.path)).toEqual(['/a', '/b', '/c']);
	});

	it('is stable regardless of the order the sources arrive in', () => {
		// The whole point: the same set read in a different order must produce the same bytes, or
		// re-running an unchanged merge looks like a change.
		const forwards = orderSources([source('/a', 'A'), source('/b', 'B'), source('/c', 'C')]);
		const backwards = orderSources([source('/c', 'C'), source('/b', 'B'), source('/a', 'A')]);
		expect(forwards).toEqual(backwards);
	});

	it('orders deterministically when two paths share a prefix', () => {
		const ordered = orderSources([source('/a/10', 'x'), source('/a/9', 'y'), source('/a/1', 'z')]);
		expect(ordered.map((s) => s.path)).toEqual(['/a/1', '/a/10', '/a/9']);
	});

	it('honours an explicit order when one is given', () => {
		const ordered = orderSources([source('/b', 'B'), source('/a', 'A')], ['/b', '/a']);
		expect(ordered.map((s) => s.path)).toEqual(['/b', '/a']);
	});

	it('appends sources the explicit order does not mention, still sorted', () => {
		// An explicit order must not silently drop a source it forgot; a missing file in the output is
		// worse than an unexpected position.
		const ordered = orderSources([source('/c', 'C'), source('/a', 'A'), source('/b', 'B')], ['/c']);
		expect(ordered.map((s) => s.path)).toEqual(['/c', '/a', '/b']);
	});
});

describe('combining text', () => {
	const rule = (over: Partial<MergeRule> = {}): MergeRule => ({
		outputName: 'merged.txt',
		combination: 'concat',
		...over,
	});

	it('joins sources with a separator and a trailing newline', () => {
		const result = mergeText(rule(), [source('/a', 'first'), source('/b', 'second')]);
		expect(result.ok).toBe(true);
		expect(result.content).toBe('first\nsecond\n');
	});

	it('normalises line endings before combining, so the output is not mixed', () => {
		// A Windows-authored source and a Unix one must not produce a file with both endings in it.
		const result = mergeText(rule(), [source('/a', 'one\r\ntwo'), source('/b', 'three\n')]);
		expect(result.content).toBe('one\ntwo\nthree\n');
		expect(result.content).not.toContain('\r');
	});

	it('is byte-identical when the sources are supplied in a different order', () => {
		const forwards = mergeText(rule(), [source('/a', 'A'), source('/b', 'B')]);
		const backwards = mergeText(rule(), [source('/b', 'B'), source('/a', 'A')]);
		expect(forwards.content).toBe(backwards.content);
	});

	it('reports the source count and total size, for the preview', () => {
		const result = mergeText(rule(), [source('/a', '12345'), source('/b', '123')]);
		expect(result.sourceCount).toBe(2);
		expect(result.sourceBytes).toBe(8);
		expect(result.bytes).toBe(Buffer.byteLength(result.content!, 'utf8'));
	});

	it('fails with an explanation when there are no sources, and produces no content', () => {
		// The dangerous case: an empty result replacing a good previous one. Refusing is the only safe
		// answer, so there must be no content to store.
		const result = mergeText(rule(), []);
		expect(result.ok).toBe(false);
		expect(result.content).toBeUndefined();
		expect(result.problem).toMatch(/no sources/i);
	});

	it('fails when every source is empty', () => {
		const result = mergeText(rule(), [source('/a', ''), source('/b', '')]);
		expect(result.ok).toBe(false);
		expect(result.content).toBeUndefined();
		expect(result.problem).toMatch(/empty/i);
	});

	it('succeeds when only some sources are empty, and says so', () => {
		const result = mergeText(rule(), [source('/a', 'kept'), source('/b', '')]);
		expect(result.ok).toBe(true);
		expect(result.content).toBe('kept\n');
		expect(result.notes.join(' ')).toMatch(/empty/i);
	});

	it('refuses to guess when a named source is missing', () => {
		const result = mergeText(rule(), [source('/a', 'kept')], { expectedPaths: ['/a', '/gone'] });
		expect(result.ok).toBe(false);
		expect(result.problem).toContain('/gone');
		expect(result.content).toBeUndefined();
	});

	it('names every missing source rather than only the first', () => {
		const result = mergeText(rule(), [], { expectedPaths: ['/x', '/y'] });
		expect(result.problem).toContain('/x');
		expect(result.problem).toContain('/y');
	});

	it('adds a trailing newline only once, even when the last source ends with several', () => {
		const result = mergeText(rule(), [source('/a', 'body\n\n\n')]);
		expect(result.content).toBe('body\n');
	});
});

describe('the preview', () => {
	it('reports what would happen without producing anything to store', () => {
		const preview = previewMerge(
			{ outputName: 'merged.txt', combination: 'concat' },
			[source('/a', 'aaa'), source('/b', 'bb')],
		);
		expect(preview.ok).toBe(true);
		expect(preview.sourceCount).toBe(2);
		expect(preview.sourceBytes).toBe(5);
		expect(preview.outputName).toBe('merged.txt');
		// A preview that could be mistaken for a result is a hazard; it carries no content.
		expect(preview).not.toHaveProperty('content');
	});

	it('reports the same failure a real merge would, so previews do not lie', () => {
		const preview = previewMerge({ outputName: 'x.txt', combination: 'concat' }, []);
		expect(preview.ok).toBe(false);
		expect(preview.problem).toMatch(/no sources/i);
	});
});

describe('a merge cannot depend on itself', () => {
	const ruleFor = (name: string, uses: string[]): { outputName: string; uses: string[] } => ({ outputName: name, uses });

	it('accepts an independent merge', () => {
		expect(detectCycle([ruleFor('a.txt', ['/one', '/two']), ruleFor('b.txt', ['/three'])])).toBeNull();
	});

	it('refuses a merge that lists its own output', () => {
		const cycle = detectCycle([ruleFor('a.txt', ['/one', 'a.txt'])]);
		expect(cycle).not.toBeNull();
		expect(cycle!.join(' -> ')).toContain('a.txt');
	});

	it('refuses a cycle through another merge', () => {
		// a <- b <- a: neither is directly self-referential, and running either would never terminate.
		const cycle = detectCycle([ruleFor('a.txt', ['b.txt']), ruleFor('b.txt', ['a.txt'])]);
		expect(cycle).not.toBeNull();
	});

	it('refuses a longer cycle', () => {
		const cycle = detectCycle([ruleFor('a.txt', ['b.txt']), ruleFor('b.txt', ['c.txt']), ruleFor('c.txt', ['a.txt'])]);
		expect(cycle).not.toBeNull();
	});

	it('accepts a chain, which is not a cycle', () => {
		// a depends on b depends on a collected file: legitimate, and must not be refused.
		expect(detectCycle([ruleFor('a.txt', ['b.txt']), ruleFor('b.txt', ['/collected'])])).toBeNull();
	});

	it('reports the cycle path so the operator can see which rule to change', () => {
		const cycle = detectCycle([ruleFor('a.txt', ['b.txt']), ruleFor('b.txt', ['c.txt']), ruleFor('c.txt', ['a.txt'])]);
		expect(cycle!.length).toBeGreaterThanOrEqual(3);
		expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
	});
});
