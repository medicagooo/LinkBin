/**
 * The merge engine: several stored files combined into one, by configuration.
 *
 * ## Why configuration and not a script
 *
 * The obvious way to "process files with a rule" is to run a supplied script. That was considered and
 * rejected in ADR-0003: this isolate holds every stored machine credential and the master key, so a
 * sandbox escape means every collected machine rather than one bad output — and this project has already
 * had one temporary diagnostic capability become a live exposure. What follows is therefore data, not
 * code. The accepted cost is that a transformation the operators cannot express is impossible; the
 * remedy is to add a bounded operation with its own tests, never an execution hatch.
 *
 * ## Why this file is pure
 *
 * Nothing here reads a database, a bucket or a machine. That is deliberate: the rules that matter are
 * where a quiet mistake produces a file that looks fine, and those are cheaper to pin down without
 * storage in the way.
 *
 * ## The three quiet failures this exists to prevent
 *
 *   - **Non-deterministic output.** Two runs of an unchanged merge must produce identical bytes, or
 *     "did this change" becomes unanswerable and every run looks like a change.
 *   - **Mixed line endings.** One Windows-authored source and one Unix source must not combine into a
 *     file that tools reading it will trip over.
 *   - **A failed merge overwriting a good result.** If sources are missing or empty, the previous
 *     derived object must survive. An "empty merge" that replaces a real file is worse than a failure,
 *     because it is silent.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface MergeSource {
	/** Where the content came from, as shown to the operator. */
	path: string;
	/** Stable machine identity distinguishes equal remote paths; omitted by older pure-engine callers. */
	hostId?: string;
	content: string;
	/** Content hash, when known. Recorded so "is this derived object current" is decidable. */
	hash?: string;
}

/** How the sources are combined. Each is a named, bounded operation. */
export type Combination =
	/** Join the sources in order, separated by a blank line. */
	| 'concat'
	/** Parse every source as a document and union the list-valued top-level keys, removing duplicates. */
	| 'yaml-list-union';

/**
 * A field to rewrite using where an entry came from.
 *
 * This is the operator that makes a union of several documents **usable** rather than merely correct. The
 * real case: every source lists groups named `负载均衡`, `自动选择` and `选择`, identical names with
 * different contents, so a merged file has twenty-four groups with three names between them and no way to
 * tell which is which. The operator's hand-merged file avoids that by renaming each group after its source
 * and its type, and a declarative rule could not express it — which is why this exists.
 *
 * Declarative, not code (ADR-0003): a field name, a separator and whether to include a second field. If a
 * transformation cannot be expressed this way, the answer is another bounded operator with its own tests,
 * never an execution hatch.
 */
export interface NameFromSource {
	/** The field to rewrite, for example `name`. */
	field: string;
	/**
	 * Which top-level keys to rewrite. **Required**, and the reason is a real near-miss.
	 *
	 * Without a scope this operator rewrites *every* list entry that happens to carry the field. In the real
	 * configuration, individual proxy nodes also have a `name`, so the provider name is already in it
	 * (`vless-reality-vision-node.dartnode.com`) — and renaming those too would have made forty node names
	 * worse while looking like it had done its job. Only `proxy-groups` should be renamed, and saying so is
	 * the rule's business rather than something inferred.
	 */
	keys: string[];
	/** Placed between the parts. Defaults to a single space. */
	separator?: string;
	/**
	 * A second field to include, for example `type`.
	 *
	 * Needed because one source usually contains several entries that share a name and differ only by type —
	 * three proxy groups called `负载均衡`, `自动选择` and `选择`, distinguished by `load-balance`,
	 * `url-test` and `select`. Naming by source alone would still collide.
	 */
	includeField?: string;
	/** Where the qualifiers go relative to the entry's own value. Defaults to `after`. */
	order?: 'before' | 'after';
	/**
	 * Rewrites a qualifier value before it is used, for example mapping `load-balance` to a symbol.
	 * Keys are the exact values; anything absent is used as-is.
	 */
	replace?: Record<string, string>;
}

export interface MergeRule {
	outputName: string;
	combination: Combination;
	/** Preferred stored paths; remaining sources follow in deterministic order. */
	order?: string[];
	/** Hash of the source set and this rule, for deciding whether a stored result is current. */
	signature?: string;
	/** Rewrite a field using its source's name, so entries from different sources stay distinguishable. */
	nameFromSource?: NameFromSource;
}

