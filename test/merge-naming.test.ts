import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { mergeText, sourceName, type MergeRule, type MergeSource } from '../src/merge';

/**
 * Naming entries after the source they came from.
 *
 * ## The case this exists for, in the operator's own data
 *
 * Every per-host configuration lists groups called `负载均衡`, `自动选择` and `选择` — **identical names
 * with different contents**. Merging them correctly still produces twenty-four groups with three names
 * between them and no way to tell which belongs to which machine. The operator's hand-merged file solves it
 * by renaming each group after its source and its type, and a declarative rule could not express that.
 *
 * ## Why the type is needed as well as the source
 *
 * Each source contains all three groups under the same key, so naming by source alone still collides three
 * ways. The distinguishing field within a source is `type` — `load-balance`, `url-test`, `select` — which is
 * exactly what the operator's symbols stand for.
 *
 * That detail was wrong in the first version of this reasoning, which named the groups after the provider
 * *type* (`hysteria2`, `tuic5`, `vless-reality-vision`, `vmess-ws`, `anytls`). Those are the nodes inside a
 * group, not the groups.
 */

const rule = (over: Partial<MergeRule> = {}): MergeRule => ({
	outputName: 'merged.yaml',
	combination: 'yaml-list-union',
	...over,
});

const src = (path: string, content: string): MergeSource => ({ path, content });

/** Two groups as a real per-host file lists them: same names, different types, one source. */
const HOST_A = `
proxies:
  - name: node-a1
    server: 203.0.113.1
proxy-groups:
  - name: 负载均衡
    type: load-balance
    proxies: [node-a1]
  - name: 自动选择
    type: url-test
    proxies: [node-a1]
`;

const HOST_B = `
proxies:
  - name: node-b1
    server: 198.51.100.1
proxy-groups:
  - name: 负载均衡
    type: load-balance
    proxies: [node-b1]
  - name: 自动选择
    type: url-test
    proxies: [node-b1]
`;

describe('naming a source', () => {
	it('uses the file name without its extension', () => {
		expect(sourceName('/sources/dartnode.yaml')).toBe('dartnode');
		expect(sourceName('/sources/racknerd.107.172.99.23.yaml')).toBe('racknerd.107.172.99.23');
	});

	it('does not leave a path in a field where a name belongs', () => {
		expect(sourceName('/a/b/c/bytevirt.yml')).not.toContain('/');
	});

	it('leaves a name with no extension alone', () => {
		expect(sourceName('/a/hostname')).toBe('hostname');
	});

	it('does not strip a dot that is part of the name', () => {
		// `racknerd.107.172.99.23` is an address, not an extension, and truncating it would collide with
		// another source of the same family.
		expect(sourceName('/a/racknerd.192.119.78.227.yaml')).toBe('racknerd.192.119.78.227');
	});
});

