import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { mergeText } from '../src/merge';
import { PROFILE_SOURCES } from '../src/proxy-profile';
import { ruleDefinitionProblem } from '../src/derived';

export function profileInputs() {
  return PROFILE_SOURCES.map(([filename, label]) => ({ path: `/${filename}`, content: stringify({
    port: 9999, proxies: ['anytls', 'tuic', 'hysteria2', 'vmess', 'vless'].map(type => ({
      type, name: `${label}-${type}`, server: 'node.invalid', password: 'synthetic-test-value',
    })), 'proxy-groups': [{ name: 'discarded-source-group', type: 'select', proxies: ['DIRECT'] }], rules: ['MATCH,DIRECT'],
  }) }));
}
const rule = { outputName: 'merged-all.yaml', combination: 'proxy-profile' as const };

describe('the confirmed merged-all TypeScript profile', () => {
  it('preserves all nodes and creates 27 unique groups, correctly ordered, with one final global route', () => {
    const result = mergeText(rule, profileInputs());
    expect(result.ok).toBe(true);
    const doc = parse(result.content!);
    expect(doc.proxies).toHaveLength(40);
    expect(doc['proxy-groups']).toHaveLength(27);
    expect(new Set(doc['proxy-groups'].map((group: any) => group.name)).size).toBe(27);
    expect(doc.proxies.slice(0, 5).map((proxy: any) => proxy.name)).toEqual(['vless', 'vmess', 'hysteria2', 'tuic', 'anytls'].map(type => `bytevirt-ByteVirt-${type}`));
    expect(doc['proxy-groups'].map((group: any) => group.name)).toEqual([
      ...PROFILE_SOURCES.flatMap(([, label]) => [`⚖️${label} 负载均衡`, `⚡${label} 自动选择`]),
      '🌐全局自动选择测速', '🌐全局负载均衡', ...PROFILE_SOURCES.map(([, label]) => `📍${label} 选择`), '🌍选择代理节点',
    ]);
    const targets = new Set(['DIRECT', ...doc.proxies.map((proxy: any) => proxy.name), ...doc['proxy-groups'].map((group: any) => group.name)]);
    for (const group of doc['proxy-groups']) expect(group.proxies.every((name: string) => targets.has(name))).toBe(true);
    expect(doc['proxy-groups'][26].proxies).toHaveLength(51);
    expect(doc.rules).toEqual(['GEOIP,LAN,DIRECT', 'GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,🌍选择代理节点']);
    expect(doc.port).toBe(7890);
    expect(doc.dns['fake-ip-filter']).toHaveLength(12);
    expect(doc.proxies[0].password).toBe('synthetic-test-value');
  });
  it('is byte-deterministic regardless of stored source arrival order and accepts Windows source paths', () => {
    const sources = profileInputs().map(source => ({ ...source, path: `C:\\test${source.path.replaceAll('/', '\\')}` }));
    expect(mergeText(rule, sources).content).toBe(mergeText(rule, [...sources].reverse()).content);
  });
  it.each(['missing', 'ambiguous', 'duplicate-node', 'empty-proxies', 'dialer', 'bad-yaml'])('refuses %s without a replacement result', problem => {
    const sources = profileInputs();
    if (problem === 'missing') sources.pop();
    if (problem === 'ambiguous') sources[1].path = sources[0].path;
    if (problem === 'duplicate-node') { const doc = parse(sources[0].content); doc.proxies.push({ ...doc.proxies[0] }); sources[0].content = stringify(doc); }
    if (problem === 'empty-proxies') sources[0].content = 'proxies: []';
    if (problem === 'dialer') { const doc = parse(sources[0].content); doc.proxies[0]['dialer-proxy'] = 'discarded-source-group'; sources[0].content = stringify(doc); }
    if (problem === 'bad-yaml') sources[0].content = '[invalid';
    const result = mergeText(rule, sources);
    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    expect(result.problem).toBeTruthy();
  });
  it('rejects additional source naming instead of silently ignoring it', () => {
    expect(ruleDefinitionProblem({ ...rule, sources: [{ pattern: '/*.yaml' }], nameFromSource: { keys: ['proxies'], field: 'name' } }, [])).toMatch(/defines its own/);
  });
  it('qualifies same-named nodes across providers and rewrites an internal dialer with its node', () => {
    const sources = profileInputs();
    const doc = parse(sources[0].content);
    doc.proxies[0]['dialer-proxy'] = doc.proxies[1].name;
    sources[0].content = stringify(doc);
    sources[1].content = stringify({ proxies: [{ name: doc.proxies[1].name, type: 'tuic' }] });
    const result = mergeText(rule, sources);
    expect(result.ok).toBe(true);
    const output = parse(result.content!);
    const node = output.proxies.find((proxy: any) => proxy.name === 'bytevirt-' + doc.proxies[0].name);
    expect(node['dialer-proxy']).toBe('bytevirt-' + doc.proxies[1].name);
    expect(output.proxies.some((proxy: any) => proxy.name === 'dartnode-' + doc.proxies[1].name)).toBe(true);
  });
});