export interface MergeResult {
	ok: boolean;
	/** Absent whenever `ok` is false — a failed merge must have nothing to store. */
	content?: string;
	bytes?: number;
	sourceCount: number;
	sourceBytes: number;
	/** Things worth saying that are not failures, such as a source that was empty. */
	notes: string[];
	problem?: string;
}

export interface MergePreview {
	ok: boolean;
	outputName: string;
	sourceCount: number;
	sourceBytes: number;
	/** Estimated output size. Exact for `concat`, and reported after building for structured merges. */
	bytes?: number;
	notes: string[];
	problem?: string;
}

/**
 * Converts every line ending to LF.
 *
 * Lone `\r` is handled as well as `\r\n`, because an old Mac-authored file would otherwise leave a
 * stray carriage return that some tools treat as a line break and others as content.
 */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * Puts sources in a deterministic order.
 *
 * Sorted by path unless an explicit order is given. The explicit order is applied first and anything it
 * omits is appended, still sorted — a stated order must never silently *drop* a source, since a missing
 * file in the output is harder to notice than an unexpected position.
 *
 * Sorting by code unit rather than by locale: a locale-aware comparison can differ between runtimes, and
 * the entire point is that two runs produce identical bytes.
 */
export function orderSources(sources: MergeSource[], explicitOrder?: string[]): MergeSource[] {
	/**
	 * Path first, then content, and the second key is a real fix rather than a formality.
	 *
	 * Two sources can share a path — a rule listing the same file twice, or sources identified by the path they
	 * were collected from rather than by file name. Sorting by path alone leaves those in arrival order, which
	 * silently reintroduces the order-dependence this function exists to remove: an adversarial audit showed
	 * `concat` producing `A\nB\n` from one arrival order and `B\nA\n` from the other, and a conflicting scalar
	 * resolving to a different source each time.
	 *
	 * Content is the tie-break because it is the only property of a source that is stable across runs and
	 * independent of when it arrived. Two genuinely identical sources remain interchangeable, which is correct:
	 * they contribute the same bytes, so their order cannot change the output.
	 */
	const byPathThenContent = (a: MergeSource, b: MergeSource): number => {
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		if (a.hostId !== b.hostId) return (a.hostId ?? '') < (b.hostId ?? '') ? -1 : 1;
		if (a.content !== b.content) return a.content < b.content ? -1 : 1;
		return 0;
	};
	const sorted = [...sources].sort(byPathThenContent);

	if (!explicitOrder || explicitOrder.length === 0) return sorted;

	const rank = new Map(explicitOrder.map((path, index) => [path, index]));
	return sorted.sort((a, b) => {
		const ra = rank.get(a.path);
		const rb = rank.get(b.path);
		if (ra !== undefined && rb !== undefined) return ra - rb || byPathThenContent(a, b);
		if (ra !== undefined) return -1;
		if (rb !== undefined) return 1;
		return byPathThenContent(a, b);
	});
}

/** Removes trailing newlines so the separator, not the source, decides the spacing. */
function trimTrailingNewlines(text: string): string {
	return text.replace(/\n+$/, '');
}

/**
 * Combines the sources.
 *
 * `expectedPaths` is what the rule *says* its sources are. When given, a path that produced no content
 * is a failure rather than a silent omission: a source that has been deleted or renamed must not quietly
 * vanish from the result.
 */
