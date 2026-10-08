/**
 * Merge rules, and running them: the wiring between the pure engine in `merge.ts` and stored objects.
 *
 * `merge.ts` deliberately knows nothing about the database, the bucket or the machine — it takes sources and a
 * rule and returns bytes or a refusal. This module is the other half: it decides *which* stored objects a rule
 * takes, records the rule, decides whether an existing result is still current, and (given a bucket) writes the
 * result.
 *
 * The database-touching half takes its reads as arguments rather than a `D1Database`, following the same
 * pattern as `budget.ts`: the decision is then testable against a plain array, and the only thing an
 * integration test has to prove is that the query returns what the decision expects.
 */

import { createHash } from 'node:crypto';
import { detectCycle, mergeText, previewMerge, nameFromSourceProblem } from './merge';
import type { MergePreview, MergeResult, MergeRule, MergeRuleRef, MergeSource, NameFromSource } from './merge';
import { globToRegExp } from './remote';

/**
 * One source specification: which stored files this rule takes.
 *
 * Patterns use the collection vocabulary rather than a second one, because "which files" should have one
 * description in this product. `*` matches within a path segment and `?` matches one character, exactly as
 * `globToRegExp` implements for collection rules — reusing that function is what keeps the two vocabularies
 * identical rather than merely similar.
 *
 * `hostId` narrows a pattern to one machine. It is optional and, when absent, the pattern applies to every
 * machine — which is the case the product exists for: the same path on several machines merged into one file.
 */
export interface MergeSourceSpec {
	pattern: string;
	hostId?: string;
}

/** A rule as the operator defines it. `id` and timestamps are storage concerns and are not part of this. */
export interface DerivedRuleDefinition {
	outputName: string;
	combination: MergeRule['combination'];
	sources: MergeSourceSpec[];
	/** An explicit order, by stored path. Unmentioned sources sort after these rather than being dropped. */
	order?: string[];
	nameFromSource?: NameFromSource;
}

export interface DerivedRuleRecord extends DerivedRuleDefinition {
	id: string;
	signature: string;
	createdAt: string;
	updatedAt: string;
}

/** A stored object, as far as source selection cares. Matches the columns `objects` actually has. */
export interface StoredObject {
	id: number;
	hostId: string;
	path: string;
	objectKey: string;
	sizeBytes: number;
	contentHash: string;
}

/** Thrown with a message meant for the operator. */
export class DerivedRuleProblem extends Error {}

const MAX_OUTPUT_NAME = 200;

/**
 * Checks a rule as it is being defined, because the alternative is finding out when it runs.
 *
 * Every check here is one the ticket names as needing to be refused **at definition time**: a cycle discovered
 * at run time is discovered after the work has been done, and "this merge never terminates" is not a useful
 * thing to learn from a timeout.
 */
export function ruleDefinitionProblem(
	definition: DerivedRuleDefinition,
	existing: MergeRuleRef[],
): string | null {
	const name = (definition.outputName ?? '').trim();
	if (!name) return 'the output name is required';
	if (name.length > MAX_OUTPUT_NAME) return `the output name must be at most ${MAX_OUTPUT_NAME} characters`;
	if (name.startsWith('/')) return 'the output name is what the result is called, not a path; a leading slash is not needed';

	if (definition.combination !== 'concat' && definition.combination !== 'yaml-list-union' && definition.combination !== 'proxy-profile') {
		return `"${String(definition.combination)}" is not a combination this can perform`;
	}

	if (!Array.isArray(definition.sources) || definition.sources.length === 0) {
		return 'at least one source pattern is required; a merge of nothing produces nothing';
	}
	for (const spec of definition.sources) {
		if (!spec || typeof spec.pattern !== 'string' || spec.pattern.trim().length === 0) {
			return 'every source needs a pattern';
		}
		if (spec.hostId !== undefined && (typeof spec.hostId !== 'string' || !spec.hostId.trim())) return 'each source hostId must be a non-empty string';
	}
	if (definition.order !== undefined && (!Array.isArray(definition.order) || !definition.order.every(path => typeof path === 'string' && path.trim()))) return 'source order must be a list of non-empty paths';
	if (definition.nameFromSource !== undefined) {
    if (definition.combination === 'proxy-profile') return 'the merged-all profile defines its own node and group names; nameFromSource is not used';
		const problem = nameFromSourceProblem(definition.nameFromSource);
		if (problem) return problem;
	}

	// The cycle check runs over the rules that would exist once this one is added, so a rule whose sources are
	// its own output names is refused here rather than becoming an infinite rebuild later.
	const refs: MergeRuleRef[] = [
		...existing.filter((rule) => rule.outputName !== name),
		{ outputName: name, uses: definition.sources.filter(spec => spec.hostId === undefined || spec.hostId === '@derived').map(spec => spec.pattern) },
	];
	// Match dependencies with the same paths/globs as source selection, plus legacy bare names.
    const cycle = detectCycle(refs.map(rule => ({ outputName: rule.outputName,
        uses: refs.filter(target => rule.uses.some(pattern => {
            const regex = globToRegExp(pattern);
            return regex.test(`/${target.outputName}`) || regex.test(target.outputName);
        })).map(target => target.outputName),
    })));
	if (cycle) {
		return `this would make a cycle: ${cycle.join(' → ')}; a merge cannot take itself as a source, directly or through another merge`;
	}

	return null;
}

