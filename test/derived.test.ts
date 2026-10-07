import { describe, expect, it } from 'vitest';
import {
	mergeSignature,
	planMergeSources,
	previewDerived,
	ruleDefinitionProblem,
	runDerived,
	specMatches,
} from '../src/derived';
import type { DerivedRuleDefinition, StoredObject } from '../src/derived';

/**
 * The half of the merge feature that decides things: which stored files a rule takes, whether the result is
 * still current, and what a run would produce. The database and bucket half is covered by the route tests.
 */

function object(id: number, hostId: string, path: string, contentHash = `h${id}`, sizeBytes = 10): StoredObject {
	return { id, hostId, path, objectKey: `objects/${hostId}${path}`, sizeBytes, contentHash };
}

/**
 * The same, with the size given and the hash defaulted.
 *
 * A separate helper rather than reusing the one above, because its fourth parameter is the HASH: calling
 * `object(1, 'h1', path, 100)` passes a number where a hash belongs and silently leaves the size at the
 * default, which made a size assertion compare 10 against 300 and look like a defect in the code under test.
 */
function sized(id: number, hostId: string, path: string, sizeBytes: number): StoredObject {
	return object(id, hostId, path, `h${id}`, sizeBytes);
}

/** Contents keyed by object id, as the route assembles them from the bucket. */
function contentsOf(entries: [number, string][]): Map<number, string> {
	return new Map(entries);
}

const union: DerivedRuleDefinition = {
	outputName: 'merged.yaml',
	combination: 'yaml-list-union',
	sources: [{ pattern: '/etc/app/*.yaml' }],
};

describe('which stored files a rule takes', () => {
	it('matches a pattern against the whole stored path, not the file name', () => {
		// `/etc/*.yaml` must not match `/var/log/notes.yaml`: the vocabulary is the collection vocabulary, where
		// `*` does not cross a separator.
		expect(specMatches({ pattern: '/etc/*.yaml' }, object(1, 'h1', '/etc/a.yaml'))).toBe(true);
		expect(specMatches({ pattern: '/etc/*.yaml' }, object(2, 'h1', '/etc/sub/a.yaml'))).toBe(false);
		expect(specMatches({ pattern: '/etc/*.yaml' }, object(3, 'h1', '/var/etc/a.yaml'))).toBe(false);
	});

	it('treats a character class and other regex punctuation as literal text', () => {
		// The pattern is a glob, so `(`, `[` and `+` in a real file name must not become regex operators. A file
		// called `a+b.yaml` is ordinary; a pattern that fails to match it would look like a broken rule.
		expect(specMatches({ pattern: '/etc/a+b.yaml' }, object(1, 'h1', '/etc/a+b.yaml'))).toBe(true);
		expect(specMatches({ pattern: '/etc/a+b.yaml' }, object(2, 'h1', '/etc/aab.yaml'))).toBe(false);
		expect(specMatches({ pattern: '/etc/a(1).yaml' }, object(3, 'h1', '/etc/a1.yaml'))).toBe(false);
		expect(specMatches({ pattern: '/etc/a(1).yaml' }, object(4, 'h1', '/etc/a(1).yaml'))).toBe(true);
	});

	it('narrows to one machine when the pattern says so, and spans machines when it does not', () => {
		const spec = { pattern: '/etc/app.yaml', hostId: 'h1' };
		expect(specMatches(spec, object(1, 'h1', '/etc/app.yaml'))).toBe(true);
		expect(specMatches(spec, object(2, 'h2', '/etc/app.yaml'))).toBe(false);
		// The product exists to merge the same path from several machines, so no hostId means all of them.
		expect(specMatches({ pattern: '/etc/app.yaml' }, object(3, 'h2', '/etc/app.yaml'))).toBe(true);
	});

	it('orders by machine then path, so the same rule produces the same bytes', () => {
		// The engine sorts by path, which cannot distinguish two machines holding the same path — they arrive
		// with identical keys. Ordering has to be decided here or the output depends on row order.
		const objects = [
			object(1, 'h2', '/etc/app/a.yaml'),
			object(2, 'h1', '/etc/app/b.yaml'),
			object(3, 'h1', '/etc/app/a.yaml'),
		];
		const planned = planMergeSources(union, objects);
		expect(planned.map((o) => `${o.hostId}:${o.path}`)).toEqual([
			'h1:/etc/app/a.yaml',
			'h1:/etc/app/b.yaml',
			'h2:/etc/app/a.yaml',
		]);

		// And it is stable when the reads come back in a different order.
		const reversed = planMergeSources(union, [...objects].reverse());
		expect(reversed.map((o) => o.id)).toEqual(planned.map((o) => o.id));
	});

	it('takes a file matching two patterns once, not twice', () => {
		const definition: DerivedRuleDefinition = {
			...union,
			sources: [{ pattern: '/etc/*.yaml' }, { pattern: '/etc/app.yaml' }],
		};
		const planned = planMergeSources(definition, [object(1, 'h1', '/etc/app.yaml')]);
		expect(planned).toHaveLength(1);
	});

	it('never takes an object it was told to exclude', () => {
		// The exclusion is what stops a rule consuming its own previous output even if the cycle check were
		// bypassed, so it is asserted rather than assumed.
		const planned = planMergeSources(union, [object(1, 'h1', '/etc/app/a.yaml'), object(2, 'h1', '/etc/app/b.yaml')], new Set([1]));
		expect(planned.map((o) => o.id)).toEqual([2]);
	});
});