export function mergeText(rule: MergeRule, sources: MergeSource[], options: { expectedPaths?: string[] } = {}): MergeResult {
	const notes: string[] = [];
	const ordered = orderSources(sources, rule.order);
	if (rule.nameFromSource !== undefined) {
		const problem = nameFromSourceProblem(rule.nameFromSource);
		if (problem) return { ok: false, sourceCount: ordered.length, sourceBytes: 0, notes, problem };
	}

	const missing = (options.expectedPaths ?? []).filter((path) => !ordered.some((s) => s.path === path));
	if (missing.length > 0) {
		return {
			ok: false,
			sourceCount: ordered.length,
			sourceBytes: 0,
			notes,
			problem: `these sources produced nothing, so the previous result is kept rather than replaced: ${missing.join(', ')}`,
		};
	}

	if (ordered.length === 0) {
		return {
			ok: false,
			sourceCount: 0,
			sourceBytes: 0,
			notes,
			problem: 'no sources matched, so there is nothing to merge; the previous result is kept',
		};
	}

	const normalized = ordered.map((s) => ({ ...s, content: normalizeLineEndings(s.content) }));
	const sourceBytes = normalized.reduce((total, s) => total + byteLength(s.content), 0);

	const empty = normalized.filter((s) => s.content.trim().length === 0);
	if (empty.length > 0) {
		return {
			ok: false,
			sourceCount: normalized.length,
			sourceBytes,
			notes,
			problem: `these sources were empty: ${empty.map(s => s.path).join(', ')}; the previous result is kept rather than replaced with a partial merge`,
		};
	}

	const usable = normalized.filter((s) => s.content.trim().length > 0);

	let content: string;
	if (rule.combination === 'yaml-list-union') {
		try {
			const structured = unionDocuments(usable, rule.nameFromSource);
			if (!structured.ok) {
				return { ok: false, sourceCount: normalized.length, sourceBytes, notes, problem: structured.problem };
			}
			notes.push(...structured.notes);
			content = structured.content;
		} catch (err) {
			// Canonicalising a cyclic document throws by design, so the refusal happens here. Without this the
			// whole function raised `RangeError` — the one place in this module that failed by crashing rather
			// than by explaining, which leaves the caller unable to keep the previous derived object.
			//
			// The sources are named, because "these sources could not be combined" without saying WHICH is only
			// marginally better than the crash: the operator still has to find out by bisection.
			return {
				ok: false,
				sourceCount: normalized.length,
				sourceBytes,
				notes,
				problem: `${usable.map((s) => s.path).join(', ')} could not be combined (${(err as Error).message}), so the previous result is kept`,
			};
		}
	} else {
		content = usable.map((s) => trimTrailingNewlines(s.content)).join('\n') + '\n';
	}

	return {
		ok: true,
		content,
		bytes: byteLength(content),
		sourceCount: normalized.length,
		sourceBytes,
		notes,
	};
}

/** Byte length, which is not string length for anything non-ASCII. */
function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * The name of a source, as used when rewriting a field.
 *
 * The file's base name without its extension: `racknerd.107.172.99.23.yaml` becomes
 * `racknerd.107.172.99.23`. The whole path would be unusable in a field, and the directory is the same for
 * every source anyway.
 */
export function sourceName(path: string): string {
	const base = path.split(/[\\/]/).pop() ?? path;
	return base.replace(/\.(ya?ml|json|txt|conf|cfg)$/i, '');
}

/**
 * Rewrites a field on each entry using the source it came from.
 *
 * `nameDocument` calls this on each parsed source before union, preserving source-local identity and
 * references even when definitions in different files are structurally identical. The optional labels
 * disambiguate equal filenames on different machines; older direct callers keep basename naming.
 *
 * An entry whose source is unknown is left alone rather than given a name built from nothing: a field that
 * says `undefined 负载均衡` is worse than one that says `负载均衡`, because it looks deliberate.
 */