describe('renaming entries after their source', () => {
	it('makes entries from different sources distinguishable', () => {
		// Without this, the merged file has two groups called 负载均衡 and no way to tell them apart.
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'] } }),
			[src('/s/dartnode.yaml', HOST_A), src('/s/rabisu.yaml', HOST_B)],
		);

		expect(result.ok).toBe(true);
		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		const names = merged['proxy-groups'].map((g) => g.name);
		expect(names).toContain('dartnode 负载均衡');
		expect(names).toContain('rabisu 负载均衡');
		expect(new Set(names).size).toBe(names.length);
	});

	it('includes a second field so entries within one source stop colliding', () => {
		// One source holds all three groups under the same names, so the source alone is not enough.
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type' } }),
			[src('/s/dartnode.yaml', HOST_A), src('/s/rabisu.yaml', HOST_B)],
		);

		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		const names = merged['proxy-groups'].map((g) => g.name).sort();
		expect(names).toEqual([
			'dartnode load-balance 负载均衡',
			'dartnode url-test 自动选择',
			'rabisu load-balance 负载均衡',
			'rabisu url-test 自动选择',
		]);
	});

	it('applies the replacement map, which is how the operator gets their symbols', () => {
		const result = mergeText(
			rule({
				nameFromSource: {
					field: 'name', keys: ['proxy-groups'],
					includeField: 'type',
					replace: { 'load-balance': '⚖️', 'url-test': '⚡' },
				},
			}),
			[src('/s/dartnode.yaml', HOST_A)],
		);

		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		expect(merged['proxy-groups'].map((g) => g.name).sort()).toEqual(['dartnode ⚖️ 负载均衡', 'dartnode ⚡ 自动选择']);
	});

	it('uses a value with no replacement as it stands', () => {
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type', replace: { 'url-test': '⚡' } } }),
			[src('/s/dartnode.yaml', HOST_A)],
		);
		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		expect(merged['proxy-groups'].map((g) => g.name)).toContain('dartnode load-balance 负载均衡');
	});

	it('honours a separator and an order', () => {
		// The default puts the qualifiers first; `before` reverses them. Either way the entry's own value
		// stays last, so the name is still recognisable as the thing it was.
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type', separator: ' · ', order: 'before' } }),
			[src('/s/dartnode.yaml', HOST_A)],
		);
		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		expect(merged['proxy-groups'].map((g) => g.name)).toContain('load-balance · dartnode · 负载均衡');
	});

	it('leaves entries that are not objects alone', () => {
		// A list of plain strings is a legitimate document; rewriting must not turn it into objects.
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['rules'] } }),
			[src('/s/a.yaml', 'rules:\n  - MATCH,DIRECT\n')],
		);
		const merged = parseYaml(result.content!) as { rules: string[] };
		expect(merged.rules).toEqual(['MATCH,DIRECT']);
	});

	it('names an entry that has no name of its own, since there is nothing to preserve', () => {
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'] } }),
			[src('/s/a.yaml', 'proxy-groups:\n  - type: select\n')],
		);
		const merged = parseYaml(result.content!) as { 'proxy-groups': Record<string, unknown>[] };
		expect(merged['proxy-groups'][0].name).toBe('a');
	});

	it('does not rename entries outside the keys the rule names', () => {
		// The near-miss this scoping prevents: proxy NODES also carry a name, and the provider is already in
		// it. Renaming those would make forty node names worse while looking like the rule had worked. No
		// scope could be inferred from the data, which is why the rule must state it.
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'] } }),
			[src('/s/dartnode.yaml', HOST_A)],
		);
		const merged = parseYaml(result.content!) as { proxies: { name: string }[] };
		expect(merged.proxies[0].name).toBe('node-a1');
	});

	it('does not touch fields it was not asked to rewrite', () => {
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type' } }),
			[src('/s/dartnode.yaml', HOST_A)],
		);
		const merged = parseYaml(result.content!) as { 'proxy-groups': Record<string, unknown>[] };
		for (const group of merged['proxy-groups']) {
			expect(group.type === 'load-balance' || group.type === 'url-test').toBe(true);
		}
	});

	it('is deterministic across runs', () => {
		const sources = [src('/s/dartnode.yaml', HOST_A), src('/s/rabisu.yaml', HOST_B)];
		const one = mergeText(rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type' } }), sources);
		const two = mergeText(rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type' } }), sources);
		expect(one.content).toBe(two.content);
	});

	it('is byte-identical when the sources arrive in a different order', () => {
		// Renaming must not reintroduce the source-order dependence the union was built to remove.
		const naming = { field: 'name', keys: ['proxy-groups'], includeField: 'type' };
		const forwards = mergeText(rule({ nameFromSource: naming }), [src('/s/dartnode.yaml', HOST_A), src('/s/rabisu.yaml', HOST_B)]);
		const backwards = mergeText(rule({ nameFromSource: naming }), [src('/s/rabisu.yaml', HOST_B), src('/s/dartnode.yaml', HOST_A)]);
		expect(forwards.content).toBe(backwards.content);
	});

	it('refuses when the naming rule still leaves collisions', () => {
		// A partial fix that looks like a complete one is worse than no fix: the operator would ship a file
		// with duplicated group names and believe it was resolved.
		//
		// Two groups in ONE source with the same name, and no includeField to separate them, so both collapse
		// to the same new name. Naming by source alone cannot distinguish them and must say so.
		const sameTwice = 'proxy-groups:\n  - name: dup\n    type: select\n  - name: dup\n    url: https://example.invalid\n';
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'] } }),
			[src('/s/one.yaml', sameTwice)],
		);

		expect(result.ok).toBe(false);
		expect(result.content).toBeUndefined();
		expect(result.problem).toMatch(/duplicate|ambiguous/i);
	});

	it('does not warn about collisions when the rule separates every entry', () => {
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type' } }),
			[src('/s/dartnode.yaml', HOST_A), src('/s/rabisu.yaml', HOST_B)],
		);
		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		const names = merged['proxy-groups'].map((g) => g.name);
		expect(new Set(names).size).toBe(names.length);
		expect(result.notes.join(' ')).not.toMatch(/still share a name/i);
	});

	it('reports how many entries it renamed, so a rule that did nothing is visible', () => {
		const result = mergeText(
			rule({ nameFromSource: { field: 'name', keys: ['proxy-groups'], includeField: 'type' } }),
			[src('/s/dartnode.yaml', HOST_A)],
		);
		expect(result.notes.join(' ')).toMatch(/renamed 2 entries/);
	});

	it('does nothing when the rule does not ask for it', () => {
		const result = mergeText(rule(), [src('/s/dartnode.yaml', HOST_A), src('/s/rabisu.yaml', HOST_B)]);
		const merged = parseYaml(result.content!) as { 'proxy-groups': { name: string }[] };
		expect(merged['proxy-groups'].map((g) => g.name)).toContain('负载均衡');
		expect(result.notes.join(' ')).not.toMatch(/renamed/);
	});
});
