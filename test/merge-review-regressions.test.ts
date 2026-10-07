import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { mergeText, sourceName } from '../src/merge';
import { previewDerived, ruleDefinitionProblem, runDerived, type DerivedRuleDefinition, type StoredObject } from '../src/derived';

const naming = { field: 'name', keys: ['proxy-groups'], includeField: 'type' };
const namedRule = { outputName: 'merged.yaml', combination: 'yaml-list-union' as const, nameFromSource: naming };
const definition: DerivedRuleDefinition = { ...namedRule, sources: [{ pattern: '/etc/*.yaml' }] };
function config(node: string) {
    return stringify({ proxies: [{ name: node, type: 'direct' }], 'proxy-groups': [
        { name: 'auto', type: 'url-test', proxies: [node, 'DIRECT'] },
        { name: 'pick', type: 'select', proxies: ['auto', node] },
    ], rules: ['DOMAIN,example.org,pick,no-resolve', 'MATCH,pick'] });
}
function assertReferences(document: Record<string, any>) {
    const groups = document['proxy-groups'];
    const names = new Set([...document.proxies.map((node: any) => node.name), ...groups.map((group: any) => group.name), 'DIRECT']);
    expect(new Set(groups.map((group: any) => group.name)).size).toBe(groups.length);
    for (const group of groups) for (const reference of group.proxies) expect(names.has(reference), reference).toBe(true);
    for (const rule of document.rules) {
        const parts = rule.split(',');
        const target = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1);
        expect(names.has(target), target).toBe(true);
    }
}
function stored(id: number, hostId: string, path: string): StoredObject {
    return { id, hostId, path, objectKey: `${hostId}${path}`, sizeBytes: 1, contentHash: `hash-${id}` };
}