export function applyNameFromSource(
	out: Record<string, unknown>,
	provenance: Map<string, string>,
	rule: NameFromSource,
	sourceNames?: ReadonlyMap<string, string>,
): { rewritten: number; skipped: number } {
	const separator = rule.separator ?? ' ';
	const scope = new Set(rule.keys);
	let rewritten = 0;
	let skipped = 0;

	// The union orders keys alphabetically, so the output order stays deterministic whether or not this
	// operator runs — which is what makes an unchanged merge produce identical bytes.
	for (const key of Object.keys(out).sort()) {
		// Only the keys the rule names. Everything else is left exactly as it was.
		if (!scope.has(key)) continue;

		const value = out[key];
		if (!Array.isArray(value)) continue;

		out[key] = value.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
			const record = Object.assign(Object.create(null), entry) as Record<string, unknown>;

			// An entry whose source cannot be determined is left alone. Naming it from nothing would produce a
			// field that looks deliberate and says nothing true.
			//
			// The key includes the list it is in, and that is a fix from an adversarial audit. Keyed by canonical
			// form alone, two entries in DIFFERENT lists that happen to look alike shared one provenance slot, so
			// whichever source was recorded last won — and an entry could be renamed after a source that never
			// contributed it, producing `b g` where `a g` was correct. An entry's identity includes where it is.
			const source = provenance.get(`${key}\u0000${canonicalForm(entry)}`);
			if (!source) {
				skipped += 1;
				return record;
			}

			// The entry's OWN value is kept at the end when it has one, so the result stays recognisable as the
			// thing it was: `负载均衡` becomes `dartnode load-balance 负载均衡` rather than a name with its
			// identity swapped out for the provider. An entry with no value of its own — a group that was never
			// named — takes the qualifiers alone, because the rule is only applied to keys it was told to
			// rewrite, so leaving it untouched would defeat the point of naming it.
			const own = record[rule.field] === undefined ? null : String(record[rule.field]);
			const parts: string[] = [];
			const sourcePart = sourceNames?.get(source) ?? sourceName(source);
			const typePart = rule.includeField ? renderPart(record[rule.includeField], rule.replace) : null;

			const qualifiers = typePart === null ? [sourcePart] : rule.order === 'before' ? [typePart, sourcePart] : [sourcePart, typePart];
			parts.push(...qualifiers);
			// The entry's own value goes last when it has one, so the qualifiers read as a prefix and the
			// original name stays intact at the end of it.
			if (own !== null) parts.push(own);

			record[rule.field] = parts.join(separator);
			rewritten += 1;
			return record;
		});
	}

	return { rewritten, skipped };
}

/** Renders a field's value for use in a name, applying the replacement map when there is one. */
function renderPart(value: unknown, replace?: Record<string, string>): string | null {
	if (value === undefined || value === null) return null;
	const text = String(value);
	if (replace && Object.prototype.hasOwnProperty.call(replace, text)) return replace[text];
	return text;
}

/** Definition-time validation is shared by HTTP-backed rules and older direct engine callers. */
export function nameFromSourceProblem(value: unknown): string | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return 'nameFromSource must be a naming object';
	const rule = value as Record<string, unknown>;
	const field = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
	if (!field(rule.field)) return 'the naming field must be a non-empty string';
	if (!Array.isArray(rule.keys) || rule.keys.length === 0 || !rule.keys.every(field)) return 'naming keys must be a non-empty list of field names';
	if (rule.includeField !== undefined && !field(rule.includeField)) return 'the naming includeField must be a non-empty string';
	if (rule.separator !== undefined && typeof rule.separator !== 'string') return 'the naming separator must be a string';
	if (rule.order !== undefined && rule.order !== 'before' && rule.order !== 'after') return 'the naming order must be before or after';
	if (rule.replace !== undefined && (!rule.replace || typeof rule.replace !== 'object' || Array.isArray(rule.replace) || !Object.values(rule.replace).every(value => typeof value === 'string'))) return 'the naming replace map must contain string values';
	return null;
}

/** Keep legacy names for unique basenames; qualify ambiguous basenames by machine/path. */
function namingLabel(source: MergeSource, sources: MergeSource[]): string {
	const base = sourceName(source.path);
	const identity = (entry: MergeSource) => JSON.stringify([entry.hostId ?? '', entry.path]);
	const peers = sources.filter(entry => sourceName(entry.path) === base);
	if (new Set(peers.map(identity)).size < 2) return base;
	if (source.hostId && new Set(peers.filter(entry => entry.hostId === source.hostId).map(identity)).size === 1) return `${base} [${source.hostId}]`;
	return `${base} [${source.hostId ? `${source.hostId}:` : ''}${source.path}]`;
}

/**
 * Rename within each parsed source BEFORE union so identical definitions from different machines
 * retain their identity. Only the existing proxy configuration name operator has known references:
 * group members and the action token of routing rules. Other strings/settings are never substituted.
 */