describe('whether a stored result is still current', () => {
	const sources = [object(1, 'h1', '/etc/a.yaml', 'aaa'), object(2, 'h1', '/etc/b.yaml', 'bbb')];

	it('is the same for the same rule and the same sources', () => {
		expect(mergeSignature(union, sources)).toBe(mergeSignature(union, sources));
	});

	it('changes when a source changes content, appears, or disappears', () => {
		const base = mergeSignature(union, sources);
		expect(mergeSignature(union, [object(1, 'h1', '/etc/a.yaml', 'CHANGED'), sources[1]])).not.toBe(base);
		expect(mergeSignature(union, [sources[0]])).not.toBe(base);
		expect(mergeSignature(union, [...sources, object(3, 'h1', '/etc/c.yaml')])).not.toBe(base);
	});

	it('changes when the rule changes', () => {
		const base = mergeSignature(union, sources);
		expect(mergeSignature({ ...union, outputName: 'other.yaml' }, sources)).not.toBe(base);
		expect(mergeSignature({ ...union, combination: 'concat' }, sources)).not.toBe(base);
		expect(mergeSignature({ ...union, order: ['/etc/b.yaml'] }, sources)).not.toBe(base);
		expect(mergeSignature({ ...union, sources: [{ pattern: '/etc/*.yaml', hostId: 'h1' }] }, sources)).not.toBe(base);
	});

	it('distinguishes a different file list with the same concatenated text', () => {
		// Without a length prefix per part, ["ab","c"] and ["a","bc"] would hash identically, so two genuinely
		// different source sets would look like the same one.
		const a = mergeSignature(union, [object(1, 'h1', '/x', 'ab'), object(2, 'h1', '/y', 'c')]);
		const b = mergeSignature(union, [object(1, 'h1', '/x', 'a'), object(2, 'h1', '/y', 'bc')]);
		expect(a).not.toBe(b);
	});

	it('distinguishes the same bytes stored on two machines', () => {
		// Identical content on h1 and h2 is two sources, not one, and swapping which machine is which changes
		// what `nameFromSource` writes into the output.
		const one = mergeSignature(union, [object(1, 'h1', '/etc/app.yaml', 'same')]);
		const two = mergeSignature(union, [object(1, 'h2', '/etc/app.yaml', 'same')]);
		expect(one).not.toBe(two);
	});
});

describe('what a run produces', () => {
	it('concatenates in a deterministic order and reports the signature', () => {
		const objects = [object(1, 'h1', '/etc/a.txt'), object(2, 'h1', '/etc/b.txt')];
		const outcome = runDerived({ outputName: 'all.txt', combination: 'concat', sources: [{ pattern: '/etc/*.txt' }] }, objects, contentsOf([
			[1, 'A\n'],
			[2, 'B\n'],
		]));

		expect(outcome.ok).toBe(true);
		expect(outcome.content).toBe('A\nB\n');
		expect(outcome.sourceCount).toBe(2);
		expect(outcome.signature).toBe(mergeSignature({ outputName: 'all.txt', combination: 'concat', sources: [{ pattern: '/etc/*.txt' }] }, objects));

		// Supplied in the other order, the same bytes come out — which is the property the whole feature rests on.
		const reversed = runDerived({ outputName: 'all.txt', combination: 'concat', sources: [{ pattern: '/etc/*.txt' }] }, [...objects].reverse(), contentsOf([
			[1, 'A\n'],
			[2, 'B\n'],
		]));
		expect(reversed.content).toBe(outcome.content);
	});

	it('refuses when nothing matched and carries no content', () => {
		// "Leave the previous result in place" is only enforceable if a failure can never carry bytes, so that
		// is asserted directly rather than left to the caller to remember.
		const outcome = runDerived(union, [], contentsOf([]));
		expect(outcome.ok).toBe(false);
		expect(outcome.content).toBeUndefined();
		expect(outcome.problem).toMatch(/no stored file matches/i);
	});

	it('refuses an unparseable source and carries no content, so a previous result survives', () => {
		const outcome = runDerived(union, [object(1, 'h1', '/etc/app/a.yaml')], contentsOf([[1, 'proxies: [oops\n']]));
		expect(outcome.ok).toBe(false);
		expect(outcome.content).toBeUndefined();
		expect(outcome.problem).toBeTruthy();
	});

	it('unions the list-valued sections of several documents into one document', () => {
		const objects = [object(1, 'h1', '/etc/app/a.yaml'), object(2, 'h1', '/etc/app/b.yaml')];
		const outcome = runDerived(union, objects, contentsOf([
			[1, 'proxies:\n  - name: p\n    port: 1\n'],
			[2, 'proxies:\n  - name: p\n    port: 1\n  - name: q\n    port: 2\n'],
		]));

		expect(outcome.ok).toBe(true);
		// The repeated entry appears once, and the document re-parses.
		expect(outcome.content).toContain('name: p');
		expect(outcome.content).toContain('name: q');
		expect((outcome.content ?? '').match(/name: p/g)).toHaveLength(1);
	});
});

