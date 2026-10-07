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
	const byPath = (a: MergeSource, b: MergeSource): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const sorted = [...sources].sort(byPath);

	if (!explicitOrder || explicitOrder.length === 0) return sorted;

	const rank = new Map(explicitOrder.map((path, index) => [path, index]));
	return sorted.sort((a, b) => {
		const ra = rank.get(a.path);
		const rb = rank.get(b.path);
		if (ra !== undefined && rb !== undefined) return ra - rb;
		if (ra !== undefined) return -1;
		if (rb !== undefined) return 1;
		return byPath(a, b);
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
	const ordered = orderSources(sources);

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
	if (empty.length > 0) notes.push(`${empty.length} source(s) were empty: ${empty.map((s) => s.path).join(', ')}`);

	if (empty.length === normalized.length) {
		return {
			ok: false,
			sourceCount: normalized.length,
			sourceBytes,
			notes,
			problem: 'every source was empty, so the previous result is kept rather than replaced with nothing',
		};
	}

	const usable = normalized.filter((s) => s.content.trim().length > 0);

	let content: string;
	if (rule.combination === 'yaml-list-union') {
		const structured = unionDocuments(usable, rule.nameFromSource);
		if (!structured.ok) {
			return { ok: false, sourceCount: normalized.length, sourceBytes, notes, problem: structured.problem };
		}
		notes.push(...structured.notes);
		content = structured.content;
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
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.(ya?ml|json|txt|conf|cfg)$/i, '');
}

/**
 * Rewrites a field on each entry using the source it came from.
 *
 * Applied after the union, because it needs to know which source each surviving entry came from — and that
 * is only known once duplicates have been removed.
 *
 * An entry whose source is unknown is left alone rather than given a name built from nothing: a field that
 * says `undefined 负载均衡` is worse than one that says `负载均衡`, because it looks deliberate.
 */
export function applyNameFromSource(
	out: Record<string, unknown>,
	provenance: Map<string, string>,
	rule: NameFromSource,
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
			const record = { ...(entry as Record<string, unknown>) };

			// An entry whose source cannot be determined is left alone. Naming it from nothing would produce a
			// field that looks deliberate and says nothing true.
			const source = provenance.get(canonicalForm(entry));
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
			const sourcePart = sourceName(source);
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

/**
 * Unions list-valued top-level keys across documents, removing duplicates.
 *
 * The comparison is **structural, not textual**: two entries that differ only in key order, quoting or
 * indentation are the same entry, and comparing their text would keep both. Canonical JSON is used as
 * the comparison form because it sorts keys, which makes it stable across sources authored differently.
 *
 * Ordering is deterministic and independent of source order: entries are sorted by their canonical form.
 * That means a new entry appended to one source lands in a predictable place rather than wherever that
 * source happened to be read.
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
	// Sources are visited in the order given, which `mergeText` has already made deterministic, so "the
	// first source that mentions this key" is itself deterministic.
	const perKey = new Map<string, Map<string, unknown>>();
	/**
	 * Which source each surviving entry came from, keyed by its canonical form.
	 *
	 * Kept because naming an entry after its source is only possible if the link between them survives the
	 * union — and after duplicates are removed, the link is no longer derivable from the entry itself.
	 */
	const provenance = new Map<string, string>();
	const scalars = new Map<string, { value: unknown; from: string }>();
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

		if (parsed === null || parsed === undefined) {
			notes.push(`${src.path} parsed as an empty document`);
			continue;
		}
		if (typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {
				ok: false,
				content: '',
				notes,
				problem: `${src.path} is not a mapping of keys to lists, which this combination requires`,
			};
		}

		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (Array.isArray(value)) {
				const bucket = perKey.get(key) ?? new Map<string, unknown>();
				for (const entry of value) {
					const canonical = canonicalForm(entry);
					if (!bucket.has(canonical)) {
						bucket.set(canonical, entry);
						// Recorded on the entry that SURVIVES. A duplicate from a later source does not overwrite
						// this, so the name reflects the source that actually contributed the entry — which is the
						// one a reader would expect to see.
						provenance.set(canonical, src.path);
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

	const out: Record<string, unknown> = {};
	// Sorted so the output does not depend on which source happened to mention a key first.
	for (const [key, entry] of [...scalars.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		out[key] = entry.value;
	}
	for (const [key, bucket] of [...perKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const entries = [...bucket.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
		out[key] = entries;
	}

	// After the union, because naming needs to know which source each surviving entry came from.
	if (naming) {
		const before = countNames(out, naming.field);
		const { rewritten } = applyNameFromSource(out, provenance, naming);
		const after = distinctNames(out, naming.field);

		if (rewritten > 0) {
			notes.push(`renamed ${rewritten} entries in ${naming.field} after their source (${after} distinct names)`);
		}
		if (rewritten > after) {
			// Said out loud, because colliding names are the thing this operator exists to remove, and a partial
			// fix looks exactly like a complete one.
			notes.push(`${rewritten - after} entries still share a name, so the naming rule does not distinguish them fully`);
		}
		if (before !== rewritten) {
			// Entries that carry the field but were not renamed — which means their source is unknown. Silence
			// here would hide half a job.
			notes.push(`${before - rewritten} entries carry ${naming.field} but were not renamed`);
		}
	}

	const content = stringifyYaml(out, { lineWidth: 0 });
	// Parsing the output is the check, not reading it. A merge that produces something the parser cannot
	// read is broken regardless of how it looks.
	try {
		parseYaml(content);
	} catch (err) {
		return { ok: false, content: '', notes, problem: `the merged document does not re-parse (${(err as Error).message})` };
	}

	return { ok: true, content, notes };
}

/** How many list entries carry a value in a given field at all. */
function countNames(out: Record<string, unknown>, field: string): number {
	let count = 0;
	for (const value of Object.values(out)) {
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (entry && typeof entry === 'object' && (entry as Record<string, unknown>)[field] !== undefined) count++;
		}
	}
	return count;
}

/** How many distinct values a field has across all list entries. */
function distinctNames(out: Record<string, unknown>, field: string): number {
	const seen = new Set<string>();
	for (const value of Object.values(out)) {
		if (!Array.isArray(value)) continue;
		for (const entry of value) {
			if (entry && typeof entry === 'object') {
				const name = (entry as Record<string, unknown>)[field];
				if (name !== undefined) seen.add(String(name));
			}
		}
	}
	return seen.size;
}

/** A stable text form for comparison: keys sorted, so formatting differences do not create duplicates. */
function canonicalForm(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortDeep((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
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