function nameDocument(document: Record<string, unknown>, source: MergeSource, sources: MergeSource[], rule: NameFromSource): { document: Record<string, unknown>; rewritten: number } {
	const out = Object.assign(Object.create(null), document) as Record<string, unknown>;
	const provenance = new Map<string, string>();
	for (const key of rule.keys) for (const entry of Array.isArray(out[key]) ? out[key] as unknown[] : []) provenance.set(`${key}\u0000${canonicalForm(entry)}`, source.path);
	const { rewritten } = applyNameFromSource(out, provenance, rule, new Map([[source.path, namingLabel(source, sources)]]));
	if (rule.field !== 'name' || !rule.keys.some(key => key === 'proxy-groups' || key === 'proxies')) return { document: out, rewritten };
	const renames = new Map<string, string>();
	for (const key of rule.keys.filter(key => key === 'proxy-groups' || key === 'proxies')) {
		const before = Array.isArray(document[key]) ? document[key] as Record<string, unknown>[] : [];
		const after = out[key] as Record<string, unknown>[];
		for (let index = 0; index < before.length; index++) {
			const oldName = before[index]?.name;
			const newName = after[index]?.name;
			if (typeof oldName !== 'string' || typeof newName !== 'string') continue;
			if (renames.has(oldName) && renames.get(oldName) !== newName) throw new Error(`${source.path} has ambiguous duplicate name ${oldName}`);
			renames.set(oldName, newName);
		}
	}
	const target = (value: unknown) => typeof value === 'string' ? renames.get(value) ?? value : value;
	if (Array.isArray(out['proxy-groups'])) out['proxy-groups'] = (out['proxy-groups'] as Record<string, unknown>[]).map(group => group && typeof group === 'object' && Array.isArray(group.proxies) ? { ...group, proxies: group.proxies.map(target) } : group);
	if (Array.isArray(out.proxies)) out.proxies = out.proxies.map(proxy => proxy && typeof proxy === 'object' && typeof proxy['dialer-proxy'] === 'string' ? { ...proxy, 'dialer-proxy': target(proxy['dialer-proxy']) } : proxy);
	// no-resolve is a modifier; SUB-RULE targets a sub-rule name rather than an outbound policy.
	const rewriteRule = (rule: unknown) => {
		if (typeof rule !== 'string') return rule;
		const position = ruleTarget(rule);
		if (!position) return rule;
		position.parts[position.index] = position.parts[position.index].replace(/\S(?:.*\S)?/, value => String(target(value)));
		return position.parts.join(',');
	};
	if (Array.isArray(out.rules)) out.rules = out.rules.map(rewriteRule);
	if (out['sub-rules'] && typeof out['sub-rules'] === 'object' && !Array.isArray(out['sub-rules'])) {
		out['sub-rules'] = Object.fromEntries(Object.entries(out['sub-rules']).map(([key, rules]) => [key, Array.isArray(rules) ? rules.map(rewriteRule) : rules]));
	}
	return { document: out, rewritten };
}

function ruleTarget(rule: string): { parts: string[]; index: number } | null {
	const parts = rule.split(',');
	if (parts[0].trim() === 'SUB-RULE') return null;
	let index = parts.length - 1;
	while (index > 0 && ['no-resolve', 'src'].includes(parts[index].trim())) index--;
	return index > 0 ? { parts, index } : null;
}

/** Source precedence decides conflicts, but a source's terminal MATCH cannot shadow later specifics. */
function mergeRoutingRules(rules: unknown[], notes: string[]): unknown[] {
	const terminal = rules.filter(rule => typeof rule === 'string' && rule.split(',')[0].trim() === 'MATCH');
	if (terminal.length === 0) return rules;
	if (terminal.length > 1) notes.push(`conflicting MATCH fallback policies resolved by source order: kept ${terminal[0]}, ignored ${terminal.slice(1).join('; ')}`);
	return [...rules.filter(rule => !(typeof rule === 'string' && rule.split(',')[0].trim() === 'MATCH')), terminal[0]];
}