/** The engine's rule, derived from the stored definition. */
export function engineRule(definition: DerivedRuleDefinition): MergeRule {
	const rule: MergeRule = { outputName: definition.outputName, combination: definition.combination };
	if (definition.order) rule.order = definition.order;
	if (definition.nameFromSource) rule.nameFromSource = definition.nameFromSource;
	return rule;
}

/** True when a stored path matches a source specification. */
export function specMatches(spec: MergeSourceSpec, object: StoredObject): boolean {
	if (spec.hostId !== undefined && spec.hostId !== object.hostId) return false;
	return globToRegExp(spec.pattern).test(object.path);
}

/** Every saved source pattern is required. A zero-match pattern cannot silently shorten a good output. */
function missingSourceProblem(definition: DerivedRuleDefinition, selected: StoredObject[]): string | null {
	if (selected.length === 0) return null; // Preserve the existing explanatory empty-selection response.
	const missing = definition.sources.filter(spec => !selected.some(object => specMatches(spec, object)));
	return missing.length ? `these source patterns matched nothing: ${missing.map(spec => `${spec.hostId ? `${spec.hostId}:` : ''}${spec.pattern}`).join(', ')}; the previous result is kept` : null;
}

/**
 * The stored objects a rule takes, in a deterministic order.
 *
 * Reads are passed in rather than performed here so the selection is testable without a database. Objects
 * already known to be derived are excluded by the caller through `excludeIds`, and that exclusion is what
 * stops a rule consuming its own output even if the cycle check were somehow bypassed.
 *
 * Determinism comes from sorting by host then path. Without the host in the key, two machines holding the same
 * path would order by whichever row the database returned first, and the same rule would produce different
 * bytes on different runs — the failure the engine's own ordering guarantees cannot see, because by the time
 * the engine sorts, the two sources have the same path and identical content-looking keys.
 */
export function planMergeSources(
	definition: DerivedRuleDefinition,
	objects: StoredObject[],
	excludeIds: ReadonlySet<number> = new Set(),
): StoredObject[] {
	const chosen = new Map<number, StoredObject>();
	for (const spec of definition.sources) {
		for (const object of objects) {
			if (excludeIds.has(object.id)) continue;
			if (!specMatches(spec, object)) continue;
			chosen.set(object.id, object);
		}
	}

	return [...chosen.values()].sort((a, b) => {
		if (a.hostId !== b.hostId) return a.hostId < b.hostId ? -1 : 1;
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		return a.id - b.id;
	});
}

/**
 * The signature of a rule **and** the sources it was built from.
 *
 * This is what makes "is this derived object current" decidable rather than guessed, and it covers every way a
 * derived object can go stale:
 *
 *   - the rule's own definition changes, because the definition is hashed in;
 *   - a source's content changes, because each source's content hash is hashed in;
 *   - a source appears or disappears, because the LIST of sources is hashed in — and the list is built from
 *     the selection, so a file that stops matching changes it.
 *
 * Host and path are included alongside each hash, so two sources that happen to hold identical bytes still
 * contribute distinct entries and swapping them is not silently equivalent.
 *
 * `\u0000` separators and a length prefix per part: without them, `["ab","c"]` and `["a","bc"]` would hash the
 * same, which would make two different source sets look identical.
 */
