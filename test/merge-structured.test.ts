import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { mergeText, type MergeRule, type MergeSource } from '../src/merge';

/**
 * The structured merge: several documents combined into one, with duplicates removed.
 *
 * This is the operation the whole feature exists for. The sources look like the real ones — per-host
 * configuration documents listing proxy nodes, each authored separately and therefore formatted
 * differently while describing overlapping entries.
 *
 * The failure that matters most here is a merge that *looks* successful. Appending documents produces a
 * file that parses and is wrong; keeping textual duplicates produces a list that grows every run; and
 * sorting by source order produces output that changes when an unrelated file is added. Each of those is
 * checked below rather than assumed.
 */

const rule: MergeRule = { outputName: 'merged-all.yaml', combination: 'yaml-list-union' };

const src = (path: string, content: string): MergeSource => ({ path, content });

/** Two nodes, as one host would list them. */
const DARTNODE = `
proxies:
  - name: dartnode-01
    server: 203.0.113.10
    port: 443
  - name: dartnode-02
    server: 203.0.113.11
    port: 443
`;

/** One of the same nodes, written with different key order and quoting, plus a new one. */
const RABISU = `
proxies:
  - port: 443
    server: 203.0.113.10
    name: dartnode-01
  - name: rabisu-01
    server: 198.51.100.5
    port: 8443
`;

describe('combining disjoint sources', () => {
	it('unions the lists, keeping every entry', () => {
		const result = mergeText(rule, [
			src('/a.yaml', 'proxies:\n  - name: one\n    server: 203.0.113.1\n'),
			src('/b.yaml', 'proxies:\n  - name: two\n    server: 203.0.113.2\n'),
		]);

		expect(result.ok).toBe(true);
		const merged = parseYaml(result.content!) as { proxies: { name: string }[] };
		expect(merged.proxies.map((p) => p.name).sort()).toEqual(['one', 'two']);
	});

	it('produces output that re-parses, checked by parsing rather than by reading', () => {
		const result = mergeText(rule, [src('/a.yaml', DARTNODE), src('/b.yaml', RABISU)]);
		expect(result.ok).toBe(true);
		expect(() => parseYaml(result.content!)).not.toThrow();
	});

	it('does not append the documents as repeated blocks', () => {
		// The naive implementation concatenates the files. The output would still parse, so this is
		// checked by looking for the key appearing twice.
		const result = mergeText(rule, [src('/a.yaml', DARTNODE), src('/b.yaml', RABISU)]);
		const occurrences = (result.content!.match(/^proxies:/gm) ?? []).length;
		expect(occurrences).toBe(1);
	});
});

describe('removing duplicates', () => {
	it('keeps an entry that appears in two sources only once', () => {
		const result = mergeText(rule, [src('/a.yaml', DARTNODE), src('/b.yaml', RABISU)]);
		const merged = parseYaml(result.content!) as { proxies: { name: string }[] };
		const names = merged.proxies.map((p) => p.name);
		expect(names.filter((n) => n === 'dartnode-01').length).toBe(1);
		expect(names.sort()).toEqual(['dartnode-01', 'dartnode-02', 'rabisu-01']);
	});

	it('compares structurally, not textually, so different formatting is still a duplicate', () => {
		// These two describe the same node and are written differently: key order, quoting, and spacing.
		// A text comparison would keep both, and the output would grow on every run.
		const result = mergeText(rule, [
			src('/a.yaml', "proxies:\n  - name: same\n    server: 203.0.113.9\n    port: 443\n"),
			src('/b.yaml', 'proxies:\n  - { "port": 443, "server": "203.0.113.9", "name": "same" }\n'),
		]);

		const merged = parseYaml(result.content!) as { proxies: unknown[] };
		expect(merged.proxies.length).toBe(1);
	});

	it('treats entries that differ in any field as different', () => {
		const result = mergeText(rule, [
			src('/a.yaml', 'proxies:\n  - name: n\n    port: 443\n'),
			src('/b.yaml', 'proxies:\n  - name: n\n    port: 8443\n'),
		]);
		const merged = parseYaml(result.content!) as { proxies: unknown[] };
		expect(merged.proxies.length).toBe(2);
	});

	it('merges every list-valued key, not only a key called proxies', () => {
		const result = mergeText(rule, [
			src('/a.yaml', 'proxies:\n  - name: p\nrules:\n  - MATCH,DIRECT\n'),
			src('/b.yaml', 'proxies:\n  - name: q\nrules:\n  - DOMAIN,x,DIRECT\n'),
		]);
		const merged = parseYaml(result.content!) as { proxies: unknown[]; rules: unknown[] };
		expect(merged.proxies.length).toBe(2);
		expect(merged.rules.length).toBe(2);
	});
});