/** Refuse unresolved/ambiguous references rather than publishing syntactically valid broken YAML. */
function proxyReferenceProblem(document: Record<string, unknown>): string | null {
	const names = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'PASS-RULE', 'GLOBAL', 'COMPATIBLE']);
	for (const key of ['proxies', 'proxy-groups']) for (const entry of Array.isArray(document[key]) ? document[key] as Record<string, unknown>[] : []) {
		if (!entry || typeof entry.name !== 'string') continue;
		if (names.has(entry.name)) return `duplicate or reserved proxy name ${entry.name}`;
		names.add(entry.name);
	}
	for (const group of Array.isArray(document['proxy-groups']) ? document['proxy-groups'] as Record<string, unknown>[] : []) {
		for (const reference of Array.isArray(group?.proxies) ? group.proxies : []) if (typeof reference === 'string' && !names.has(reference)) return `proxy group ${group.name} references missing name ${reference}`;
	}
	for (const proxy of Array.isArray(document.proxies) ? document.proxies as Record<string, unknown>[] : []) {
		if (typeof proxy?.['dialer-proxy'] === 'string' && !names.has(proxy['dialer-proxy'])) return `proxy ${proxy.name} references missing dialer ${proxy['dialer-proxy']}`;
	}
	const subRules = document['sub-rules'] && typeof document['sub-rules'] === 'object' ? Object.values(document['sub-rules']).filter(Array.isArray).flat() : [];
	for (const rule of [...(Array.isArray(document.rules) ? document.rules : []), ...subRules]) {
		if (typeof rule !== 'string') continue;
		const tokens = rule.split(',');
		if (tokens[0].trim() === 'SUB-RULE') {
			const target = tokens.at(-1)?.trim();
			if (!target || !document['sub-rules'] || !Object.hasOwn(document['sub-rules'], target)) return `routing rule references missing sub-rule ${target}`;
			continue;
		}
		const position = ruleTarget(rule);
		const target = position?.parts[position.index]?.trim();
		if (target && !names.has(target)) return `routing rule references missing name ${target}`;
	}
	return null;
}

/**
 * Unions list-valued top-level keys across documents, removing duplicates.
 *
 * The comparison is **structural, not textual**: two entries that differ only in key order, quoting or
 * indentation are the same entry, and comparing their text would keep both. Canonical JSON is used as
 * the comparison form because it sorts keys, which makes it stable across sources authored differently.
 *
 * Ordinary list entries sort by canonical form. Routing rules preserve configured source/local priority,
 * with one terminal MATCH chosen by source precedence and placed after all specific rules. Conflicts
 * are reported. Disjoint sub-rule mappings are preserved; incompatible same-name definitions refuse.
 *
 * A key that is **absent** from some sources is contributed by the ones that have it. Losing it because
 * the first source happened not to mention it was a real defect, found by running this against the
 * operator's own files: a top-level setting present in one source and absent from the first vanished from
 * the output with no warning at all. **Absence is not disagreement.**
 *
 * A key that IS present in several sources with **different non-list values** is a genuine conflict. It
 * is resolved by the first source that mentions it, and reported in the notes, rather than by whichever
 * source was read last — a merge whose result depends on read order cannot be reasoned about, and the
 * operator would have no way to tell it had happened.
 */