describe('review: source-aware YAML naming', () => {
    it('rewrites source-local group references and routing targets without renaming nodes', () => {
        const sources = [{ path: '/etc/a.yaml', content: config('node-a') }, { path: '/etc/b.yaml', content: config('node-b') }];
        const result = mergeText(namedRule, sources);
        expect(result.ok, result.problem).toBe(true);
        const document = parse(result.content!);
        assertReferences(document);
        expect(document.proxies.map((node: any) => node.name)).toEqual(['node-a', 'node-b']);
        const pickA = document['proxy-groups'].find((group: any) => group.name === 'a select pick');
        expect(pickA.proxies).toEqual(['a url-test auto', 'node-a']);
        expect(document.rules).toContain('DOMAIN,example.org,a select pick,no-resolve');
        expect(result.notes.join(' ')).not.toMatch(/not renamed|still share/);
        expect(mergeText(namedRule, [...sources].reverse()).content).toBe(result.content);
    });

    it('retains identical named definitions from different sources before updating their references', () => {
        const content = 'proxy-groups: [{name: auto, type: select, proxies: [DIRECT]}]\nrules: ["MATCH,auto"]\n';
        const result = mergeText(namedRule, [{ path: '/a.yaml', content }, { path: '/b.yaml', content }]);
        expect(result.ok, result.problem).toBe(true);
        const document = parse(result.content!);
        expect(document['proxy-groups'].map((group: any) => group.name)).toEqual(['a select auto', 'b select auto']);
        expect(document.rules).toEqual(['MATCH,a select auto']);
    });

    it('keeps host identity when two hosts collect the same path', () => {
        const objects = [stored(1, 'host-a', '/etc/config.yaml'), stored(2, 'host-b', '/etc/config.yaml')];
        const outcome = runDerived(definition, objects, new Map([[1, config('node-a')], [2, config('node-b')]]));
        expect(outcome.ok, outcome.problem).toBe(true);
        const document = parse(outcome.content!);
        assertReferences(document);
        expect(document['proxy-groups'].filter((group: any) => group.name.includes('host-a'))).toHaveLength(2);
        expect(document['proxy-groups'].filter((group: any) => group.name.includes('host-b'))).toHaveLength(2);
    });

    it('refuses ambiguous names in one source instead of guessing the intended reference', () => {
        const content = 'proxy-groups: [{name: dup, type: select, proxies: [DIRECT]}, {name: dup, type: url-test, proxies: [DIRECT]}]\nrules: ["MATCH,dup"]\n';
        const result = mergeText(namedRule, [{ path: '/a.yaml', content }]);
        expect(result.ok).toBe(false);
        expect(result.content).toBeUndefined();
        expect(result.problem).toMatch(/ambiguous|duplicate|collision/i);
    });

    it('handles Windows source paths without leaking directories into names', () => {
        expect(sourceName('C:\\sources\\dartnode.yaml')).toBe('dartnode');
    });

    it('updates dialer and sub-rule policies while keeping SUB-RULE and built-in policies intact', () => {
        const content = stringify({ proxies: [{ name: 'node', 'dialer-proxy': 'auto' }], 'proxy-groups': [{ name: 'auto', type: 'select', proxies: ['DIRECT'] }], rules: ['SUB-RULE,(NETWORK,tcp),tcp-rules', 'MATCH,auto'], 'sub-rules': { 'tcp-rules': ['DOMAIN,a.test,auto,no-resolve', 'MATCH,PASS-RULE'] } });
        const result = mergeText(namedRule, [{ path: '/a.yaml', content }]);
        expect(result.ok, result.problem).toBe(true);
        const document = parse(result.content!);
        expect(document.proxies[0]['dialer-proxy']).toBe('a select auto');
        expect(document.rules[0]).toBe('SUB-RULE,(NETWORK,tcp),tcp-rules');
        expect(document['sub-rules']['tcp-rules']).toEqual(['DOMAIN,a.test,a select auto,no-resolve', 'MATCH,PASS-RULE']);
    });

    it('keeps rule priority instead of sorting an early MATCH ahead of other sources', () => {
        const rule = { ...namedRule, nameFromSource: undefined };
        const result = mergeText(rule, [{ path: '/a.yaml', content: 'rules: ["PROCESS-NAME,app,DIRECT", "MATCH,REJECT"]\n' }]);
        expect(parse(result.content!).rules).toEqual(['PROCESS-NAME,app,DIRECT', 'MATCH,REJECT']);
    });

    it('reports per-source list counts and removed duplicate counts in the preview notes', () => {
        const result = mergeText({ ...namedRule, nameFromSource: undefined }, [{ path: '/a.yaml', content: 'items: [a, b]\n' }, { path: '/b.yaml', content: 'items: [a, c]\n' }]);
        expect(result.notes).toContain('/a.yaml: 2 list entries');
        expect(result.notes).toContain('/b.yaml: 2 list entries');
        expect(result.notes).toContain('1 duplicate list entries removed; 3 retained');
    });

    it('does not let an earlier source catch-all shadow later source-specific policies', () => {
        const result = mergeText(namedRule, [
            { path: '/a.yaml', content: 'proxy-groups: [{name: pick, type: select, proxies: [DIRECT]}]\nrules: ["MATCH,pick"]\n' },
            { path: '/b.yaml', content: 'proxy-groups: [{name: pick, type: select, proxies: [DIRECT]}]\nrules: ["DOMAIN,example.org,pick", "MATCH,pick"]\n' },
        ]);
        expect(result.ok, result.problem).toBe(true);
        expect(parse(result.content!).rules).toEqual(['DOMAIN,example.org,b select pick', 'MATCH,a select pick']);
        expect(result.notes.join(' ')).toMatch(/conflicting MATCH.*source order/);
    });

    it('merges disjoint sub-rule maps and refuses missing or incompatible targets', () => {
        const result = mergeText(namedRule, [
            { path: '/a.yaml', content: 'sub-rules: {a: ["MATCH,DIRECT"]}\nrules: ["SUB-RULE,(NETWORK,tcp),a"]\n' },
            { path: '/b.yaml', content: 'sub-rules: {b: ["MATCH,REJECT"]}\nrules: ["SUB-RULE,(NETWORK,udp),b"]\n' },
        ]);
        expect(result.ok, result.problem).toBe(true);
        expect(Object.keys(parse(result.content!)['sub-rules'])).toEqual(['a', 'b']);
        expect(mergeText(namedRule, [{ path: '/a.yaml', content: 'rules: ["SUB-RULE,(NETWORK,tcp),missing"]\n' }]).ok).toBe(false);
        const conflict = mergeText(namedRule, [{ path: '/a.yaml', content: 'sub-rules: {a: ["MATCH,DIRECT"]}\n' }, { path: '/b.yaml', content: 'sub-rules: {a: ["MATCH,REJECT"]}\n' }]);
        expect(conflict.ok).toBe(false);
        expect(conflict.problem).toMatch(/conflicting sub-rule/);
    });
});