export function mergeSignature(definition: DerivedRuleDefinition, sources: StoredObject[]): string {
	const hash = createHash('sha256');
	const part = (text: string): void => {
		hash.update(String(new TextEncoder().encode(text).length));
		hash.update('\u0000');
		hash.update(text);
		hash.update('\u0000');
	};

	// Version the transform contract too: unchanged inputs must rebuild after a correctness repair.
	part('linkbin-derived-v2');
	part(definition.outputName);
	part(definition.combination);
	part(JSON.stringify(definition.nameFromSource ?? null));
	for (const spec of definition.sources) part(`${spec.hostId ?? '*'}\u0001${spec.pattern}`);
	// The order is part of the definition, so it is hashed as given rather than sorted: reordering the sources
	// changes the output for `concat` and for a conflicting scalar, so it must change the signature too.
	for (const path of definition.order ?? []) part(`order:${path}`);

	for (const source of sources) part(`${source.hostId}\u0001${source.path}\u0001${source.contentHash}`);

	return hash.digest('hex');
}

/** The engine's sources, from stored objects and their bytes. */
export function engineSources(
	objects: StoredObject[],
	contents: Map<number, string>,
): MergeSource[] {
	return objects.map((object) => ({
		path: object.path,
		hostId: object.hostId,
		content: contents.get(object.id) ?? '',
		// Passed through so the engine's own provenance reporting can attribute an entry to a source without
		// re-hashing the bytes it was given.
		hash: object.contentHash,
	}));
}

/** What a preview reports before anything is stored. */
export interface DerivedPreview {
	ok: boolean;
	outputName: string;
	sourceCount: number;
	sourceBytes: number;
	/** Estimated output size. Exact for a concatenation, and known after building for a structured merge. */
	bytes?: number;
	notes: string[];
	problem?: string;
	/** The paths that would be combined, so a rule selecting nothing is visible as such. */
	sources: string[];
	/** One entry per source pattern, saying how many stored objects it matched. */
	perPattern: { pattern: string; hostId?: string; matched: number }[];
}

/**
 * What the rule would take and produce, computed without storing anything.
 *
 * `perPattern` exists because a structured merge that removed no duplicates and a structured merge that did
 * nothing at all look identical in the output, and the operator needs to tell them apart. A pattern matching
 * zero stored objects is the usual cause.
 */
export function previewDerived(
	definition: DerivedRuleDefinition,
	selected: StoredObject[],
	contents: Map<number, string>,
): DerivedPreview {
	const perPattern = definition.sources.map((spec) => ({
		pattern: spec.pattern,
		...(spec.hostId === undefined ? {} : { hostId: spec.hostId }),
		matched: selected.filter((object) => specMatches(spec, object)).length,
	}));

	const paths = selected.map((object) => `${object.hostId}:${object.path}`);
	// The SIZE OF THE STORED FILES, summed from their recorded sizes — not `preview.sourceBytes` below.
	//
	// Those two numbers are different and the difference cost a confusing failure. `mergeText` reports
	// `sourceBytes` as the bytes of content it actually READ, which for two short files is far smaller than
	// what is stored, and it excludes a source whose bytes were read but which was empty. A preview is shown
	// before anything is read, and what it answers is "how much will this pull in", so it must come from the
	// objects rather than from the engine.
	const sourceBytes = selected.reduce((total, object) => total + object.sizeBytes, 0);
	const missing = missingSourceProblem(definition, selected);
	if (missing) return { ok: false, outputName: definition.outputName, sourceCount: selected.length, sourceBytes, notes: [], problem: missing, sources: paths, perPattern };

	if (selected.length === 0) {
		return {
			ok: false,
			outputName: definition.outputName,
			sourceCount: 0,
			sourceBytes: 0,
			notes: [],
			problem: 'no stored file matches this rule, so there is nothing to combine',
			sources: paths,
			perPattern,
		};
	}

	const preview: MergePreview = previewMerge(
		engineRule(definition),
		engineSources(selected, contents),
		{ expectedPaths: definition.order },
	);

	return {
		ok: preview.ok,
		outputName: definition.outputName,
		sourceCount: preview.sourceCount,
		// Deliberately the stored sizes, NOT `preview.sourceBytes`: see above. The engine's figure is what it
		// read, which is a different question and smaller.
		sourceBytes,
		...(preview.bytes === undefined ? {} : { bytes: preview.bytes }),
		notes: preview.notes,
		...(preview.problem === undefined ? {} : { problem: preview.problem }),
		sources: paths,
		perPattern,
	};
}