function unionDocuments(
	sources: MergeSource[],
	naming?: NameFromSource,
): { ok: boolean; content: string; notes: string[]; problem?: string } {
	const notes: string[] = [];
	// mergeText has already applied the configured order and stable fallback ordering.
	const perKey = new Map<string, Map<string, unknown>>();
	let rewritten = 0;
	let rawEntries = 0;
	const scalars = new Map<string, { value: unknown; from: string }>();
	const subRules = new Map<string, unknown>();
	const conflicts: string[] = [];

	for (const src of sources) {
		let parsed: unknown;
		try {
			parsed = parseYaml(src.content);
		} catch (err) {
			return {
				ok: false,
				content: '',
				notes,
				problem: `${src.path} could not be parsed as a document (${(err as Error).message}), so the previous result is kept rather than replaced with a partial one`,
			};
		}

		if (parsed === null || parsed === undefined) return { ok: false, content: '', notes, problem: `${src.path} parsed as an empty document; the previous result is kept` };
		if (typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {
				ok: false,
				content: '',
				notes,
				problem: `${src.path} is not a mapping of keys to lists, which this combination requires`,
			};
		}

		const sourceEntries = Object.values(parsed).reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
		rawEntries += sourceEntries;
		notes.push(`${src.hostId ? `${src.hostId}:` : ''}${src.path}: ${sourceEntries} list entries`);
		if (naming) {
			const named = nameDocument(parsed as Record<string, unknown>, src, sources, naming);
			parsed = named.document;
			rewritten += named.rewritten;
		}
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (key === 'sub-rules') {
				if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${src.path} has invalid sub-rules`);
				for (const [name, rules] of Object.entries(value)) {
					if (!Array.isArray(rules)) throw new Error(`${src.path} sub-rule ${name} must be a rule list`);
					if (subRules.has(name) && canonicalForm(subRules.get(name)) !== canonicalForm(rules)) throw new Error(`conflicting sub-rule definitions for ${name}; the previous result is kept`);
					subRules.set(name, rules);
				}
				continue;
			}
			if (Array.isArray(value)) {
				const bucket = perKey.get(key) ?? new Map<string, unknown>();
				for (const entry of value) {
					const canonical = canonicalForm(entry);
					if (!bucket.has(canonical)) {
						bucket.set(canonical, entry);
					}
				}
				perKey.set(key, bucket);
				continue;
			}

			// A non-list value. The first source that mentions this key contributes it, even when that is
			// not the first source overall: a key only some sources set must not be lost.
			const existing = scalars.get(key);
			if (!existing) {
				scalars.set(key, { value, from: src.path });
			} else if (canonicalForm(existing.value) !== canonicalForm(value)) {
				conflicts.push(`${key} (kept ${existing.from}, ignored ${src.path})`);
			}
		}
	}

	if (conflicts.length > 0) {
		notes.push(`conflicting non-list keys resolved by source order: ${conflicts.join('; ')}`);
	}

	const out: Record<string, unknown> = Object.create(null);
	// Sorted so the output does not depend on which source happened to mention a key first.
	for (const [key, entry] of [...scalars.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		out[key] = entry.value;
	}
	for (const [key, bucket] of [...perKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		// Routing rules are priority ordered: canonical sorting can move MATCH ahead of a specific rule.
		// Source ordering already makes insertion order deterministic. Other lists keep canonical ordering.
		const entries = (key === 'rules' ? [...bucket.entries()] : [...bucket.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).map(([, value]) => value);
		out[key] = key === 'rules' ? mergeRoutingRules(entries, notes) : entries;
	}
	if (subRules.size) out['sub-rules'] = Object.fromEntries([...subRules.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

	const uniqueEntries = [...perKey.values()].reduce((total, entries) => total + entries.size, 0);
	notes.push(`${rawEntries - uniqueEntries} duplicate list entries removed; ${uniqueEntries} retained`);
	if (naming && rewritten > 0) notes.push(`renamed ${rewritten} entries in ${naming.field} after their source`);
	if (naming?.field === 'name' && naming.keys.some(key => key === 'proxy-groups' || key === 'proxies')) {
		const problem = proxyReferenceProblem(out);
		if (problem) return { ok: false, content: '', notes, problem: `${problem}; the previous result is kept` };
	}

	// Wrapped, because canonicalising a document can overflow the stack rather than fail politely: a recursive
	// YAML anchor produces a structure with a cycle in it, and an adversarial audit showed `mergeText` THROWING
	// `RangeError: Maximum call stack size exceeded` — the only path in this module that raised instead of
	// returning a refusal. A source that cannot be used has to come back as a stated problem, so the caller can
	// keep the previous derived object rather than losing the message in a crash.
	let content: string;
	try {
		content = stringifyYaml(out, { lineWidth: 0 });
	} catch (err) {
		return {
			ok: false,
			content: '',
			notes,
			problem: `the merged document could not be serialised (${(err as Error).message}), so the previous result is kept`,
		};
	}
	// Parsing the output is the check, not reading it. A merge that produces something the parser cannot
	// read is broken regardless of how it looks.
	try {
		parseYaml(content);
	} catch (err) {
		return { ok: false, content: '', notes, problem: `the merged document does not re-parse (${(err as Error).message})` };
	}

	return { ok: true, content, notes };
}

/**
 * A stable text form for comparison: keys sorted, so formatting differences do not create duplicates.
 *
 * **Type-tagged rather than plain `JSON.stringify`, and that is a fix from an adversarial audit.** Plain JSON
 * is lossy in ways that make two genuinely different entries compare equal: `NaN` and `Infinity` both serialise
 * to `null`, so an entry with `name: .nan` collided with one with no name at all and the second was dropped
 * with **no note** — silent data loss, which is the worst way for this module to be wrong. A `Set` and a `Map`
 * both serialise to `{}`, so any two of them collided.
 *
 * Tagging costs nothing and makes the comparison injective for the values a configuration file can contain.
 */
function canonicalForm(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

/**
 * Sorts keys so two structurally equal values compare equal.
 *
 * Bounded, and the bound is a fix rather than caution. A recursive YAML anchor — `&a [*a]` — decodes to a
 * structure that contains itself, so an unbounded walk never terminates; an adversarial audit showed the whole
 * merge THROWING `RangeError: Maximum call stack size exceeded` instead of refusing. That was the only path in
 * this module that raised rather than returning a stated problem, and a caller cannot keep a previous good
 * result when it never gets an answer.
 *
 * The limit is far above any real configuration and far below the stack, so exceeding it means the document is
 * cyclic or absurd rather than merely large.
 */
const MAX_DEPTH = 200;

function sortDeep(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) {
		throw new Error('the document nests deeper than this can compare, which usually means a recursive reference');
	}
	// Tag EVERY value, not only special numbers: user mappings cannot impersonate a generated tag.
	// Key/value pairs also preserve __proto__ as ordinary data without invoking a prototype setter.
	if (value === null) return ['null'];
	if (Array.isArray(value)) return ['array', value.map((item) => sortDeep(item, depth + 1))];
	if (value instanceof Date) return ['date', value.toISOString()];
	const compare = (a: unknown, b: unknown) => { const aa = JSON.stringify(a); const bb = JSON.stringify(b); return aa < bb ? -1 : aa > bb ? 1 : 0; };
	if (value instanceof Set) return ['set', [...value].map(item => sortDeep(item, depth + 1)).sort(compare)];
	if (value instanceof Map) return ['map', [...value].map(([key, entry]) => [sortDeep(key, depth + 1), sortDeep(entry, depth + 1)]).sort(compare)];
	if (value && typeof value === 'object') {
		return ['object', Object.keys(value).sort().map(key => [key, sortDeep((value as Record<string, unknown>)[key], depth + 1)])];
	}
	return [typeof value, typeof value === 'number' && Object.is(value, -0) ? '-0' : String(value)];
}

/**
 * What a merge would produce, before anything is stored.
 *
 * Carries no content on purpose: a preview that could be mistaken for a result is a hazard, and the
 * operator is being asked "is this what you meant", not handed the file.
 */
export function previewMerge(rule: MergeRule, sources: MergeSource[], options: { expectedPaths?: string[] } = {}): MergePreview {
	const merged = mergeText(rule, sources, options);
	return {
		ok: merged.ok,
		outputName: rule.outputName,
		sourceCount: merged.sourceCount,
		sourceBytes: merged.sourceBytes,
		bytes: merged.bytes,
		notes: merged.notes,
		problem: merged.problem,
	};
}

export interface MergeRuleRef {
	outputName: string;
	/** What this rule uses: collected paths, or the output names of other rules. */
	uses: string[];
}

/**
 * Finds a dependency cycle among merge rules, or null when there is none.
 *
 * Checked when a rule is **defined**, not when it runs: a cycle discovered at run time is discovered
 * after the work has been done, and "this merge never terminates" is not a useful thing to learn from a
 * timeout.
 *
 * Returns the path of the cycle so the message can name the rules involved rather than just asserting
 * that one exists.
 */
export function detectCycle(rules: MergeRuleRef[]): string[] | null {
	const uses = new Map(rules.map((rule) => [rule.outputName, rule.uses]));
	const state = new Map<string, 'visiting' | 'done'>();

	const walk = (name: string, path: string[]): string[] | null => {
		const status = state.get(name);
		if (status === 'done') return null;
		if (status === 'visiting') return [...path.slice(path.indexOf(name)), name];

		state.set(name, 'visiting');
		for (const dependency of uses.get(name) ?? []) {
			// Only rules can form a cycle; a collected file is a leaf.
			if (!uses.has(dependency)) continue;
			const found = walk(dependency, [...path, name]);
			if (found) return found;
		}
		state.set(name, 'done');
		return null;
	};

	for (const rule of rules) {
		const found = walk(rule.outputName, []);
		if (found) return found;
	}
	return null;
}