describe('determinism', () => {
	it('produces byte-identical output when the sources arrive in a different order', () => {
		const sources = [src('/a.yaml', DARTNODE), src('/b.yaml', RABISU), src('/c.yaml', 'proxies:\n  - name: z\n')];
		const forwards = mergeText(rule, sources);
		const backwards = mergeText(rule, [...sources].reverse());

		expect(forwards.content).toBe(backwards.content);
	});

	it('produces byte-identical output across two runs of the same input', () => {
		const sources = [src('/a.yaml', DARTNODE), src('/b.yaml', RABISU)];
		expect(mergeText(rule, sources).content).toBe(mergeText(rule, sources).content);
	});

	it('orders entries deterministically rather than by which source was read first', () => {
		// Adding a source must not reshuffle the existing entries, or every diff looks like a change.
		const base = mergeText(rule, [src('/a.yaml', 'proxies:\n  - name: beta\n'), src('/b.yaml', 'proxies:\n  - name: delta\n')]);
		const added = mergeText(rule, [
			src('/a.yaml', 'proxies:\n  - name: beta\n'),
			src('/b.yaml', 'proxies:\n  - name: delta\n'),
			src('/c.yaml', 'proxies:\n  - name: alpha\n'),
		]);

		const before = (parseYaml(base.content!) as { proxies: { name: string }[] }).proxies.map((p) => p.name);
		const after = (parseYaml(added.content!) as { proxies: { name: string }[] }).proxies.map((p) => p.name);
		// Every original entry keeps its relative position.
		expect(after.filter((n) => before.includes(n))).toEqual(before);
	});
});

describe('a source that cannot be parsed', () => {
	it('fails, names the file, and produces nothing to store', () => {
		const result = mergeText(rule, [src('/good.yaml', 'proxies:\n  - name: fine\n'), src('/broken.yaml', 'proxies:\n  - name: [unclosed\n')]);

		expect(result.ok).toBe(false);
		expect(result.problem).toContain('/broken.yaml');
		// The previous derived object must survive; there is no partial content to replace it with.
		expect(result.content).toBeUndefined();
	});

	it('reports the file even when it is a valid document of the wrong shape', () => {
		const result = mergeText(rule, [src('/good.yaml', 'proxies:\n  - name: fine\n'), src('/list.yaml', '- just\n- a\n- list\n')]);
		expect(result.ok).toBe(false);
		expect(result.problem).toContain('/list.yaml');
	});
});

describe('keys that cannot be merged as a list', () => {
	it('resolves a conflict by source order and says which source won', () => {
		// Stated rule rather than "whichever was read last": a merge whose result depends on read order is
		// impossible to reason about, and the operator cannot tell it happened.
		const result = mergeText(rule, [
			src('/a.yaml', 'title: first\nproxies:\n  - name: p\n'),
			src('/b.yaml', 'title: second\nproxies:\n  - name: q\n'),
		]);

		expect(result.ok).toBe(true);
		const merged = parseYaml(result.content!) as { title: string };
		expect(merged.title).toBe('first');
		expect(result.notes.join(' ')).toContain('title');
		expect(result.notes.join(' ')).toContain('/b.yaml');
	});

	it('does not report a conflict when the values agree', () => {
		const result = mergeText(rule, [
			src('/a.yaml', 'title: same\nproxies:\n  - name: p\n'),
			src('/b.yaml', 'title: same\nproxies:\n  - name: q\n'),
		]);
		expect(result.notes.join(' ')).not.toContain('conflicting');
	});
});

describe('keys only some sources set', () => {
	it('keeps a key that the first source does not mention', () => {
		// Regression test for a real defect found by running the engine against the operator's own files.
		// The first source had no `ipv6` key, so `ipv6: true` from a later source vanished from the output
		// with no warning. Absence is not disagreement: a key must only be lost when sources actively
		// disagree, and then it is reported.
		const result = mergeText(rule, [
			src('/a.yaml', 'proxies:\n  - name: p\n'),
			src('/b.yaml', 'ipv6: true\nproxies:\n  - name: q\n'),
		]);

		expect(result.ok).toBe(true);
		const merged = parseYaml(result.content!) as { ipv6?: boolean };
		expect(merged.ipv6).toBe(true);
	});

	it('keeps every distinct key, whichever source introduced it', () => {
		const result = mergeText(rule, [
			src('/a.yaml', 'alpha: 1\nproxies:\n  - name: p\n'),
			src('/b.yaml', 'beta: 2\nproxies:\n  - name: q\n'),
			src('/c.yaml', 'gamma: 3\nproxies:\n  - name: r\n'),
		]);

		const merged = parseYaml(result.content!) as Record<string, unknown>;
		expect(merged.alpha).toBe(1);
		expect(merged.beta).toBe(2);
		expect(merged.gamma).toBe(3);
	});

	it('does not warn about absence, only about disagreement', () => {
		const result = mergeText(rule, [src('/a.yaml', 'only-here: yes\nproxies:\n  - name: p\n'), src('/b.yaml', 'proxies:\n  - name: q\n')]);
		expect(result.notes.join(' ')).not.toContain('conflicting');
	});

	it('still reports a genuine disagreement between values', () => {
		const result = mergeText(rule, [src('/a.yaml', 'mode: rule\n'), src('/b.yaml', 'mode: global\n')]);
		const merged = parseYaml(result.content!) as { mode: string };
		expect(merged.mode).toBe('rule');
		expect(result.notes.join(' ')).toContain('mode');
	});
});

describe('the preview for a structured merge', () => {
	it('reports the counts an operator needs to tell a working rule from an inert one', () => {
		const result = mergeText(rule, [src('/a.yaml', DARTNODE), src('/b.yaml', RABISU)]);
		// Two sources in, three unique entries out: the numbers have to be visible, or a rule that
		// silently did nothing looks the same as one with nothing to do.
		expect(result.sourceCount).toBe(2);
		expect(result.sourceBytes).toBeGreaterThan(0);
		expect(result.bytes).toBeGreaterThan(0);
	});
});
