# YAML naming and routing repair evidence

Retrieved 2026-10-08 (Asia/Shanghai). These are official Mihomo project documentation sources used
for the bounded proxy configuration handling in `src/merge.ts` (`nameDocument`, `ruleTarget`,
`mergeRoutingRules`, `proxyReferenceProblem`). This is not a complete Mihomo schema validator.

- [Routing rules](https://raw.githubusercontent.com/MetaCubeX/Meta-Docs/main/docs/config/rules/index.en.md):
  rules execute from top to bottom; MATCH is unconditional. SUB-RULE refers to a sub-rule, while
  ordinary rules have an outbound policy token. `no-resolve` and `src` are additional parameters.
- [Built-in policies](https://wiki.metacubex.one/config/proxies/built-in/): DIRECT, REJECT,
  REJECT-DROP, PASS, PASS-RULE and COMPATIBLE remain unchanged by naming.
- [dialer-proxy](https://wiki.metacubex.one/en/config/proxies/dialer-proxy/): an outbound proxy's
  dialer can reference a group or another outbound proxy, so renaming must update that field too.

Repository contract: naming runs within each source before structural union, preserving its machine
and path identity. The existing `nameFromSource` scope determines which list entries are renamed;
node names outside the scope remain unchanged. Static group members, routing action tokens,
sub-rule action tokens and proxy dialers follow that source's rename map. Ambiguous static names or
unresolved references refuse publication. Dynamic provider-expanded configuration and other
string/regex references are not generalized into arbitrary string substitution.

When merging multiple routing lists, specific rules keep their source/local order. One terminal
MATCH is selected using the saved source order (or deterministic fallback source order), placed at
the end, and conflicts are reported in preview/run notes. Disjoint sub-rule definitions survive;
incompatible definitions of the same sub-rule refuse rather than silently discard content.

Every selected input and every configured source pattern must contribute. Missing, blank or
comments-only/null YAML documents refuse a partial replacement. Successful reads remain bounded
by the existing 8 MiB aggregate limit. Preview notes report top-level list counts per source and
structurally removed duplicates. `linkbin-derived-v2` invalidates pre-repair output signatures so
unchanged source bytes still rebuild on the next successful collection/manual run.

The custom 27-group template and execution of user-submitted TS/Python remain outside this repair.