describe('a rule as it is being defined', () => {
	const existing = [{ outputName: 'other.yaml', uses: ['/etc/other/*.yaml'] }];

	it('accepts a well-formed rule', () => {
		expect(ruleDefinitionProblem(union, existing)).toBeNull();
	});

	it('requires an output name, a known combination, and at least one source', () => {
		expect(ruleDefinitionProblem({ ...union, outputName: '  ' }, existing)).toMatch(/output name is required/i);
		expect(ruleDefinitionProblem({ ...union, combination: 'run-this-code' as never }, existing)).toMatch(/not a combination/i);
		expect(ruleDefinitionProblem({ ...union, sources: [] }, existing)).toMatch(/at least one source/i);
		expect(ruleDefinitionProblem({ ...union, sources: [{ pattern: '  ' }] }, existing)).toMatch(/needs a pattern/i);
	});

	it('refuses a leading slash on the output name, which is a name rather than a path', () => {
		expect(ruleDefinitionProblem({ ...union, outputName: '/merged.yaml' }, existing)).toMatch(/not a path/i);
	});

	it('refuses a rule that takes its own output, directly', () => {
		const selfUse: DerivedRuleDefinition = { ...union, sources: [{ pattern: 'merged.yaml' }] };
		expect(ruleDefinitionProblem(selfUse, existing)).toMatch(/cycle/i);
	});

	it('refuses a cycle through a second rule', () => {
		// a uses b, b uses a. Defined one at a time, the second definition is where it becomes a cycle — and
		// that is the point of checking here rather than at run time.
		const a: DerivedRuleDefinition = { outputName: 'a.yaml', combination: 'concat', sources: [{ pattern: 'b.yaml' }] };
		const b: DerivedRuleDefinition = { outputName: 'b.yaml', combination: 'concat', sources: [{ pattern: 'a.yaml' }] };
		expect(ruleDefinitionProblem(a, [])).toBeNull();
		expect(ruleDefinitionProblem(b, [{ outputName: 'a.yaml', uses: ['b.yaml'] }])).toMatch(/cycle/i);
	});

	it('allows redefining a rule without tripping over its own previous definition', () => {
		// The existing rule with the same output name is replaced, not combined with itself, or every edit to a
		// rule would be refused as a cycle with its own former self.
		expect(ruleDefinitionProblem(union, [{ outputName: 'merged.yaml', uses: ['/etc/app/*.yaml'] }])).toBeNull();
	});
});

describe('a preview, before anything is stored', () => {
	it('reports the count and size, and how many objects each pattern matched', () => {
		const objects = [sized(1, 'h1', '/etc/app/a.yaml', 100), sized(2, 'h1', '/etc/app/b.yaml', 200)];
		const preview = previewDerived(union, objects, contentsOf([[1, 'x: 1\n'], [2, 'y: 2\n']]));

		expect(preview.ok).toBe(true);
		expect(preview.sourceCount).toBe(2);
		expect(preview.sourceBytes).toBe(300);
		// The two figures answer different questions and must not be the same number by accident: the sources
		// occupy 300 stored bytes, while the combined text is 10. A preview that reported the second as the
		// first would understate what the rule pulls in.
		expect(preview.bytes, 'the output size, which is not the source size').toBe(10);
		expect(preview.perPattern).toEqual([{ pattern: '/etc/app/*.yaml', matched: 2 }]);
		expect(preview.sources).toEqual(['h1:/etc/app/a.yaml', 'h1:/etc/app/b.yaml']);
	});

	it('says a rule matched nothing rather than reporting an empty success', () => {
		const preview = previewDerived(union, [], contentsOf([]));
		expect(preview.ok).toBe(false);
		expect(preview.problem).toMatch(/no stored file matches/i);
	});

	it('names the pattern that matched nothing, which is the usual cause of a merge that did nothing', () => {
		const definition: DerivedRuleDefinition = {
			...union,
			sources: [{ pattern: '/etc/app/*.yaml' }, { pattern: '/nowhere/*.yaml' }],
		};
		const preview = previewDerived(definition, [object(1, 'h1', '/etc/app/a.yaml')], contentsOf([[1, 'x: 1\n']]));
		const misses = preview.perPattern.filter((entry) => entry.matched === 0).map((entry) => entry.pattern);
		expect(misses).toEqual(['/nowhere/*.yaml']);
	});
});
