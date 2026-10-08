/**
 * Bounded TypeScript processing for the operator's merged-all.yaml profile.
 * Called by mergeText (and therefore previews, manual runs and collection refreshes).
 * Only the eight named inputs contribute proxy nodes; credentials stay in those runtime inputs.
 * Source groups/settings are deliberately replaced by the confirmed target profile, never executed.
 */
import { parse, stringify } from 'yaml';
import type { MergeSource } from './merge';

export const PROFILE_SOURCES = [
  ['bytevirt.yaml', 'ByteVirt', 'bytevirt'], ['dartnode.yaml', 'DartNode', 'dartnode'], ['rabisu.yaml', 'Rabisu', 'rabisu'],
  ['56idc.yaml', '56IDC', '56idc'], ['yinyun.yaml', '荫云', 'yinyun'],
  ['racknerd.23.254.219.147.yaml', 'RackNerd 23.254.219.147', 'rn147'],
  ['racknerd.192.119.78.227.yaml', 'RackNerd 192.119.78.227', 'rn227'],
  ['racknerd.107.172.99.23.yaml', 'RackNerd 107.172.99.23', 'rn99'],
] as const;

const SETTINGS = {
  port: 7890, 'allow-lan': true, mode: 'rule', 'log-level': 'info', 'unified-delay': true,
  dns: {
    enable: true, listen: '0.0.0.0:1053', ipv6: true, 'prefer-h3': false, 'respect-rules': true,
    'use-system-hosts': false, 'cache-algorithm': 'arc', 'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter': ['+.lan', '+.local', '+.msftconnecttest.com', '+.msftncsi.com',
      'localhost.ptlogin2.qq.com', 'localhost.sec.qq.com', '+.in-addr.arpa', '+.ip6.arpa',
      'time.*.com', 'time.*.gov', 'pool.ntp.org', 'localhost.work.weixin.qq.com'],
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
    'proxy-server-nameserver': ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'],
  }, ipv6: true,
};
const TYPES = ['vless', 'vmess', 'hysteria2', 'tuic', 'anytls'];
const CHECK_URL = 'https://www.gstatic.com/generate_204';
type Proxy = Record<string, unknown> & { name: string; type: string };

export function buildProxyProfile(sources: MergeSource[]): { content: string; notes: string[] } {
  if (sources.length !== PROFILE_SOURCES.length) throw new Error('merged-all profile requires exactly the eight named source files');
  const all: Proxy[] = [];
  const providers: { label: string; names: string[] }[] = [];
  const names = new Set<string>(['DIRECT', 'REJECT', 'PASS', 'GLOBAL', 'REJECT-DROP', 'COMPATIBLE']);
  for (const [filename, label, prefix] of PROFILE_SOURCES) {
    const matches = sources.filter(source => source.path.split(/[\\/]/).pop() === filename);
    if (matches.length !== 1) throw new Error(`${filename} must match exactly one stored file; narrow the source host/path when ambiguous`);
    const document = parse(matches[0].content, { maxAliasCount: 100 });
    if (!document || !Array.isArray(document.proxies) || !document.proxies.length) throw new Error(`${filename} needs a non-empty proxies list`);
    const proxies: Proxy[] = document.proxies;
    const rename = new Map<string, string>();
    for (const proxy of proxies) {
      if (!proxy || typeof proxy !== 'object' || typeof proxy.name !== 'string' || !proxy.name.trim() || typeof proxy.type !== 'string') {
        throw new Error(`${filename} contains a proxy without a name/type`);
      }
      if (rename.has(proxy.name)) throw new Error(`${filename} contains duplicate proxy names`);
      rename.set(proxy.name, `${prefix}-${proxy.name}`);
    }
    for (const proxy of proxies) {
      proxy.name = rename.get(proxy.name)!;
      if (proxy['dialer-proxy'] !== undefined && rename.has(String(proxy['dialer-proxy']))) proxy['dialer-proxy'] = rename.get(String(proxy['dialer-proxy']));
      if (names.has(proxy.name)) throw new Error(`target proxy names must be unique: ${proxy.name}`);
      names.add(proxy.name);
    }
    // Fixed protocol order matches the existing target; unknown protocols retain source order.
    const rank = (proxy: Proxy) => TYPES.includes(proxy.type) ? TYPES.indexOf(proxy.type) : TYPES.length;
    proxies.sort((a, b) => rank(a) - rank(b));
    providers.push({ label, names: proxies.map(proxy => proxy.name) });
    all.push(...proxies);
  }
  const balance = (name: string, proxies: string[]) => ({ name, type: 'load-balance', proxies, url: CHECK_URL, interval: 300, strategy: 'round-robin' });
  const automatic = (name: string, proxies: string[]) => ({ name, type: 'url-test', proxies, url: CHECK_URL, interval: 300, tolerance: 50 });
  const groups: Record<string, unknown>[] = [];
  for (const provider of providers) {
    groups.push(balance(`⚖️${provider.label} 负载均衡`, provider.names), automatic(`⚡${provider.label} 自动选择`, provider.names));
  }
  const allNames = all.map(proxy => proxy.name);
  groups.push(automatic('🌐全局自动选择测速', allNames), balance('🌐全局负载均衡', allNames));
  for (const provider of providers) groups.push({ name: `📍${provider.label} 选择`, type: 'select',
    proxies: [`⚡${provider.label} 自动选择`, `⚖️${provider.label} 负载均衡`, ...provider.names] });
  groups.push({ name: '🌍选择代理节点', type: 'select', proxies: ['🌐全局自动选择测速', '🌐全局负载均衡',
    ...providers.map(provider => `📍${provider.label} 选择`), 'DIRECT', ...allNames] });
  for (const group of groups) {
    const name = String(group.name);
    if (names.has(name)) throw new Error(`proxy/group name collision: ${name}`);
    names.add(name);
  }
  // Dialers are preserved with nodes, so any reference to discarded source groups must be refused.
  for (const proxy of all) if (proxy['dialer-proxy'] !== undefined && !names.has(String(proxy['dialer-proxy']))) {
    throw new Error(`${proxy.name} refers to a dialer that is absent from the target profile`);
  }
  const content = stringify({ ...SETTINGS, proxies: all, 'proxy-groups': groups,
    rules: ['GEOIP,LAN,DIRECT', 'GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,🌍选择代理节点'],
  }, { aliasDuplicateObjects: false, lineWidth: 0 });
  return { content, notes: [`merged-all profile: ${all.length} nodes, ${groups.length} groups; target provider prefixes applied to nodes and references`] };
}