/** What a run produced, whether or not it stored anything. */
export interface DerivedRunOutcome {
	ok: boolean;
	outputName: string;
	sourceCount: number;
	sourceBytes: number;
	signature: string;
	notes: string[];
	problem?: string;
	/** Absent on failure: a failed merge must have nothing to store, and a previous result stays in place. */
	content?: string;
}

/**
 * Runs the merge, and **returns the bytes rather than storing them**.
 *
 * The split is deliberate. Storing needs a bucket and a database write, and a test of "does a failed re-run
 * leave the previous result alone" is about the decision, not the storage — so the decision is a pure function
 * of the rule, the sources and their contents, and the caller does the writing only when this says `ok`.
 *
 * `ok: false` never carries content, which is what makes "leave the previous result in place" enforceable at
 * the call site instead of a convention someone has to remember.
 */
export function runDerived(
	definition: DerivedRuleDefinition,
	selected: StoredObject[],
	contents: Map<number, string>,
): DerivedRunOutcome {
	const signature = mergeSignature(definition, selected);
	const missing = missingSourceProblem(definition, selected);
	if (missing) return { ok: false, outputName: definition.outputName, sourceCount: selected.length, sourceBytes: selected.reduce((total, object) => total + object.sizeBytes, 0), signature, notes: [], problem: missing };

	if (selected.length === 0) {
		return {
			ok: false,
			outputName: definition.outputName,
			sourceCount: 0,
			sourceBytes: 0,
			signature,
			notes: [],
			problem: 'no stored file matches this rule, so nothing was produced and any previous result is left in place',
		};
	}

	const result: MergeResult = mergeText(engineRule(definition), engineSources(selected, contents), {
		expectedPaths: definition.order,
	});

	if (!result.ok || result.content === undefined) {
		return {
			ok: false,
			outputName: definition.outputName,
			sourceCount: result.sourceCount,
			sourceBytes: result.sourceBytes,
			signature,
			notes: result.notes,
			problem: result.problem ?? 'the merge produced nothing',
		};
	}

	return {
		ok: true,
		outputName: definition.outputName,
		sourceCount: result.sourceCount,
		sourceBytes: result.sourceBytes,
		signature,
		notes: result.notes,
		content: result.content,
	};
}

/** Parses a stored rule, refusing rather than producing a half-usable definition. */
export function parseStoredRule(row: { id: string; rule_json: string; signature: string; created_at: string; updated_at: string }): DerivedRuleRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.rule_json);
	} catch {
		throw new DerivedRuleProblem(`rule ${row.id} is stored as text that is not valid JSON, so it cannot be used`);
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DerivedRuleProblem(`rule ${row.id} must contain a definition object`);
	const definition = parsed as DerivedRuleDefinition;
	if (typeof definition.outputName !== 'string') throw new DerivedRuleProblem(`rule ${row.id} must contain an output name`);
	const problem = ruleDefinitionProblem(definition, []);
	if (problem) throw new DerivedRuleProblem(`rule ${row.id}: ${problem}`);
	return {
		id: row.id,
		outputName: String(definition.outputName ?? ''),
		combination: definition.combination,
		sources: Array.isArray(definition.sources) ? definition.sources : [],
		...(definition.order === undefined ? {} : { order: definition.order }),
		...(definition.nameFromSource === undefined ? {} : { nameFromSource: definition.nameFromSource }),
		signature: row.signature,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