describe('review: derived contracts', () => {
    it('honors saved ordering for concatenation and conflicting scalar precedence', () => {
        const objects = [stored(1, 'host', '/etc/a.yaml'), stored(2, 'host', '/etc/b.yaml')];
        const ordered = { ...definition, combination: 'concat' as const, order: ['/etc/b.yaml', '/etc/a.yaml'] };
        const texts = new Map([[1, 'A'], [2, 'B']]);
        expect(runDerived(ordered, objects, texts).content).toBe('B\nA\n');
        const yamlTexts = new Map([[1, 'mode: a\n'], [2, 'mode: b\n']]);
        const union = runDerived({ ...ordered, combination: 'yaml-list-union' }, objects, yamlTexts);
        expect(parse(union.content!).mode).toBe('b');
    });

    it.each([
        { field: '', keys: ['proxy-groups'] },
        { keys: ['proxy-groups'] },
        { field: 'name', keys: [] },
        { field: 'name', keys: [7] },
        { field: 'name', keys: ['proxy-groups'], order: 'sideways' },
        { field: 'name', keys: ['proxy-groups'], replace: { select: 7 } },
    ])('refuses malformed naming configuration %# at definition time', nameFromSource => {
        const problem = ruleDefinitionProblem({ ...definition, nameFromSource } as DerivedRuleDefinition, []);
        expect(problem).toMatch(/name|naming|field|keys|order|replace/i);
    });

    it('does not publish a partial merge when one required source pattern disappears', () => {
        const required = { ...definition, combination: 'concat' as const, sources: [{ pattern: '/etc/a.yaml' }, { pattern: '/etc/b.yaml' }] };
        const objects = [stored(1, 'host', '/etc/a.yaml')];
        const contents = new Map([[1, 'A']]);
        const result = runDerived(required, objects, contents);
        expect(result.ok).toBe(false);
        expect(result.content).toBeUndefined();
        expect(result.problem).toContain('/etc/b.yaml');
        expect(previewDerived(required, objects, contents).ok).toBe(false);
    });

    it.each(['', '# only a comment\n', 'null\n'])('refuses a selected empty document: %j', content => {
        const result = mergeText(namedRule, [{ path: '/a.yaml', content: 'proxies: [{name: a}]\n' }, { path: '/b.yaml', content }]);
        expect(result.ok).toBe(false);
        expect(result.content).toBeUndefined();
        expect(result.problem).toMatch(/empty/i);
    });
});

describe('review: structural comparison preserves YAML data', () => {
    it('preserves own __proto__ keys both at the top level and inside lists', () => {
        const sources = [{ path: '/a.yaml', content: '__proto__: {global: yes}\nitems: [{__proto__: {x: 1}}]\n' }, { path: '/b.yaml', content: 'items: [{__proto__: {x: 2}}]\n' }];
        const result = mergeText({ ...namedRule, nameFromSource: undefined }, sources);
        expect(result.ok, result.problem).toBe(true);
        const document = parse(result.content!);
        expect(Object.hasOwn(document, '__proto__')).toBe(true);
        expect(document.items).toHaveLength(2);
    });

    it('does not confuse a tagged number with an ordinary mapping containing the same tag text', () => {
        const result = mergeText({ ...namedRule, nameFromSource: undefined }, [{ path: '/a.yaml', content: 'items: [.nan, {$number: NaN}]\n' }]);
        expect(result.ok, result.problem).toBe(true);
        expect(parse(result.content!).items).toHaveLength(2);
    });
});
